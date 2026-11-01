import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import { loadChecksums, loadManifest, MANIFEST_PATH } from '../src/core/manifest.js';
import type { ProjectDepth } from '../src/core/manifest.js';
import { quotePathArg, VERSION } from '../src/core/meta.js';
import { packageRoot } from '../src/core/paths.js';
import { renderTemplate } from '../src/core/template.js';
import { analyzeUpgrade, STAGING_DIR, upgradeProject } from '../src/core/upgrade/index.js';
import { findRelease, RELEASES, supportedVersions } from '../src/core/upgrade/releases.js';
import { compareVersions } from '../src/core/version.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, sha256, snapshotTree } from './helpers.js';
import { canonicalManagedSource, currentManagedSource, makeLegacy02Project } from './legacy-0.2.js';

afterEach(cleanupTempDirs);

const execFileAsync = promisify(execFile);

const DEPTHS: readonly ProjectDepth[] = ['light', 'standard', 'advanced'];

/** Файлы, в которых после upgrade стоит закреплённая версия вместо `@latest`. */
const PINNED_PATHS = ['.claude/commands/build.md', '.claude/rules/maestro.md', 'protocols/build.md', 'protocols/plan.md'];

/** Новые пути канона 0.4.0 относительно 0.3.0 и 0.3.1. */
const NEW_IN_040 = ['protocols/completion.md', 'wiki/passport.md'];

/** Новые пути 0.4.2: старт проекта, правило для материалов, страница восстановления и README (его нет ни в одной фикстуре). */
const NEW_IN_042 = ['.claude/commands/start.md', 'README.md', 'maestro/inbox/.gitattributes', 'protocols/start.md', 'wiki/restore.md'];

/** Файлы Maestro, которые 0.4.2 переписывает на нетронутом проекте любой прошлой версии 0.3 и новее (discovery.md 0.4.3 убрал). */
const UPDATED_IN_042 = ['.claude/commands/plan.md', 'maestro/inbox/README.md', 'maestro/runbooks/cowork-discovery.md', 'protocols/plan.md'];

/** Мелкие протоколы, которые 0.4.3 убрал из состава: upgrade с любой прошлой версии их удаляет. */
const REMOVED_IN_043 = [
  'protocols/build/audit-phase.md', 'protocols/build/audit-plan.md', 'protocols/build/step-1-rules.md', 'protocols/build/step-2-spec.md',
  'protocols/build/step-3-architecture.md', 'protocols/build/step-5-feature-loop.md', 'protocols/context-budget.md', 'protocols/discovery.md',
  'protocols/lessons.md', 'protocols/seams.md',
];

const union = (...lists: readonly string[][]): string[] => [...new Set(lists.flat())].sort();

/** Файлы Maestro, которые 0.4.3 переписывает на нетронутом проекте любой прошлой версии (completion.md — с 0.4.0). */
const UPDATED_IN_043 = union([
  '.claude/agents/code-reviewer.md', 'maestro/runbooks/cowork-audit.md', 'protocols/audit.md', 'protocols/build.md', 'protocols/handoff.md', 'protocols/plan.md', 'protocols/wiki.md',
], UPDATED_IN_042);

/** То же для проектов 0.3.0 и новее: у них уже есть правила Maestro, образец передачи и README и шаблон планов. */
const UPDATED_IN_043_SINCE_030 = union(UPDATED_IN_043, ['.claude/rules/maestro.md', 'maestro/templates/handoff.md', 'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md']);

/** Новые пути 0.4.3: образец отчёта проверки (Maestro) и Icebox (проект). */
const NEW_IN_043 = ['maestro/templates/audit.md', 'wiki/icebox.md'];

/** Новые пути текущего канона относительно 0.4.1. */
const NEW_SINCE_041 = union(NEW_IN_042, NEW_IN_043);

/** Новые пути текущего канона относительно 0.3 beta. */
const NEW_SINCE_BETA = ['.claude/agents/explorer.md', '.claude/rules/maestro.md', '.claude/rules/project.md', '.claude/settings.json', 'maestro/templates/adr.md', 'maestro/templates/handoff.md', 'maestro/templates/progress.md', ...NEW_IN_040, ...NEW_SINCE_041].sort();

/** Новые пути, которыми владеет проект: контрольной суммы Maestro у них нет. */
const NEW_PROJECT_OWNED = ['.claude/rules/project.md', '.claude/settings.json', 'README.md', 'wiki/icebox.md', 'wiki/passport.md', 'wiki/restore.md'];

/** Строки, которые 0.4.0 дописывает в `.gitignore` проекта. */
const GITIGNORE_APPENDS = ['.claude/worktrees/', '.claude/settings.local.json'];

/** Бывшие managed-файлы, которые 0.3.0 передаёт проекту. */
const HANDED_OVER = ['AGENTS.md', 'CLAUDE.md', 'wiki/index.md'];

/** Всё, что upgrade с 0.3 beta переписывает на нетронутом проекте. */
const UPDATED_FROM_BETA = union([
  '.claude/agents/code-reviewer.md', '.claude/commands/build.md', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'maestro/runbooks/cowork-audit.md', 'protocols/build.md',
  'protocols/handoff.md', 'protocols/plan.md', 'protocols/wiki.md', 'wiki/index.md', 'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md',
], UPDATED_IN_043);

interface PublishedFixture {
  generatedBy: string;
  version: string;
  depth: ProjectDepth;
  folder: string;
  files: Record<string, string>;
}

/**
 * Проекты, созданные НАСТОЯЩИМИ опубликованными пакетами (команда — в `generatedBy`).
 * Это независимая опора реестра: если слепок версии разошёлся с тем, что пакет
 * действительно записывал, тесты ниже это покажут.
 */
