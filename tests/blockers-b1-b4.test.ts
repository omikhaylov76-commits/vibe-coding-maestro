import { execFile } from 'node:child_process';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { CHECKSUMS_PATH, MANIFEST_PATH } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, snapshotTree } from './helpers.js';

const exec = promisify(execFile);
afterEach(cleanupTempDirs);

async function init(target: string, force = false, git = false) {
  return initProject({ target, name: 'Regression', startingPoint: 'idea', force, git, now: FIXED_NOW });
}

async function fresh(): Promise<string> {
  const target = await makeTempDir();
  expect((await init(target)).ok).toBe(true);
  return target;
}

describe('B1: init не следует по symlink', () => {
  it('отказывает до записи, если затрагиваемый файл — symlink, и не меняет внешний файл', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'target');
    const victim = join(parent, 'victim.txt');
    await writeFile(victim, 'SECRET-ORIGINAL\n', 'utf8');
    await exec('mkdir', ['-p', target]);
    await symlink(victim, join(target, '.gitignore'));

    const result = await init(target, true);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symbolic link|symlink|символическ/i);
    expect(result.error).toContain('.gitignore');
    expect(await readFile(victim, 'utf8')).toBe('SECRET-ORIGINAL\n');
    expect(await snapshotTree(target)).toEqual({ '.gitignore': expect.any(String) });
  });

  it('отказывает, если промежуточный каталог managed-пути — symlink наружу', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'target');
    const outside = join(parent, 'outside');
    await exec('mkdir', ['-p', target, outside]);
    await symlink(outside, join(target, 'wiki'));

    const result = await init(target, true);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symbolic link|symlink|символическ/i);
    expect(await snapshotTree(outside)).toEqual({});
  });

  it('отказывает, если сама target-папка является symlink', async () => {
    const parent = await makeTempDir();
    const outside = join(parent, 'outside');
    const target = join(parent, 'target-link');
    await exec('mkdir', ['-p', outside]);
    await symlink(outside, target);

    const result = await init(target, true);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symbolic link|symlink|символическ/i);
    expect(await snapshotTree(outside)).toEqual({});
  });

  it('отказывает, если существующий предок несуществующей target является symlink', async () => {
    const parent = await makeTempDir();
    const outside = join(parent, 'outside');
    const linkedParent = join(parent, 'linked-parent');
    const target = join(linkedParent, 'new-project');
    await exec('mkdir', ['-p', outside]);
    await symlink(outside, linkedParent);

    const result = await init(target, false);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/symbolic link|symlink|символическ/i);
    expect(await snapshotTree(outside)).toEqual({});
  });
});

describe('B2: существующий Git index неприкосновенен', () => {
  it('сохраняет index побайтово и семантически при merged WIP и уже staged WIP', async () => {
    const target = await makeTempDir();
    await exec('git', ['init', '-b', 'main'], { cwd: target });
    await exec('git', ['config', 'user.name', 'User'], { cwd: target });
    await exec('git', ['config', 'user.email', 'user@example.test'], { cwd: target });
    await writeFile(join(target, '.gitignore'), 'base/\n', 'utf8');
    await writeFile(join(target, 'staged.txt'), 'base\n', 'utf8');
    await exec('git', ['add', '.gitignore', 'staged.txt'], { cwd: target });
    await exec('git', ['commit', '-m', 'base'], { cwd: target });
    await writeFile(join(target, '.gitignore'), 'base/\nPRIVATE-WIP/\n', 'utf8');
    await writeFile(join(target, 'staged.txt'), 'already staged WIP\n', 'utf8');
    await exec('git', ['add', 'staged.txt'], { cwd: target });
    const indexPath = join(target, '.git', 'index');
    const beforeBytes = await readFile(indexPath);
    const beforeCached = (await exec('git', ['diff', '--cached', '--binary'], { cwd: target })).stdout;

    const result = await init(target, true, true);

    expect(result.ok).toBe(true);
    expect(await readFile(indexPath)).toEqual(beforeBytes);
    expect((await exec('git', ['diff', '--cached', '--binary'], { cwd: target })).stdout).toBe(beforeCached);
    expect(await readFile(join(target, '.gitignore'), 'utf8')).toContain('PRIVATE-WIP/');
  });
});

describe('B3/B4: строгая runtime-валидация metadata', () => {
  it('manifest с unsupported version/null/опасными и повторными paths даёт findings, не throw', async () => {
    const target = await fresh();
    await writeFile(join(target, MANIFEST_PATH), JSON.stringify({
      schemaVersion: 999,
      product: {},
      project: {},
      managed: [null, { path: '../outside', kind: 'managed' }, { path: '/abs', kind: 'managed' }, { path: '.git/config', kind: 'managed' }, { path: 'same', kind: 'managed' }, { path: 'same', kind: 'managed' }],
    }), 'utf8');

    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('manifest-invalid');
  });

  it.each([
    ['массив вместо files', { files: [] }],
    ['опасный path', { files: { '../outside': 'a'.repeat(64) } }],
    ['uppercase/non-hex hash', { files: { 'wiki/hot.md': 'A'.repeat(64) } }],
  ])('checksums: %s отклоняется без падения', async (_name, checksums) => {
    const target = await fresh();
    await writeFile(join(target, CHECKSUMS_PATH), JSON.stringify(checksums), 'utf8');
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'checksums-invalid')).toBe(true);
  });

  it('каждый managed entry обязан иметь checksum', async () => {
    const target = await fresh();
    const checksums = JSON.parse(await readFile(join(target, CHECKSUMS_PATH), 'utf8')) as { files: Record<string, string> };
    delete checksums.files['wiki/hot.md'];
    await writeFile(join(target, CHECKSUMS_PATH), JSON.stringify(checksums), 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'managed-checksum-missing' && f.path === 'wiki/hot.md')).toBe(true);
  });

  it('trusted package inventory обнаруживает удаление обязательного системного path из manifest', async () => {
    const target = await fresh();
    const manifest = JSON.parse(await readFile(join(target, MANIFEST_PATH), 'utf8')) as { managed: Array<{ path: string }> };
    manifest.managed = manifest.managed.filter((entry) => entry.path !== 'wiki/hot.md');
    await writeFile(join(target, MANIFEST_PATH), JSON.stringify(manifest), 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'manifest-inventory-mismatch' && f.path === 'wiki/hot.md')).toBe(true);
  });

  it('повреждённый manifest при повторном init не перезаписывается', async () => {
    const target = await fresh();
    await writeFile(join(target, MANIFEST_PATH), '{broken', 'utf8');
    const before = await readFile(join(target, MANIFEST_PATH));
    const result = await init(target, true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/manifest|манифест/i);
    expect(await readFile(join(target, MANIFEST_PATH))).toEqual(before);
  });
});
