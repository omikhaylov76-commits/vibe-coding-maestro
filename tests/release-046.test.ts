import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { sha256 } from '../src/core/manifest.js';
import { planBodyDigest } from '../src/core/plan.js';
import { buildPreflight } from '../src/core/preflight.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';
import { collectIo } from './published.js';

afterEach(cleanupTempDirs);
// Тесты не зависят от сессии Claude Code, в которой их запустили.
delete process.env.CLAUDE_CODE_SESSION_ID;

async function newProject(prefix = 'r046-'): Promise<string> {
  const root = join(await makeTempDir(prefix), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

describe('0.4.6: preflight блокирует только открытую правку границы', () => {
  const PLAN = 'wiki/plans/0002-work.md';

  /** Утверждённый объявленный мини-план; `specDelta: null` — поле не объявлено. */
  async function project(specDelta: string | null): Promise<string> {
    const root = await newProject();
    const plan = ['---', 'type: plan', 'title: Работа', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension',
      'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', 'sources: []', 'supersedes: null', 'approved_by: Человек',
      'approved_at: 2026-11-01', 'active_phase: null', 'blocking_questions: 0', ...(specDelta === null ? [] : [`spec_delta: ${specDelta}`]), 'current_slice: 01-vhod', '---', '', '# Работа', ''].join('\n');
    await writeFile(join(root, PLAN), plan.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${planBodyDigest(plan)}`), 'utf8');
    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-work.md'), 'utf8');
    return root;
  }

  it('resolved — разрешено, строка info советует вернуть none', async () => {
    const decision = await buildPreflight(await project('resolved'), { scale: 'quick' });
    expect([decision.ok, decision.route, decision.slice]).toEqual([true, 'build', '01-vhod']);
    const note = decision.findings.find((item) => item.code === 'preflight-spec-delta-resolved');
    expect(note).toMatchObject({ level: 'info', path: PLAN });
    expect(note?.message).toContain('none');
    expect(decision.findings.filter((item) => item.level === 'block')).toEqual([]);
  });

  it('open — блок, как раньше, и код выхода CLI не ноль', async () => {
    const root = await project('open');
    const decision = await buildPreflight(root, { scale: 'quick' });
    expect([decision.ok, decision.slice]).toEqual([false, null]);
    expect(decision.findings.map((item) => [item.level, item.code])).toEqual([['block', 'preflight-spec-delta']]);
    const cli = collectIo();
    expect(await runMaestroCli(['preflight', '--path', root], cli.io)).not.toBe(0);
    expect(cli.stderr()).toContain('preflight-spec-delta');
  });

  it('none — разрешено без лишних строк; поле не объявлено — блок, как раньше', async () => {
    const clean = await buildPreflight(await project('none'), { scale: 'quick' });
    expect(clean.ok).toBe(true);
    expect(clean.findings.map((item) => item.code)).toEqual(['preflight-slice-selected']);

    const undeclared = await buildPreflight(await project(null), { scale: 'quick' });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.findings.map((item) => item.code)).toEqual(['preflight-gate-fields-missing']);
  });

  it('resolved рядом с настоящим блоком блок не снимает', async () => {
    const root = await project('resolved');
    await writeFile(join(root, PLAN), (await readUtf8(root, PLAN)).replace('blocking_questions: 0', 'blocking_questions: 2'), 'utf8');
    const decision = await buildPreflight(root, { scale: 'quick' });
    expect(decision.ok).toBe(false);
    expect(decision.findings.map((item) => item.code)).toEqual(['preflight-blocking-questions']);
  });
});

describe('0.4.6: source-hash-missing говорит, что делать', () => {
  it('код и уровень прежние; текст называет sources --write и maestro/inbox/', async () => {
    const root = await newProject();
    await mkdir(join(root, 'maestro/sources'), { recursive: true });
    await writeFile(join(root, 'maestro/sources/снимок.txt'), 'one', 'utf8');
    await writeFile(join(root, 'maestro/sources/материал.txt'), 'x\n', 'utf8');
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: { 'maestro/sources/снимок.txt': sha256('one') } }), 'utf8');
    const found = (await doctorProject(root)).findings.filter((item) => item.code.startsWith('source-'));
    expect(found.map((item) => [item.level, item.code, item.path])).toEqual([['critical', 'source-hash-missing', 'maestro/sources/материал.txt']]);
    expect(found[0]?.message).toContain('vibe-maestro sources --write');
    expect(found[0]?.message).toContain('maestro/inbox/');
  });
});
