import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { CHECKSUMS_PATH, contentChecksum, loadChecksums, MANIFEST_PATH } from '../src/core/manifest.js';
import { analyzeUpgrade, upgradeProject } from '../src/core/upgrade/index.js';
import { REMOVED_PATHS } from '../src/core/upgrade/releases.js';
import { cleanupTempDirs, readUtf8, snapshotTree } from './helpers.js';
import { collectIo, materializePublished } from './published.js';

afterEach(cleanupTempDirs);

/**
 * Искусственный состав: в каноне 0.4.1 будто бы были ещё файлы Maestro, которых в текущей
 * версии нет. Два — в списке удаляемых (и одни в своей папке), один — нет. Исходник
 * удаляемых — LICENSE пакета: текст без подстановок, который есть в любой версии.
 */
const { RETIRED, STRAY, STRAY_VERSION } = vi.hoisted(() => ({
  RETIRED: ['protocols/retired/a.md', 'protocols/retired/b.md'],
  STRAY: 'protocols/stray.md',
  STRAY_VERSION: '0.0.1-stray',
}));

vi.mock('../src/core/upgrade/releases.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/upgrade/releases.js')>();
  const { readFile: read } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const source = (await read(new URL('../LICENSE', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const sha = createHash('sha256').update(source).digest('hex');
  const extra = (paths: readonly string[]) => ({
    inventory: Object.fromEntries(paths.map((path) => [path, 'managed' as const])),
    sha: Object.fromEntries(paths.map((path) => [path, sha])),
    templates: paths.map((path) => ({ path, source: 'LICENSE', sha256: sha })),
  });
  const withPaths = (release: (typeof actual.RELEASES)[number], paths: readonly string[], versions = release.versions) => {
    const add = extra(paths);
    return {
      ...release,
      id: versions === release.versions ? release.id : `${release.id}+${versions.join()}`,
      versions,
      inventory: (depth: Parameters<typeof release.inventory>[0]) => ({ ...release.inventory(depth), ...add.inventory }),
      managedSha256: { ...release.managedSha256, ...add.sha },
      templates: [...release.templates, ...add.templates],
    };
  };
  const base = actual.RELEASES.find((release) => release.id === '0.4.1');
  if (base === undefined) throw new Error('в реестре нет 0.4.1');
  const releases = [
    withPaths(base, [STRAY], [STRAY_VERSION]),
    ...actual.RELEASES.map((release) => (release === base ? withPaths(release, RETIRED) : release)),
  ];
  return {
    ...actual,
    RELEASES: releases,
    REMOVED_PATHS: { ...actual.REMOVED_PATHS, ...Object.fromEntries(RETIRED.map((path) => [path, '9.9.9'])) },
    findRelease: (version: string) => releases.find((release) => release.versions.includes(version)),
    supportedVersions: () => releases.flatMap((release) => [...release.versions]),
  };
});

/** Всё, что удаляется с 0.4.1: настоящие ушедшие протоколы плюс искусственные. */
const ALL_REMOVED = Object.keys(REMOVED_PATHS).sort();

const licence = async (): Promise<string> => (await readFile(join(process.cwd(), 'LICENSE'), 'utf8')).replace(/\r\n/g, '\n');

/** Проект 0.4.1 с лишними файлами Maestro: manifest и суммы их знают, как знал бы init прошлой версии. */
async function projectWith(paths: readonly string[], version?: string): Promise<string> {
  const { root } = await materializePublished('0.4.1-standard', version);
  const text = await licence();
  const manifest = JSON.parse(await readUtf8(root, MANIFEST_PATH)) as { inventory: { path: string; ownership: string }[]; managed: { path: string; kind: string }[] };
  const checksums = (await loadChecksums(root))?.files ?? {};
  for (const path of paths) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text, 'utf8');
    manifest.inventory.push({ path, ownership: 'managed' });
    manifest.managed.push({ path, kind: 'managed' });
    checksums[path] = contentChecksum(path, text);
  }
  await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, CHECKSUMS_PATH), `${JSON.stringify({ files: checksums }, null, 2)}\n`, 'utf8');
  return root;
}