const FIXTURES = ['0.3.0-beta.2-standard', '0.3.0-beta.3-light', '0.3.0-beta.3-standard', '0.3.0-beta.3-advanced', '0.3.0-beta.4-standard'];

/** Проекты опубликованных 0.3.0 и 0.3.1: после них состав файлов поменялся в 0.4.0. */
const FIXTURES_03X = ['0.3.0-standard', '0.3.1-light', '0.3.1-standard', '0.3.1-advanced'];

/** Проекты опубликованного 0.4.0. */
const FIXTURES_040 = ['0.4.0-light', '0.4.0-standard', '0.4.0-advanced'];

/** Проекты опубликованного 0.4.1: после них 0.4.2 добавил старт проекта. */
const FIXTURES_041 = ['0.4.1-light', '0.4.1-standard', '0.4.1-advanced'];

/** Проекты опубликованного 0.4.2: после них 0.4.3 убрал мелкие протоколы и добавил образец отчёта и Icebox. */
const FIXTURES_042 = ['0.4.2-light', '0.4.2-standard', '0.4.2-advanced'];

/** Всё, что upgrade с 0.4.0 переписывает на нетронутом проекте: закреплённая версия и тексты про context и pack. */
const UPDATED_FROM_040 = union(['.claude/commands/build.md', '.claude/rules/maestro.md', 'protocols/build.md', 'protocols/completion.md', 'protocols/handoff.md', 'protocols/plan.md'], UPDATED_IN_043_SINCE_030);

/** Всё, что upgrade с 0.3.0 и 0.3.1 переписывает на нетронутом проекте. */
const UPDATED_FROM_03X = union(['.claude/agents/code-reviewer.md', '.claude/agents/explorer.md', '.claude/commands/build.md', '.claude/rules/maestro.md', '.gitignore', 'protocols/build.md', 'protocols/handoff.md', 'protocols/plan.md'], UPDATED_IN_043_SINCE_030);

async function fixture(id: string): Promise<PublishedFixture> {
  return JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/published', `${id}.json`), 'utf8')) as PublishedFixture;
}

