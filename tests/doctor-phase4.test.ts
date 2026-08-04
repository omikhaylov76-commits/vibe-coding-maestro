import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { isCapabilityLedger } from '../src/core/doctor/protocols.js';
import { error, sortFindings } from '../src/core/doctor/types.js';
import { initProject } from '../src/core/init.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const exec = promisify(execFile);

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (value: string) => out.push(value), err: (value: string) => err.push(value) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

async function fresh(): Promise<string> {
  const root = await makeTempDir('doctor-phase4-');
  const result = await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW });
  expect(result.ok).toBe(true);
  return root;
}

afterEach(cleanupTempDirs);

describe('Phase 4: versioned deterministic doctor policy', () => {
  it('публикует reportVersion и полный severity contract', async () => {
    const root = await fresh();
    const report = await doctorProject(root);
    expect(report).toMatchObject({ reportVersion: 1, ok: true, findings: [] });

    await writeFile(join(root, 'maestro/inbox/note.txt'), 'todo', 'utf8');
    await writeFile(join(root, '.env'), 'SECRET=value\n', 'utf8');
    const withFindings = await doctorProject(root);
    expect(withFindings.findings.find((item) => item.code === 'inbox-not-empty')?.level).toBe('warning');
  });

  it('default пропускает warning, strict блокирует тот же неизменный отчёт', async () => {
    const root = await fresh();
    await writeFile(join(root, 'maestro/inbox/note.txt'), 'todo', 'utf8');
    const normal = await doctorProject(root);
    const strict = await doctorProject(root, { strict: true });
    expect(normal.ok).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.findings).toEqual(normal.findings);
  });

  it('сортирует findings детерминированно по severity, code, path и message', async () => {
    const root = await fresh();
    await mkdir(join(root, 'wiki/audits'), { recursive: true });
    await writeFile(join(root, 'wiki/audits/z.md'), '# malformed\n', 'utf8');
    await writeFile(join(root, 'maestro/inbox/z.txt'), 'todo', 'utf8');
    await writeFile(join(root, 'wiki/index.md'), 'modified', 'utf8');
    const first = await doctorProject(root);
    const second = await doctorProject(root);
    expect(second).toEqual(first);
    const keys = first.findings.map((item) => `${item.level}\0${item.code}\0${item.path ?? ''}\0${item.message}`);
    const rank: Record<string, string> = { critical: '0', error: '1', warning: '2', info: '3' };
    const sorted = first.findings
      .map((item) => `${rank[item.level]}\0${item.code}\0${item.path ?? ''}\0${item.message}`)
      .sort();
    expect(keys.map((key) => `${rank[key.split('\0')[0] ?? '']}\0${key.split('\0').slice(1).join('\0')}`)).toEqual(sorted);
  });

  it('сортирует Unicode code units независимо от системной локали', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('locale API запрещён детерминированным comparator'); });
    const findings = [
      error('same', 'same', 'wiki/audits/ä.md'),
      error('same', 'same', 'wiki/audits/z.md'),
      error('same', 'same', 'wiki/audits/Я.md'),
      error('same', 'same', 'wiki/audits/A.md'),
    ];
    expect(sortFindings(findings).map((item) => item.path)).toEqual([
      'wiki/audits/A.md',
      'wiki/audits/z.md',
      'wiki/audits/ä.md',
      'wiki/audits/Я.md',
    ]);
    expect(localeCompare).not.toHaveBeenCalled();
    localeCompare.mockRestore();
  });

  it('capability ledger guard fail-closed отвергает schema-invalid формы', () => {
    expect(isCapabilityLedger({ schemaVersion: 1, capabilities: [] })).toBe(false);
    expect(isCapabilityLedger({ schemaVersion: 1, capabilities: [{}] })).toBe(false);
    expect(isCapabilityLedger({
      schemaVersion: 1,
      capabilities: [{ status: 'keep', ownerPath: null, contractId: null }],
    })).toBe(false);
    expect(isCapabilityLedger({
      schemaVersion: 1,
      capabilities: [{ status: 'reject', ownerPath: 'protocols/x.md', contractId: 'VCM-X' }],
    })).toBe(false);
    expect(isCapabilityLedger({
      schemaVersion: 1,
      capabilities: [{ status: 'keep', ownerPath: 'protocols/x.md', contractId: 'VCM-X' }],
    })).toBe(true);
  });

  it('doctor --strict блокирует warning, а skills --strict отклоняется парсером', async () => {
    const root = await fresh();
    await writeFile(join(root, 'maestro/inbox/note.txt'), 'todo', 'utf8');
    const normal = collect();
    const strict = collect();
    expect(await runMaestroCli(['doctor', '--path', root], normal.io)).toBe(0);
    expect(await runMaestroCli(['doctor', '--path', root, '--strict'], strict.io)).toBe(1);
    const invalid = collect();
    expect(await runMaestroCli(['skills', '--path', root, '--strict'], invalid.io)).toBe(2);
  });

  it('security и immutable integrity boundary имеют critical severity', async () => {
    const root = await makeTempDir('doctor-critical-');
    const result = await initProject({ target: root, startingPoint: 'idea', git: true, now: FIXED_NOW });
    expect(result.ok).toBe(true);
    await writeFile(join(root, '.env.production'), 'SECRET=value\n', 'utf8');
    await exec('git', ['add', '-f', '.env.production'], { cwd: root });
    await writeFile(join(root, 'maestro/sources/input.txt'), 'changed', 'utf8');
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: { 'maestro/sources/input.txt': '0'.repeat(64) } }), 'utf8');
    const report = await doctorProject(root);
    expect(report.findings.find((item) => item.code === 'git-env-tracked')?.level).toBe('critical');
    expect(report.findings.find((item) => item.code === 'source-hash-mismatch')?.level).toBe('critical');
  });

  it('обнаруживает исчезновение canonical contract anchor отдельным finding', async () => {
    const root = await fresh();
    const path = join(root, 'protocols/build/step-1-rules.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('<a id="VCM-HUMAN-AUTHORITY"></a>', ''), 'utf8');
    const report = await doctorProject(root);
    expect(report.findings).toContainEqual(expect.objectContaining({
      level: 'error',
      code: 'protocol-contract-missing',
      path: 'protocols/build/step-1-rules.md',
    }));
  });
});
