import { execFile } from 'node:child_process';
import { readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { doctorProject } from '../src/core/doctor.js';
import { CHECKSUMS_PATH, MANIFEST_PATH } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const exec = promisify(execFile);
afterEach(cleanupTempDirs);

async function fresh(git = false) {
  const target = await makeTempDir();
  const result = await initProject({ target, name: 'Doctor Test', startingPoint: 'idea', git, now: FIXED_NOW });
  expect(result.ok).toBe(true);
  return target;
}

describe('doctorProject', () => {
  it('свежий проект проходит без замечаний', async () => {
    const target = await fresh(false);
    const report = await doctorProject(target);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('находит отсутствующий managed-файл', async () => {
    const target = await fresh();
    await unlink(join(target, 'wiki/hot.md'));
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === 'managed-missing' && f.path === 'wiki/hot.md')).toBe(true);
  });

  it('находит изменённый managed-файл', async () => {
    const target = await fresh();
    await writeFile(join(target, 'wiki/hot.md'), 'изменено', 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'managed-modified')).toBe(true);
  });

  it('сообщает о повреждённом manifest без stacktrace', async () => {
    const target = await fresh();
    await writeFile(join(target, MANIFEST_PATH), '{bad json', 'utf8');
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('manifest-invalid');
  });

  it('находит битую относительную ссылку index.md', async () => {
    const target = await fresh();
    const index = join(target, 'wiki/index.md');
    await writeFile(index, '---\ntype: index\ntitle: x\nupdated: 2026-08-02\n---\n[нет](concepts/missing.md)\n', 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'wiki-link-broken')).toBe(true);
  });

  it('находит отсутствующий checksums', async () => {
    const target = await fresh();
    await rm(join(target, CHECKSUMS_PATH));
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'checksums-invalid')).toBe(true);
  });

  it('не считает CRLF-версию текстового managed-файла изменением', async () => {
    const target = await fresh();
    const path = join(target, 'wiki/hot.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/\n/g, '\r\n'), 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.some((f) => f.code === 'managed-modified' && f.path === 'wiki/hot.md')).toBe(false);
  });

  it('красным находит отслеживаемые .env и .env.* кроме .env.example', async () => {
    const target = await fresh(true);
    await writeFile(join(target, '.env'), 'PLACEHOLDER=value\n', 'utf8');
    await writeFile(join(target, '.env.production'), 'PLACEHOLDER=value\n', 'utf8');
    await writeFile(join(target, '.env.example'), 'PLACEHOLDER=example\n', 'utf8');
    await exec('git', ['add', '-f', '.env', '.env.production', '.env.example'], { cwd: target });
    const report = await doctorProject(target);
    const secretPaths = report.findings.filter((f) => f.code === 'git-env-tracked').map((f) => f.path);
    expect(secretPaths).toEqual(['.env', '.env.production']);
    expect(report.ok).toBe(false);
  });
});
