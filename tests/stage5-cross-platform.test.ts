import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { isManifest, sha256 } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readJson, readUtf8 } from './helpers.js';

const exec = promisify(execFile);
const init = (target: string, git = false) => initProject({ target, startingPoint: 'idea', git, now: FIXED_NOW });
const codes = (report: Awaited<ReturnType<typeof doctorProject>>) => report.findings.map((f) => f.code);

afterEach(cleanupTempDirs);

describe('этап 5: полный механический doctor', () => {
  it('отказывает, если root проекта является symlink', async () => {
    const parent = await makeTempDir();
    const realRoot = join(parent, 'real-root');
    const linkedRoot = join(parent, 'linked-root');
    await mkdir(realRoot);
    await init(realRoot);
    await symlink(realRoot, linkedRoot);
    const report = await doctorProject(linkedRoot);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('project-root-symlink');
  });

  it('отказывает, если существующий предок root является symlink', async () => {
    const parent = await makeTempDir();
    const outside = join(parent, 'outside');
    const linkedParent = join(parent, 'linked-parent');
    const realRoot = join(outside, 'project');
    await mkdir(outside);
    await init(realRoot);
    await symlink(outside, linkedParent);
    const report = await doctorProject(join(linkedParent, 'project'));
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain('project-root-symlink');
  });

  it.each([
    ['.maestro/manifest.json', 'metadata-symlink'],
    ['.maestro/checksums.json', 'metadata-symlink'],
    ['wiki/hot.md', 'managed-symlink'],
  ])('отказывает до чтения symlink-файла %s', async (relativePath, expectedCode) => {
    const root = await makeTempDir();
    await init(root);
    const absolute = join(root, relativePath);
    const original = await readFile(absolute);
    const outside = join(root, `outside-${relativePath.replace(/\//g, '-')}`);
    await writeFile(outside, original);
    await rm(absolute);
    await symlink(outside, absolute);
    const report = await doctorProject(root);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain(expectedCode);
  });

  it.each([
    ['wiki', 'wiki-symlink'],
    ['maestro/inbox', 'inbox-symlink'],
  ])('отказывает до обхода symlink-каталога %s', async (relativePath, expectedCode) => {
    const root = await makeTempDir();
    await init(root);
    const outside = await makeTempDir();
    await rm(join(root, relativePath), { recursive: true });
    await symlink(outside, join(root, relativePath));
    const report = await doctorProject(root);
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain(expectedCode);
  });

  it('fresh project green; непустой inbox даёт warning', async () => {
    const root = await makeTempDir();
    await init(root);
    expect(await doctorProject(root)).toMatchObject({ ok: true, findings: [] });
    await writeFile(join(root, 'maestro/inbox/note.txt'), 'todo');
    const report = await doctorProject(root);
    expect(report.ok).toBe(true);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'inbox-not-empty', level: 'warning' }));
  });

  it('strict UTF-8 и обязательный frontmatter дают findings, не throw', async () => {
    const root = await makeTempDir();
    await init(root);
    await writeFile(join(root, 'wiki/log.md'), Buffer.from([0xff, 0xfe, 0x41]));
    await writeFile(join(root, 'wiki/roadmap.md'), '# no frontmatter\n');
    const report = await doctorProject(root);
    expect(codes(report)).toEqual(expect.arrayContaining(['wiki-invalid-utf8', 'wiki-frontmatter-invalid']));
  });

  it('проверяет ссылки во всех wiki md и запрещает выход из wiki', async () => {
    const root = await makeTempDir();
    await init(root);
    await writeFile(join(root, 'wiki/log.md'), '---\nproject: x\nupdated: 2026-08-02\n---\n[missing](concepts/no.md) [escape](../README.md)\n');
    const report = await doctorProject(root);
    expect(report.findings.filter((f) => f.code === 'wiki-link-broken')).toHaveLength(1);
    expect(report.findings.filter((f) => f.code === 'wiki-link-outside')).toHaveLength(1);
  });

  it('проверяет documented hot/active-progress frontmatter contract', async () => {
    const root = await makeTempDir();
    await init(root);
    await mkdir(join(root, 'wiki/progress'), { recursive: true });
    await writeFile(join(root, 'wiki/progress/one.md'), '---\nstatus: active\n---\n# One\n');
    let report = await doctorProject(root);
    expect(codes(report)).toContain('hot-active-progress-mismatch');
    const hot = await readUtf8(root, 'wiki/hot.md');
    await writeFile(join(root, 'wiki/hot.md'), hot.replace('active_progress: none', 'active_progress: progress/one.md'));
    report = await doctorProject(root);
    expect(codes(report)).not.toContain('hot-active-progress-mismatch');
  });

  it('проверяет Git dirty только для managed docs', async () => {
    const root = await makeTempDir();
    await init(root, true);
    // wiki/index.md — managed-документ: правка в рабочем дереве обязана быть видна.
    await writeFile(join(root, 'wiki/index.md'), `${await readUtf8(root, 'wiki/index.md')}dirty\n`);
    // wiki/log.md принадлежит проекту по содержанию, поэтому его правка не dirty.
    await writeFile(join(root, 'wiki/log.md'), `${await readUtf8(root, 'wiki/log.md')}dirty\n`);
    const report = await doctorProject(root);
    expect(codes(report)).toContain('git-managed-dirty');
    const dirty = report.findings.filter((f) => f.code === 'git-managed-dirty').map((f) => f.path);
    expect(dirty).toContain('wiki/index.md');
    expect(dirty).not.toContain('wiki/log.md');
  });

  it('проверяет source hashes только при наличии отдельного metadata file', async () => {
    const root = await makeTempDir();
    await init(root);
    await writeFile(join(root, 'maestro/sources/input.txt'), 'one');
    expect(codes(await doctorProject(root))).not.toContain('source-hash-mismatch');
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: { 'maestro/sources/input.txt': sha256('one') } }));
    expect(codes(await doctorProject(root))).not.toContain('source-hash-mismatch');
    await writeFile(join(root, 'maestro/sources/input.txt'), 'two');
    expect(codes(await doctorProject(root))).toContain('source-hash-mismatch');
  });

  it('malformed source metadata становится finding', async () => {
    const root = await makeTempDir();
    await init(root);
    await writeFile(join(root, '.maestro/source-hashes.json'), '{');
    await expect(doctorProject(root)).resolves.toMatchObject({ ok: false });
    expect(codes(await doctorProject(root))).toContain('source-hashes-invalid');
  });

  it('source metadata обязан точно покрывать все обычные source-файлы', async () => {
    const root = await makeTempDir();
    await init(root);
    await writeFile(join(root, 'maestro/sources/input.txt'), 'one');
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: {} }));
    expect(codes(await doctorProject(root))).toContain('source-hash-missing');
  });

  it('symlink внутри sources диагностируется и не читается', async () => {
    const root = await makeTempDir();
    await init(root);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, join(root, 'maestro/sources/link.txt'));
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: {} }));
    expect(codes(await doctorProject(root))).toContain('source-symlink');
  });

  it('symlink самой папки sources диагностируется до чтения внешнего дерева', async () => {
    const root = await makeTempDir();
    await init(root);
    const outside = await makeTempDir();
    await writeFile(join(outside, 'external.txt'), 'outside');
    await rm(join(root, 'maestro/sources'), { recursive: true });
    await symlink(outside, join(root, 'maestro/sources'));
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: {} }));
    expect(codes(await doctorProject(root))).toContain('source-symlink');
  });

  it('symlink source-hashes metadata диагностируется до чтения', async () => {
    const root = await makeTempDir();
    await init(root);
    const outside = join(root, 'outside-hashes.json');
    await writeFile(outside, JSON.stringify({ files: {} }));
    await symlink(outside, join(root, '.maestro/source-hashes.json'));
    expect(codes(await doctorProject(root))).toContain('source-hashes-symlink');
  });

  it('dangling symlink source-hashes диагностируется, а не считается отсутствующим', async () => {
    const root = await makeTempDir();
    await init(root);
    await symlink(join(root, 'missing-hashes.json'), join(root, '.maestro/source-hashes.json'));
    expect(codes(await doctorProject(root))).toContain('source-hashes-symlink');
  });

  it('symlink-предок maestro блокирует чтение sources и metadata', async () => {
    const root = await makeTempDir();
    await init(root);
    const outside = await makeTempDir();
    await mkdir(join(outside, 'sources'));
    await writeFile(join(outside, 'source-hashes.json'), JSON.stringify({ files: {} }));
    await rm(join(root, 'maestro'), { recursive: true });
    await symlink(outside, join(root, 'maestro'));
    const report = await doctorProject(root);
    expect(codes(report)).toContain('source-symlink');
  });
});