async function materialize(id: string, version?: string): Promise<{ root: string; data: PublishedFixture }> {
  const data = await fixture(id);
  const root = join(await makeTempDir('published-'), data.folder);
  for (const [path, content] of Object.entries(data.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  if (version !== undefined) {
    const manifest = JSON.parse(data.files[MANIFEST_PATH] as string) as { product: { version: string } };
    manifest.product.version = version;
    await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { root, data };
}

async function setManifestVersion(root: string, version: string): Promise<void> {
  const manifest = await loadManifest(root);
  manifest.product.version = version;
  await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('сравнение версий', () => {
  it('упорядочивает выпуски и пред-выпуски по SemVer', () => {
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.10')).toBe(-1);
    expect(compareVersions('0.3.0-beta.4', '0.3.0')).toBe(-1);
    expect(compareVersions('0.3.0', '0.3.0-beta.4')).toBe(1);
    expect(compareVersions('0.2.0-beta.1', '0.3.0-beta.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.3.0-beta.4', '0.3.0-beta.4')).toBe(0);
    expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBe(-1);
    expect(compareVersions('0.3.0-beta', '0.3.0-beta.1')).toBe(-1);
  });

  it('не упорядочивает то, что не является версией', () => {
    expect(compareVersions('latest', '0.3.0')).toBeNull();
    expect(compareVersions('0.3', '0.3.0')).toBeNull();
  });
});

describe('реестр опубликованных канонов', () => {
  it('версии уникальны и идут по порядку выпуска', () => {
    const versions = supportedVersions();
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < versions.length; i += 1) {
      expect(compareVersions(versions[i - 1] as string, versions[i] as string), `${versions[i - 1]} < ${versions[i]}`).toBe(-1);
    }
  });

  it('текущая версия зарегистрирована, и её запись совпадает с тем, что пакет реально поставляет', async () => {
    const release = findRelease(VERSION);
    expect(release, `версия ${VERSION} не внесена в RELEASES`).toBeDefined();
    if (release === undefined) return;
    expect(release).toBe(RELEASES.at(-1));
    expect(release.templates).toEqual([]);
    for (const depth of DEPTHS) expect(release.inventory(depth), depth).toEqual(canonicalOwnershipInventory(depth));

    const managed = Object.entries(canonicalOwnershipInventory('advanced'))
      .filter(([path, ownership]) => ownership === 'managed' && !path.endsWith('/.gitkeep'))
      .map(([path]) => path);
    expect(Object.keys(release.managedSha256).sort()).toEqual(managed.sort());
    for (const path of managed) {
      expect(release.managedSha256[path], `${path}: шаблон изменён — заведите новую запись в RELEASES`).toBe(sha256(await canonicalManagedSource(path)));
    }
  });

  it('у каждой прошлой версии есть копия каждого managed-файла, который с тех пор изменился', async () => {
    for (const release of RELEASES) {
      const changed: string[] = [];
      for (const [path, hash] of Object.entries(release.managedSha256)) {
        const current = await currentManagedSource(path);
        if (current === null || sha256(current) !== hash) changed.push(path);
      }
      expect(release.templates.map((template) => template.path).sort(), release.id).toEqual(changed.sort());
      for (const template of release.templates) {
        const source = (await readFile(join(packageRoot(), template.source), 'utf8')).replace(/\r\n/g, '\n');
        expect(sha256(source), `${release.id}: ${template.source}`).toBe(template.sha256);
        expect(template.sha256, `${release.id}: ${template.path}`).toBe(release.managedSha256[template.path]);
      }
    }
  });

  it.each([...FIXTURES, ...FIXTURES_03X, ...FIXTURES_040, ...FIXTURES_041, ...FIXTURES_042])('слепок реестра совпадает с проектом, который записал опубликованный пакет (%s)', async (id) => {
    const data = await fixture(id);
    const release = findRelease(data.version);
    expect(release).toBeDefined();
    if (release === undefined) return;
    const manifest = JSON.parse(data.files[MANIFEST_PATH] as string) as { inventory: { path: string; ownership: string }[]; project: { createdAt: string } };
    expect(Object.fromEntries(manifest.inventory.map((entry) => [entry.path, entry.ownership]))).toEqual(release.inventory(data.depth));

    const copies = new Map(release.templates.map((template) => [template.path, template.source]));
    for (const path of Object.keys(release.managedSha256)) {
      const copy = copies.get(path);
      const source = copy === undefined
        ? await canonicalManagedSource(path)
        : (await readFile(join(packageRoot(), copy), 'utf8')).replace(/\r\n/g, '\n');
      const rendered = path === '.gitattributes'
        ? source
        : renderTemplate(source, { projectName: 'Проект фикстуры', date: manifest.project.createdAt.slice(0, 10), startingPoint: 'idea', version: data.version });
      expect(data.files[path], `${id}: ${path}`).toBe(rendered);
    }
  });
});

describe('upgrade с опубликованных бет на текущую версию', () => {
  it.each(FIXTURES)('%s: dry-run предлагает закрепить версию и не пишет ни байта', async (id) => {
    const { root, data } = await materialize(id);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.status).toBe('upgradable');
    expect(analysis.fromVersion).toBe(data.version);
    expect(analysis.toVersion).toBe(VERSION);
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(NEW_SINCE_BETA);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_FROM_BETA);
    expect(analysis.removes).toEqual(REMOVED_IN_043);
    expect(analysis.handedOver).toEqual(HANDED_OVER);
    expect(analysis.preserves).toContain('wiki/hot.md');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(FIXTURES)('%s: apply закрепляет версию, сохраняет проект, doctor --strict зелёный', async (id) => {
    const { root, data } = await materialize(id);
    const before = await loadManifest(root);
    const hot = await readUtf8(root, 'wiki/hot.md');

    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.updatedFiles.filter((path) => !path.startsWith('.maestro/')).sort()).toEqual(UPDATED_FROM_BETA);
    expect(result.createdFiles.sort()).toEqual(NEW_SINCE_BETA);
    expect(result.removedFiles).toEqual(REMOVED_IN_043);
    expect(existsSync(join(root, 'protocols/build')), 'опустевшая папка protocols/build убрана').toBe(false);

    for (const path of PINNED_PATHS) {
      const text = await readUtf8(root, path);
      expect(text, path).toContain(`create-vibe-maestro@${VERSION}`);
      expect(text, path).not.toContain('@latest');
    }
    expect(await readUtf8(root, 'CLAUDE.md')).toContain('# Проект фикстуры');
    expect(await readUtf8(root, 'wiki/hot.md')).toBe(hot);

    const after = await loadManifest(root);
    expect(after.product.version).toBe(VERSION);
    expect(after.project).toEqual(before.project);
    expect(after.project.depth).toBe(data.depth);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);

    const again = await analyzeUpgrade(root);
    expect(again.analysis.status).toBe('current');
  });

  it('0.3.0-beta.1 (первые проекты на 0.3, до npm) обновляется так же', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard', '0.3.0-beta.1');
    // Контрольные суммы не зависят от версии в manifest: файлы beta.1 и beta.3 совпадают побайтово.
    const result = await upgradeProject(root, { apply: true });
    expect(result.applied, result.analysis.blockers.map((item) => item.code).join(', ')).toBe(true);
    expect(result.analysis.baselineId).toBe('0.3-beta');
    expect((await loadManifest(root)).product.version).toBe(VERSION);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('после upgrade повторный create ничего не меняет', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const before = await snapshotTree(root);
    // Те же имя и день, что при создании: manifest не хранит отображаемое имя, а дата
    // во frontmatter берётся из «сейчас». Это известный дефект повторного create (ROADMAP, 0.3.0).
    const again = await initProject({ target: root, name: 'Проект фикстуры', startingPoint: 'idea', git: false, now: new Date('2026-10-31T12:00:00.000Z') });
    expect(again.ok, again.error).toBe(true);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('контрольные суммы: обновлённые пересчитаны, переданные проекту сняты, новые добавлены, остальные не тронуты', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const before = (await loadChecksums(root))?.files ?? {};
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const after = (await loadChecksums(root))?.files ?? {};
    for (const path of HANDED_OVER) expect(after[path], path).toBeUndefined();
    for (const path of NEW_SINCE_BETA.filter((item) => !NEW_PROJECT_OWNED.includes(item))) expect(after[path], path).toMatch(/^[0-9a-f]{64}$/);
    for (const path of NEW_PROJECT_OWNED) expect(after[path], path).toBeUndefined();
    for (const path of Object.keys(before)) {
      if (HANDED_OVER.includes(path)) continue;
      if (REMOVED_IN_043.includes(path)) { expect(after[path], path).toBeUndefined(); continue; }
      if (UPDATED_FROM_BETA.includes(path)) expect(after[path], path).not.toBe(before[path]);
      else expect(after[path], path).toBe(before[path]);
    }
  });

  it('изменённый вручную файл Maestro блокирует весь upgrade и ничего не пишет', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    await writeFile(join(root, 'protocols/plan.md'), `${await readUtf8(root, 'protocols/plan.md')}\nМоя строка.\n`, 'utf8');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toContainEqual(expect.objectContaining({ code: 'upgrade-managed-modified', path: 'protocols/plan.md' }));
    expect(result.analysis.blockers[0]?.message).toContain('0.3.0-beta.3');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('правка в файле, который upgrade не трогает, его не блокирует и сохраняется', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const edited = `${await readUtf8(root, 'protocols/status.md')}\nЛокальная заметка.\n`;
    await writeFile(join(root, 'protocols/status.md'), edited, 'utf8');
    const result = await upgradeProject(root, { apply: true });
    expect(result.applied).toBe(true);
    expect(await readUtf8(root, 'protocols/status.md')).toBe(edited);
  });

  it('проект более новой версии upgrade не трогает и называет нужную команду', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard', '9.0.0');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.analysis.blockers.map((item) => item.code)).toEqual(['upgrade-project-newer']);
    expect(result.analysis.blockers[0]?.message).toContain('npx --package create-vibe-maestro@9.0.0 vibe-maestro');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('неизвестная прошлая версия отвергается со списком поддерживаемых', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard', '0.1.0');
    const result = await upgradeProject(root, { apply: true });
    expect(result.analysis.blockers.map((item) => item.code)).toEqual(['upgrade-unsupported-version']);
    expect(result.analysis.blockers[0]?.message).toContain('0.3.0-beta.2');
  });

  it('несуществующая папка даёт понятный отказ', async () => {
    const missing = join(await makeTempDir('missing-'), 'нет такой папки');
    const result = await upgradeProject(missing, { apply: true });
    expect(result.analysis.blockers.map((item) => item.code)).toEqual(['upgrade-path-missing']);
  });

  it('CLI показывает переход между версиями и команду применения той же версией', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).toContain(`Предложение обновления 0.3.0-beta.3 → ${VERSION}`);
    expect(cli.stdout()).toContain(`npx --package create-vibe-maestro@${VERSION} vibe-maestro upgrade --path ${quotePathArg(root)} --apply`);
  });
});

