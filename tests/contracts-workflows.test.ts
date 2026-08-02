import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { loadChecksums, loadManifest } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const required = [
  'maestro/runbooks/cowork-discovery.md',
  'maestro/runbooks/cowork-audit.md',
  '.claude/commands/build.md',
  '.claude/commands/status.md',
  '.claude/commands/wiki.md',
  '.claude/commands/handoff.md',
  '.claude/agents/code-reviewer.md',
] as const;

async function fresh(): Promise<string> {
  const target = await makeTempDir('contracts-');
  const result = await initProject({ target, name: 'Contracts', startingPoint: 'idea', git: false, now: FIXED_NOW });
  expect(result.ok).toBe(true);
  return target;
}

async function audit(target: string, name: string, body: string): Promise<ReturnType<typeof doctorProject>> {
  await mkdir(join(target, 'wiki/audits'), { recursive: true });
  await writeFile(join(target, 'wiki/audits', name), body, 'utf8');
  return doctorProject(target);
}

const validAudit = (auditStatus: 'open' | 'resolved' | 'waived', findingStatus: 'open' | 'resolved' | 'waived', severity = 'medium') => `---
type: audit
title: Security audit
audit_id: AUD-2026-001
status: ${auditStatus}
---
# Audit

## Finding AUD-2026-001-F001
- severity: ${severity}
- target: src/auth.ts
- status: ${findingStatus}
- resolution: ${findingStatus === 'open' ? 'pending' : 'fixed or explicitly accepted'}
`;

afterEach(cleanupTempDirs);

describe('этапы 8–10: contracts/workflows', () => {
  it('устанавливает workflow/runbook-файлы как trusted managed с checksums', async () => {
    const target = await fresh();
    const manifest = await loadManifest(target);
    const checksums = await loadChecksums(target);
    for (const path of required) {
      expect(await readFile(join(target, path), 'utf8')).not.toBe('');
      expect(manifest.managed).toContainEqual({ path, kind: 'managed' });
      expect(checksums?.files[path]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect((await doctorProject(target)).ok).toBe(true);
  });

  it('discovery — копируемый prompt с обязательными секциями и запретом писать код', async () => {
    const target = await fresh();
    const text = (await readFile(join(target, required[0]), 'utf8')).toLowerCase();
    for (const section of ['sources', 'assumptions', 'mvp', 'non-goals', 'open questions']) expect(text).toContain(section);
    expect(text).toMatch(/cowork[^\n]*(?:не (?:пишет|должен писать) код|never writes code)/i);
    expect(text).toMatch(/скопиру|copy/i);
    expect(text).not.toMatch(/\/cowork|slash command/i);
  });

  it('discovery — content-owned документ: его заполнение не считается повреждением managed-файла', async () => {
    const target = await fresh();
    const path = 'wiki/concepts/discovery.md';
    await writeFile(join(target, path), '---\ntype: concept\ntitle: Discovery\nupdated: 2026-08-02\n---\n# Discovery\n\n## Sources\n- input\n', 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((finding) => finding.code === 'managed-modified' && finding.path === path)).toBe(false);
    const manifest = await loadManifest(target);
    expect(manifest.managed).toContainEqual({ path, kind: 'generated' });
  });

  it('AGENTS/CLAUDE задают ownership, чтение hot/discovery/open audits и команды', async () => {
    const target = await fresh();
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      const text = await readFile(join(target, path), 'utf8');
      expect(text).toContain('wiki/hot.md');
      expect(text).toContain('wiki/concepts/discovery.md');
      expect(text).toContain('wiki/audits');
      expect(text.toLowerCase()).toContain('ownership');
      for (const command of ['build', 'status', 'wiki', 'handoff']) expect(text).toContain(command);
    }
  });

  it('фиксирует непересекающуюся матрицу ownership во всех workflow', async () => {
    const target = await fresh();
    for (const path of ['AGENTS.md', 'CLAUDE.md']) {
      const text = (await readFile(join(target, path), 'utf8')).toLowerCase();
      expect(text).toContain('cowork');
      expect(text).toContain('wiki/concepts/discovery.md');
      expect(text).toContain('wiki/audits/');
      expect(text).toMatch(/claude code[^\n]*wiki\/progress/);
      expect(text).toMatch(/claude code[^\n]*wiki\/decisions/);
      expect(text).toMatch(/hot\.md[^\n]*только[^\n]*handoff/);
      expect(text).toMatch(/log\.md[^\n]*append-only/);
    }
    const wiki = (await readFile(join(target, '.claude/commands/wiki.md'), 'utf8')).toLowerCase();
    expect(wiki).toContain('wiki/progress/');
    expect(wiki).toContain('wiki/decisions/');
    expect(wiki).toContain('append-only');
    expect(wiki).not.toMatch(/обновляй[^\n]*hot/);
    expect(wiki).not.toMatch(/редактируй[^\n]*(discovery|audits)/);
    const handoff = (await readFile(join(target, '.claude/commands/handoff.md'), 'utf8')).toLowerCase();
    expect(handoff).toMatch(/единственн[^\n]*команд[^\n]*hot\.md/);
    for (const runbook of ['cowork-discovery.md', 'cowork-audit.md']) {
      const text = (await readFile(join(target, 'maestro/runbooks', runbook), 'utf8')).toLowerCase();
      expect(text).toContain('не изменяет файлы проекта');
      expect(text).toContain('человек');
      expect(text).toContain('diff');
    }
  });

  it('doctor отвергает malformed audit frontmatter и findings', async () => {
    const target = await fresh();
    const report = await audit(target, 'bad.md', `---\ntype: audit\ntitle: Bad\nstatus: invalid\n---\n## Finding duplicate\n- severity: urgent\n`);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'audit-malformed' && f.path === 'wiki/audits/bad.md')).toBe(true);
  });

  it.each(['critical', 'high'])('doctor блокирует open %s finding', async (severity) => {
    const target = await fresh();
    const report = await audit(target, `${severity}.md`, validAudit('open', 'open', severity));
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'audit-blocking-finding')).toBe(true);
  });

  it('doctor отвергает audit без findings и top-level resolved с open finding', async () => {
    const target = await fresh();
    const empty = await audit(target, 'empty.md', '---\ntype: audit\ntitle: Empty\naudit_id: AUD-EMPTY\nstatus: open\n---\n# Audit\n');
    expect(empty.findings.some((f) => f.code === 'audit-malformed')).toBe(true);
    const inconsistent = await audit(target, 'inconsistent.md', validAudit('resolved', 'open', 'medium'));
    expect(inconsistent.findings.some((f) => f.code === 'audit-malformed' && f.path === 'wiki/audits/inconsistent.md')).toBe(true);
  });

  it('doctor отвергает повторяющиеся поля и пустую resolution', async () => {
    const target = await fresh();
    const body = validAudit('open', 'open', 'medium')
      .replace('- target: src/auth.ts', '- target: src/auth.ts\n- target: src/other.ts')
      .replace('- resolution: pending', '- resolution:   ');
    const report = await audit(target, 'duplicates.md', body);
    expect(report.findings.some((f) => f.code === 'audit-malformed')).toBe(true);
  });

  it.each(['resolved', 'waived'] as const)('doctor пропускает %s critical finding', async (status) => {
    const target = await fresh();
    const report = await audit(target, `${status}.md`, validAudit(status, status, 'critical'));
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