describe('cross-platform и distribution contracts', () => {
  it('создаёт managed .gitattributes и канонический .gitignore', async () => {
    const root = await makeTempDir();
    await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW });
    expect(await readUtf8(root, '.gitattributes')).toContain('* text=auto eol=lf');
    const bytes = await readFile(join(root, '.gitignore'));
    expect(bytes.toString()).toContain('node_modules/\n');
    expect(bytes.toString()).not.toContain('\r\n');
  });

  it('runtime validator и shipped schema принимают/отвергают одинаковые fixtures', async () => {
    const root = await makeTempDir();
    await init(root);
    const valid = await readJson<unknown>(root, '.maestro/manifest.json');
    const schema = JSON.parse(await readFile(resolve('schemas/manifest.schema.json'), 'utf8'));
    const validate = new Ajv().compile(schema);
    const structuralInvalids = [
      { ...(valid as object), schemaVersion: 999 },
      { ...(valid as object), extra: true },
      { ...(valid as any), managed: [{ path: '../x', kind: 'managed' }] },
    ];
    for (const fixture of [valid, ...structuralInvalids]) expect(isManifest(fixture)).toBe(validate(fixture));

    // Draft-07 не выражает уникальность по одному свойству объекта. Schema
    // проверяет форму, а runtime canonical guard — семантическую уникальность path.
    const duplicatePath = { ...(valid as any), managed: [{ path: 'x', kind: 'managed' }, { path: 'x', kind: 'generated' }] };
    expect(validate(duplicatePath)).toBe(true);
    expect(isManifest(duplicatePath)).toBe(false);
  });

  it('шаблоны содержат рабочую one-package doctor command', async () => {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const text = await readFile(resolve('templates/project', name), 'utf8');
      expect(text).toContain('npx --package create-vibe-maestro@latest vibe-maestro doctor');
    }
  });
});