describe('upgrade с опубликованных 0.3.0 и 0.3.1 на текущую версию', () => {
  it.each(FIXTURES_03X)('%s: dry-run называет новые файлы и строки .gitignore и не пишет ни байта', async (id) => {
    const { root, data } = await materialize(id);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.fromVersion).toBe(data.version);
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(union(NEW_IN_040, NEW_SINCE_041));
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_FROM_03X);
    expect(analysis.removes).toEqual(REMOVED_IN_043);
    expect(analysis.updates.find((item) => item.path === '.gitignore')?.appends).toEqual(GITIGNORE_APPENDS);
    expect(analysis.handedOver).toEqual([]);
    expect(analysis.preserves).toContain('.claude/settings.json');
    expect(analysis.preserves).not.toContain('.gitignore');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(FIXTURES_03X)('%s: apply приносит протокол и паспорт, дописывает .gitignore, doctor --strict зелёный', async (id) => {
    const { root, data } = await materialize(id);
    const settings = await readUtf8(root, '.claude/settings.json');
    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(result.createdFiles.sort()).toEqual(union(NEW_IN_040, NEW_SINCE_041));
    expect(result.updatedFiles.filter((path) => !path.startsWith('.maestro/')).sort()).toEqual(UPDATED_FROM_03X);

    const gitignore = data.files['.gitignore'] as string;
    const next = await readUtf8(root, '.gitignore');
    expect(next.startsWith(gitignore), 'строки проекта остались как были').toBe(true);
    expect(next.slice(gitignore.length).split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual(GITIGNORE_APPENDS);
    // settings.json принадлежит проекту: upgrade не снимает даже старый запрет на .env.
    expect(await readUtf8(root, '.claude/settings.json')).toBe(settings);
    expect(await readUtf8(root, 'wiki/passport.md')).toContain('## Переменные окружения');
    expect(await readUtf8(root, '.claude/rules/maestro.md')).toContain('protocols/completion.md');
    expect((await loadManifest(root)).product.version).toBe(VERSION);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await analyzeUpgrade(root)).analysis.status).toBe('current');
  });

  it('.gitignore проекта: дописывается только недостающее, свои строки и CRLF не тронуты', async () => {
    const { root } = await materialize('0.3.1-standard');
    const own = '# мой проект\r\nsecrets/\r\n.claude/worktrees/\r\n';
    await writeFile(join(root, '.gitignore'), own, 'utf8');
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.updates.find((item) => item.path === '.gitignore')?.appends).toEqual(['node_modules/', '/dist/', '/build/', '/coverage/', '.env', '.env.*', '!.env.example', '*.log', '.DS_Store', '.claude/settings.local.json']);
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const next = await readFile(join(root, '.gitignore'), 'utf8');
    expect(next.startsWith(own)).toBe(true);
    expect(next.match(/\.claude\/worktrees\//g)).toHaveLength(1);
    expect(next.endsWith('.claude/settings.local.json\r\n')).toBe(true);
  });

  it('.gitignore не в UTF-8: свои строки остаются байт в байт, откат тоже точный (ревью 0.4.0)', async () => {
    const { root } = await materialize('0.3.1-standard');
    // «# Проект» в cp1251 — не UTF-8.
    const own = Buffer.concat([Buffer.from('# '), Buffer.from([0xcf, 0xf0, 0xee, 0xe5, 0xea, 0xf2]), Buffer.from('\nsecrets/\n')]);
    await writeFile(join(root, '.gitignore'), own);
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const next = await readFile(join(root, '.gitignore'));
    expect(next.subarray(0, own.length).equals(own)).toBe(true);
    expect(next.subarray(own.length).toString('utf8')).toContain('.claude/settings.local.json');

    const { root: other } = await materialize('0.3.1-standard');
    await writeFile(join(other, '.gitignore'), own);
    const failed = await upgradeProject(other, { apply: true, hooks: { beforeCommit: async (path) => { if (path === '.maestro/checksums.json') throw new Error('сбой'); } } });
    expect(failed.rolledBack).toBe(true);
    expect((await readFile(join(other, '.gitignore'))).equals(own)).toBe(true);
  });

  it('.gitignore с меткой UTF-8 (BOM): первая строка узнаётся, метка остаётся', async () => {
    const { root } = await materialize('0.3.1-standard');
    const own = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('.claude/worktrees/\n.claude/settings.local.json\nnode_modules/\n/dist/\n/build/\n/coverage/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n')]);
    await writeFile(join(root, '.gitignore'), own);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.updates.map((item) => item.path)).not.toContain('.gitignore');
    await writeFile(join(root, '.gitignore'), own.subarray(0, own.length - '.DS_Store\n'.length));
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const next = await readFile(join(root, '.gitignore'));
    expect(next.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect(next.toString('utf8').match(/\.claude\/worktrees\//g)).toHaveLength(1);
    expect(next.toString('utf8').endsWith('.DS_Store\n')).toBe(true);
  });

  it('.gitignore, где всё уже есть, upgrade не трогает', async () => {
    const { root, data } = await materialize('0.3.1-standard');
    const full = `${data.files['.gitignore'] as string}.claude/worktrees/\n.claude/settings.local.json\n`;
    await writeFile(join(root, '.gitignore'), full, 'utf8');
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.updates.map((item) => item.path)).not.toContain('.gitignore');
    expect(analysis.preserves).toContain('.gitignore');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect(await readUtf8(root, '.gitignore')).toBe(full);
  });

  it('CLI называет строки, которые допишет в .gitignore', async () => {
    const { root } = await materialize('0.3.1-standard');
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).toContain(`Предложение обновления 0.3.1 → ${VERSION}`);
    expect(cli.stdout()).toContain('.gitignore — допишет строки: .claude/worktrees/, .claude/settings.local.json');
  });
});