describe('upgrade удаляет нетронутые файлы Maestro, ушедшие из состава', () => {
  it('dry-run называет удаляемое с числом строк и не пишет ни байта', async () => {
    const root = await projectWith(RETIRED);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.removes).toEqual(ALL_REMOVED);
    expect(analysis.removes).toEqual(expect.arrayContaining(RETIRED));
    const cli = collectIo();
    expect(await runMaestroCli(['upgrade', '--path', root], cli.io)).toBe(0);
    const lines = (await licence()).split('\n').length - 1;
    expect(cli.stdout()).toContain('Будет удалено (файлы Maestro без ваших правок, которых больше нет в составе):');
    expect(cli.stdout()).toContain(`  protocols/retired/a.md (строк: -${lines})`);
    expect(cli.stdout()).toContain('--diff (полный показ — сотни строк)');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('--apply удаляет файлы и опустевшую папку, снимает их суммы; doctor --strict зелёный', async () => {
    const root = await projectWith(RETIRED);
    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.removedFiles).toEqual(ALL_REMOVED);
    for (const path of RETIRED) expect(existsSync(join(root, path)), path).toBe(false);
    expect(existsSync(join(root, 'protocols/retired')), 'пустая папка убрана').toBe(false);
    expect(existsSync(join(root, 'protocols')), 'папка с другими файлами осталась').toBe(true);
    const checksums = (await loadChecksums(root))?.files ?? {};
    for (const path of RETIRED) expect(checksums[path], path).toBeUndefined();
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await analyzeUpgrade(root)).analysis.status).toBe('current');
  });

  it('папка, где лежит ещё что-то своё, остаётся', async () => {
    const root = await projectWith(RETIRED);
    await writeFile(join(root, 'protocols/retired/моё.md'), 'Своя заметка.\n', 'utf8');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect(await readUtf8(root, 'protocols/retired/моё.md')).toBe('Своя заметка.\n');
  });

  it('изменённый удаляемый файл останавливает всё: понятный совет, ни байта не записано', async () => {
    const root = await projectWith(RETIRED);
    await writeFile(join(root, RETIRED[0] as string), `${await licence()}Моя строка.\n`, 'utf8');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toEqual([expect.objectContaining({ code: 'upgrade-removed-modified', path: RETIRED[0] })]);
    expect(result.analysis.blockers[0]?.message).toContain('Верните файл к исходному виду или перенесите свои правки в собственный файл проекта');
    expect(result.analysis.blockers[0]?.message).toContain('9.9.9');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('уже удалённый файл пропускается, его сумма снимается', async () => {
    const root = await projectWith(RETIRED);
    await rm(join(root, RETIRED[1] as string));
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.removes).toEqual(ALL_REMOVED.filter((path) => path !== RETIRED[1]));
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect((await loadChecksums(root))?.files[RETIRED[1] as string]).toBeUndefined();
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('сбой посреди применения откатывает и удалённое: проект побайтово как был', async () => {
    const root = await projectWith(RETIRED);
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, {
      apply: true,
      hooks: { beforeCommit: async (path) => { if (path === CHECKSUMS_PATH) throw new Error('сбой'); } },
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('--diff показывает удаляемый текст строками «-» и не пишет ни байта', async () => {
    const root = await projectWith(RETIRED);
    const before = await snapshotTree(root);
    const cli = collectIo();
    expect(await runMaestroCli(['upgrade', '--path', root, '--diff'], cli.io)).toBe(0);
    const firstLine = (await licence()).split('\n')[0] as string;
    expect(cli.stdout()).toContain(`=== Будет удалено: protocols/retired/a.md`);
    expect(cli.stdout()).toContain(`\n-${firstLine}\n`);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('--json — прежний отчёт плюс поле removes', async () => {
    const root = await projectWith(RETIRED);
    const cli = collectIo();
    expect(await runMaestroCli(['upgrade', '--path', root, '--json'], cli.io)).toBe(0);
    const report = JSON.parse(cli.stdout()) as { analysis: Record<string, unknown> };
    expect(Object.keys(report)).toEqual(['reportVersion', 'ok', 'applied', 'rolledBack', 'analysis']);
    expect(Object.keys(report.analysis)).toEqual([
      'reportVersion', 'status', 'root', 'baselineId', 'fromVersion', 'toVersion',
      'creates', 'updates', 'removes', 'unchanged', 'preserves', 'handedOver', 'metadata', 'notes', 'blockers',
    ]);
    expect(report.analysis.removes).toEqual(ALL_REMOVED);
    expect(JSON.stringify(report)).not.toContain((await licence()).split('\n')[0] as string);
  });

  it('незнакомое удаление по-прежнему останавливает upgrade', async () => {
    const root = await projectWith([STRAY], STRAY_VERSION);
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toEqual([expect.objectContaining({ code: 'upgrade-removal-unsupported', path: STRAY })]);
    expect(await snapshotTree(root)).toEqual(before);
  });
});