describe('upgrade с опубликованного 0.4.0 на текущую версию', () => {
  it.each(FIXTURES_040)('%s: dry-run меняет только закреплённую версию и тексты про context и pack', async (id) => {
    const { root } = await materialize(id);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.fromVersion).toBe('0.4.0');
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(NEW_SINCE_041);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_FROM_040);
    expect(analysis.removes).toEqual(REMOVED_IN_043);
    expect(analysis.handedOver).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(FIXTURES_040)('%s: apply, doctor --strict зелёный, протоколы зовут context и pack', async (id) => {
    const { root } = await materialize(id);
    const passport = await readUtf8(root, 'wiki/passport.md');
    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    expect(await readUtf8(root, 'protocols/handoff.md')).toContain(`create-vibe-maestro@${VERSION} vibe-maestro context --path .`);
    expect(await readUtf8(root, '.claude/rules/maestro.md')).toContain(`create-vibe-maestro@${VERSION} vibe-maestro context --path .`);
    expect(await readUtf8(root, 'protocols/completion.md')).toContain(`create-vibe-maestro@${VERSION} vibe-maestro pack --path . --tag`);
    expect(await readUtf8(root, 'wiki/passport.md')).toBe(passport);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await analyzeUpgrade(root)).analysis.status).toBe('current');
  });
});

describe('doctor и версия проекта', () => {
  it('проект беты с другим составом файлов: одна находка с командами проверки его версией и upgrade', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.findings.map((item) => item.code)).toEqual(['project-outdated']);
    expect(report.findings[0]?.message).toContain(`npx --package create-vibe-maestro@0.3.0-beta.3 vibe-maestro doctor --path ${quotePathArg(root)}`);
    expect(report.findings[0]?.message).toContain(`npx --package create-vibe-maestro@${VERSION} vibe-maestro upgrade --path ${quotePathArg(root)}`);

    const cli = collect();
    expect(await runMaestroCli(['doctor', '--path', root], cli.io)).toBe(1);
    expect(cli.stderr()).toContain('project-outdated');
  });

  it('проект более новой версии с другим составом файлов — одна понятная находка', async () => {
    const target = join(await makeTempDir('newer-'), 'новее');
    expect((await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    const manifest = await loadManifest(target);
    manifest.product.version = '9.0.0';
    manifest.inventory = manifest.inventory.filter((entry) => entry.path !== 'protocols/status.md');
    manifest.managed = manifest.managed.filter((entry) => entry.path !== 'protocols/status.md');
    await writeFile(join(target, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const report = await doctorProject(target);
    expect(report.findings.map((item) => item.code)).toEqual(['project-newer']);
    expect(report.findings[0]?.message).toContain(`npx --package create-vibe-maestro@9.0.0 vibe-maestro doctor --path ${quotePathArg(target)}`);
  });

  it('проект, обновлённый более новой версией с тем же составом, проходит с пометкой', async () => {
    const target = join(await makeTempDir('newer-same-'), 'новее');
    expect((await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await setManifestVersion(target, '9.0.0');
    const report = await doctorProject(target, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings.map((item) => item.code)).toEqual(['project-version-newer']);
  });

  it('несуществующий путь и папка без Maestro называются прямо', async () => {
    const parent = await makeTempDir('where-');
    const missing = await doctorProject(join(parent, 'нет такой'));
    expect(missing.findings.map((item) => item.code)).toEqual(['project-path-missing']);
    expect(missing.findings[0]?.message).toContain('кавычки');

    const empty = await doctorProject(parent);
    expect(empty.findings.map((item) => item.code)).toEqual(['manifest-missing']);
    expect(empty.findings[0]?.message).toContain('npx create-vibe-maestro@latest');
  });

  it('переименованная папка остаётся тем же проектом: только пометка с обоими именами', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const renamed = join(dirname(root), 'другое-имя');
    await cp(root, renamed, { recursive: true });
    const report = await doctorProject(renamed, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings.map((item) => item.code)).toEqual(['project-folder-renamed']);
    expect(report.findings[0]?.message).toContain('«maestro-fixture»');
    expect(report.findings[0]?.message).toContain('«другое-имя»');
  });
});

describe('находки независимого ревью beta.4', () => {
  it('create не меняет версию проекта беты: ни файлы, ни manifest', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const before = await snapshotTree(root);
    const result = await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Create не обновляет проекты');
    expect(result.error).toContain('vibe-maestro upgrade --path');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('правка с подстановкой в файле, который upgrade не трогает, не блокирует обновление', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const index = await readUtf8(root, 'wiki/index.md');
    expect(index).toContain('Проект фикстуры');
    const edited = index.split('Проект фикстуры').join('Другое имя');
    await writeFile(join(root, 'wiki/index.md'), edited, 'utf8');
    const result = await upgradeProject(root, { apply: true });
    expect(result.analysis.blockers).toEqual([]);
    expect(result.applied).toBe(true);
    expect(await readUtf8(root, 'wiki/index.md')).toBe(edited);
    // Подстановка для обновлённых файлов берётся из них самих, а не из правки.
    expect(await readUtf8(root, 'CLAUDE.md')).toContain('# Проект фикстуры');
  });

  it('неудавшийся откат честно назван неудавшимся, и backup остаётся на диске', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    let calls = 0;
    const result = await upgradeProject(root, {
      apply: true,
      hooks: {
        beforeCommit: async (path) => {
          calls += 1;
          if (path === '.maestro/checksums.json') {
            // Имитация того, что backup уже опубликованного пути потерян (на Windows — блокировка файла).
            await rm(join(root, STAGING_DIR, 'backup', 'protocols', 'plan.md'), { force: true });
            throw new Error(`сбой на ${path} (вызов ${calls})`);
          }
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toContain('откатить удалось не всё');
    expect(result.error).toContain('protocols/plan.md');
    expect(existsSync(join(root, STAGING_DIR, 'backup'))).toBe(true);
  });

  it('doctor на проекте прошлого канона всё равно видит подмену файлов и проблемы Git', async () => {
    const legacy = await makeLegacy02Project();
    await writeFile(join(legacy.root, 'protocols/seams.md'), 'подмена\n', 'utf8');
    const report = await doctorProject(legacy.root);
    const codes = report.findings.map((item) => item.code);
    expect(codes).toContain('project-outdated');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'managed-modified', path: 'protocols/seams.md' }));
  });

  it('путь в другом регистре на файловой системе без учёта регистра не считается чужой папкой', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const shouted = join(dirname(root), 'MAESTRO-FIXTURE');
    if (!existsSync(shouted)) return; // файловая система различает регистр — случая нет
    const report = await doctorProject(shouted);
    expect(report.findings.map((item) => item.code)).not.toContain('manifest-canonical-mismatch');
    const { analysis } = await analyzeUpgrade(shouted);
    expect(analysis.blockers.map((item) => item.code)).not.toContain('upgrade-manifest-not-native');
  });
});

describe('upgrade с опубликованного 0.4.1 на текущую версию', () => {
  /** Всё, что upgrade с 0.4.1 переписывает на нетронутом проекте: закреплённая версия и тексты старта. */
  const UPDATED_FROM_041 = union(['.claude/commands/build.md', '.claude/rules/maestro.md', 'protocols/build.md', 'protocols/completion.md', 'protocols/handoff.md', 'protocols/plan.md'], UPDATED_IN_043_SINCE_030);

  it.each(FIXTURES_041)('%s: dry-run ни байта не пишет и называет старт, правило для материалов, restore и README', async (id) => {
    const { root } = await materialize(id);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.fromVersion).toBe('0.4.1');
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(NEW_SINCE_041);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_FROM_041);
    expect(analysis.removes).toEqual(REMOVED_IN_043);
    for (const path of ['wiki/hot.md', 'wiki/plans/0001-starter.md', 'wiki/concepts/discovery.md', '.claude/rules/project.md', '.claude/settings.json', 'wiki/passport.md']) {
      expect(analysis.preserves, path).toContain(path);
    }
    expect(analysis.notes).toEqual([]);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(FIXTURES_041)('%s: --apply даёт канон текущей версии, файлы проекта не тронуты, doctor --strict зелёный', async (id) => {
    const { root, data } = await materialize(id);
    const owned = ['wiki/hot.md', 'wiki/plans/0001-starter.md', 'wiki/concepts/discovery.md', '.claude/rules/project.md', '.claude/settings.json', 'wiki/passport.md'];
    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    for (const path of owned) expect(await readUtf8(root, path), path).toBe(data.files[path]);
    expect(await readUtf8(root, 'maestro/inbox/.gitattributes')).toBe('* -text\n');
    expect(await readUtf8(root, 'protocols/start.md')).toContain(`create-vibe-maestro@${VERSION} vibe-maestro sources`);
    expect(await readUtf8(root, 'wiki/restore.md')).toContain('# Как восстановить проект на новом компьютере');
    expect(await readUtf8(root, 'README.md')).toContain('Этот файл видят первым');
    // Канон текущей версии: тот же manifest и те же суммы, что у нового проекта этой глубины.
    const fresh = join(await makeTempDir('fresh-041-'), data.folder);
    expect((await initProject({ target: fresh, name: 'Проект фикстуры', startingPoint: 'idea', depth: data.depth, git: false, now: FIXED_NOW })).ok).toBe(true);
    expect((await loadManifest(root)).inventory).toEqual((await loadManifest(fresh)).inventory);
    // Суммы — тот же набор путей; содержимое с датой создания проекта у фикстуры своё.
    expect(Object.keys((await loadChecksums(root))?.files ?? {}).sort()).toEqual(Object.keys((await loadChecksums(fresh))?.files ?? {}).sort());
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await analyzeUpgrade(root)).analysis.status).toBe('current');
  });

  it.each(['README.md', 'readme.md', 'README.rst', 'Readme'])('свой %s: второй README не появляется, свой — байт в байт', async (name) => {
    const { root } = await materialize('0.4.1-standard');
    const own = Buffer.from('# Мой проект\r\nСвой текст без перевода строки в конце', 'utf8');
    await writeFile(join(root, name), own);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.creates.map((item) => item.path)).not.toContain('README.md');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((entry) => /^readme/i.test(entry))).toEqual([name]);
    expect((await readFile(join(root, name))).equals(own)).toBe(true);
  });

  it('свой wiki/restore.md остаётся байт в байт', async () => {
    const { root } = await materialize('0.4.1-standard');
    const own = Buffer.from('# Восстановление\r\nУ нас свой порядок.\r\n', 'utf8');
    await writeFile(join(root, 'wiki/restore.md'), own);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.creates.map((item) => item.path)).not.toContain('wiki/restore.md');
    expect(analysis.preserves).toContain('wiki/restore.md');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect((await readFile(join(root, 'wiki/restore.md'))).equals(own)).toBe(true);
  });

  it('материалы в maestro/inbox/ не мешают обновлению, остаются на месте, а предложение предупреждает о переносах строк', async () => {
    const { root } = await materialize('0.4.1-standard');
    const brief = Buffer.from('Бриф\r\nзаказчика\r\n', 'utf8');
    await writeFile(join(root, 'maestro/inbox/бриф.txt'), brief);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.notes.join('\n')).toContain('git add --renormalize maestro/inbox');
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('Важно: Материалы, которые уже лежат в maestro/inbox/, git сам не перепишет');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect((await readFile(join(root, 'maestro/inbox/бриф.txt'))).equals(brief)).toBe(true);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('своя команда /start: понятная остановка с советом переименовать, ни байта не записано (ревью M4)', async () => {
    const { root } = await materialize('0.4.1-standard');
    await mkdir(join(root, '.claude/commands'), { recursive: true });
    await writeFile(join(root, '.claude/commands/start.md'), 'Моя команда старта.\n', 'utf8');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toEqual([expect.objectContaining({ code: 'upgrade-command-collision', path: '.claude/commands/start.md' })]);
    expect(result.analysis.blockers[0]?.message).toContain('переименуйте свою');
    expect(result.analysis.blockers[0]?.message).toContain('my-start.md');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('уже лежащий maestro/inbox/.gitattributes, побайтово как у Maestro, принимается; чужой — понятная остановка', async () => {
    const { root } = await materialize('0.4.1-standard');
    await writeFile(join(root, 'maestro/inbox/.gitattributes'), '* -text\n', 'utf8');
    const same = await analyzeUpgrade(root);
    expect(same.analysis.blockers).toEqual([]);
    expect(same.analysis.creates.map((item) => item.path)).not.toContain('maestro/inbox/.gitattributes');
    expect(same.analysis.unchanged).toContain('maestro/inbox/.gitattributes');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect((await loadChecksums(root))?.files['maestro/inbox/.gitattributes']).toMatch(/^[0-9a-f]{64}$/);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);

    const { root: other } = await materialize('0.4.1-standard');
    await writeFile(join(other, 'maestro/inbox/.gitattributes'), '*.pdf binary\n', 'utf8');
    const before = await snapshotTree(other);
    const foreign = await upgradeProject(other, { apply: true });
    expect(foreign.ok).toBe(false);
    expect(foreign.analysis.blockers).toEqual([expect.objectContaining({ code: 'upgrade-inbox-gitattributes-foreign', path: 'maestro/inbox/.gitattributes' })]);
    expect(foreign.analysis.blockers[0]?.message).toContain('уберите или переименуйте');
    // Ревью M3: совет не ведёт к правке корневого .gitattributes — это файл Maestro, doctor бы покраснел.
    expect(foreign.analysis.blockers[0]?.message).toContain('подпапки внутри maestro/inbox/');
    expect(foreign.analysis.blockers[0]?.message).toContain('Корневой .gitattributes не правьте');
    expect(await snapshotTree(other)).toEqual(before);
  });

  // Ревью L9: ветку README_SINCE этот тест не проходит — обновить проект 0.4.2 пока нечем.
  // Он проверяет только, что удалённый README не делает проект «устаревшим» и не красит doctor.
  it('проект 0.4.2 без README: upgrade говорит «обновлять нечего», doctor --strict без замечаний', async () => {
    const target = join(await makeTempDir('readme-gone-'), 'проект');
    expect((await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await rm(join(target, 'README.md'));
    expect((await analyzeUpgrade(target)).analysis.status).toBe('current');
    expect((await doctorProject(target, { strict: true })).findings).toEqual([]);
  });

  it('настоящий git: после upgrade и git add --renormalize свежий клон отдаёт исходные байты материала', async () => {
    const { root } = await materialize('0.4.1-standard');
    const run = async (cwd: string, ...args: string[]): Promise<string> => (await execFileAsync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })).stdout;
    await run(root, 'init', '-q', '-b', 'main');
    const brief = Buffer.from('строка один\r\nстрока два\r\n', 'utf8');
    await writeFile(join(root, 'maestro/inbox/бриф.txt'), brief);
    await run(root, 'add', '-A');
    await run(root, 'commit', '-q', '-m', '0.4.1 с материалом');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    // Совет из предложения upgrade: git переписывает уже известный файл по новому правилу только явно.
    await run(root, 'add', '--renormalize', 'maestro/inbox');
    expect(await run(root, 'diff', '--cached', '--name-only', '-z', '--', 'maestro/inbox/')).toContain('.txt');
    await run(root, 'add', '-A');
    await run(root, 'commit', '-q', '-m', 'Maestro 0.4.2');
    const clone = join(await makeTempDir('clone-'), 'клон');
    await run(root, 'clone', '-q', root, clone);
    expect((await readFile(join(clone, 'maestro/inbox/бриф.txt'))).equals(brief)).toBe(true);
  });
});

describe('upgrade с опубликованного 0.4.2 на текущую версию', () => {
  /** Всё, что upgrade с 0.4.2 переписывает на нетронутом проекте: изменения 0.4.3 и закреплённая версия в командах. */
  const UPDATED_FROM_042 = [
    '.claude/agents/code-reviewer.md', '.claude/commands/build.md', '.claude/rules/maestro.md', 'maestro/runbooks/cowork-audit.md', 'maestro/templates/handoff.md',
    'protocols/audit.md', 'protocols/build.md', 'protocols/completion.md', 'protocols/handoff.md', 'protocols/plan.md', 'protocols/start.md', 'protocols/wiki.md',
    'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md',
  ];
  const OWNED = ['wiki/hot.md', 'wiki/index.md', 'wiki/plans/0001-starter.md', 'wiki/concepts/discovery.md', '.claude/rules/project.md', '.claude/settings.json', 'wiki/passport.md', 'wiki/restore.md', 'README.md'];

  it.each(FIXTURES_042)('%s: dry-run и --diff ни байта не пишут; удаляются 10 протоколов, приходят образец отчёта и Icebox', async (id) => {
    const { root } = await materialize(id);
    const before = await snapshotTree(root);
    const { analysis } = await analyzeUpgrade(root);
    expect(analysis.blockers).toEqual([]);
    expect(analysis.fromVersion).toBe('0.4.2');
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(NEW_IN_043);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_FROM_042);
    expect(analysis.removes).toEqual(REMOVED_IN_043);
    // README.md не в составе Maestro: upgrade его не называет и не трогает (проверено ниже, при --apply).
    for (const path of OWNED.filter((item) => item !== 'README.md')) expect(analysis.preserves, path).toContain(path);
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', root, '--diff'], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('=== Будет удалено: protocols/seams.md');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it.each(FIXTURES_042)('%s: --apply даёт канон текущей версии, файлы проекта не тронуты, doctor --strict зелёный', async (id) => {
    const { root, data } = await materialize(id);
    const result = await upgradeProject(root, { apply: true });
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(true);
    for (const path of OWNED) expect(await readUtf8(root, path), path).toBe(data.files[path]);
    for (const path of REMOVED_IN_043) expect(existsSync(join(root, path)), path).toBe(false);
    expect(existsSync(join(root, 'protocols/build'))).toBe(false);
    expect(await readUtf8(root, 'maestro/templates/audit.md')).toContain('## Finding AUD-YYYY-MM-DD-slug-F001');
    expect(await readUtf8(root, 'wiki/icebox.md')).toContain('# Icebox');
    const fresh = join(await makeTempDir('fresh-042-'), data.folder);
    expect((await initProject({ target: fresh, name: 'Проект фикстуры', startingPoint: 'idea', depth: data.depth, git: false, now: FIXED_NOW })).ok).toBe(true);
    expect((await loadManifest(root)).inventory).toEqual((await loadManifest(fresh)).inventory);
    expect(Object.keys((await loadChecksums(root))?.files ?? {}).sort()).toEqual(Object.keys((await loadChecksums(fresh))?.files ?? {}).sort());
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await analyzeUpgrade(root)).analysis.status).toBe('current');
  });

  it('свой maestro/templates/audit.md: понятная остановка с советом переименовать, ни байта не записано', async () => {
    const { root } = await materialize('0.4.2-standard');
    await writeFile(join(root, 'maestro/templates/audit.md'), '# Мой образец отчёта\n', 'utf8');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toEqual([expect.objectContaining({ code: 'upgrade-template-collision', path: 'maestro/templates/audit.md' })]);
    expect(result.analysis.blockers[0]?.message).toContain('переименуйте свой');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('утверждённый план с отпечатком 0.4.2 после upgrade остаётся зелёным', async () => {
    const { root } = await materialize('0.4.2-standard');
    const { legacyPlanBodyDigest } = await import('../src/core/plan.js');
    const path = 'wiki/plans/0001-starter.md';
    let text = await readUtf8(root, path);
    text = text.replace(/^status: .*$/m, 'status: approved').replace(/^approved_by: .*$/m, 'approved_by: Человек').replace(/^approved_at: .*$/m, 'approved_at: 2026-11-01')
      .replace(/^blocking_questions: .*$/m, 'blocking_questions: 0').replace(/^current_slice: .*$/m, 'current_slice: 01-start')
      .replace('1. Пройти `/start` — знакомство с задачей.', '- [x] Пройти `/start` — знакомство с задачей.');
    text = text.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${legacyPlanBodyDigest(text)}`);
    await writeFile(join(root, path), text, 'utf8');
    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0001-starter.md'), 'utf8');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    const cli = collect();
    expect(await runMaestroCli(['preflight', '--path', root], cli.io)).toBe(0);
  });
});
