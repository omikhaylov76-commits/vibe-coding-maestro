import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { canonicalManagedSource, makeLegacy02Project } from './legacy-0.2.js';

afterEach(cleanupTempDirs);

const DEPTHS: readonly ProjectDepth[] = ['light', 'standard', 'advanced'];

/** Managed-файлы, в которых beta.4 закрепляет версию вместо `@latest`. */
const PINNED_PATHS = ['.claude/commands/build.md', 'AGENTS.md', 'CLAUDE.md', 'protocols/build.md', 'protocols/plan.md'];

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
const FIXTURES = ['0.3.0-beta.2-standard', '0.3.0-beta.3-light', '0.3.0-beta.3-standard', '0.3.0-beta.3-advanced'];

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
        if (sha256(await canonicalManagedSource(path)) !== hash) changed.push(path);
      }
      expect(release.templates.map((template) => template.path).sort(), release.id).toEqual(changed.sort());
      for (const template of release.templates) {
        const source = (await readFile(join(packageRoot(), template.source), 'utf8')).replace(/\r\n/g, '\n');
        expect(sha256(source), `${release.id}: ${template.source}`).toBe(template.sha256);
        expect(template.sha256, `${release.id}: ${template.path}`).toBe(release.managedSha256[template.path]);
      }
    }
  });

  it.each(FIXTURES)('слепок реестра совпадает с проектом, который записал опубликованный пакет (%s)', async (id) => {
    const data = await fixture(id);
    const release = findRelease(data.version);
    expect(release).toBeDefined();
    if (release === undefined) return;
    const manifest = JSON.parse(data.files[MANIFEST_PATH] as string) as { inventory: { path: string; ownership: string }[] };
    expect(Object.fromEntries(manifest.inventory.map((entry) => [entry.path, entry.ownership]))).toEqual(release.inventory(data.depth));

    const copies = new Map(release.templates.map((template) => [template.path, template.source]));
    for (const path of Object.keys(release.managedSha256)) {
      const copy = copies.get(path);
      const source = copy === undefined
        ? await canonicalManagedSource(path)
        : (await readFile(join(packageRoot(), copy), 'utf8')).replace(/\r\n/g, '\n');
      const rendered = path === '.gitattributes'
        ? source
        : renderTemplate(source, { projectName: 'Проект фикстуры', date: '2026-10-31', startingPoint: 'idea', version: data.version });
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
    expect(analysis.creates).toEqual([]);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(PINNED_PATHS);
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
    expect(result.updatedFiles.filter((path) => !path.startsWith('.maestro/')).sort()).toEqual(PINNED_PATHS);

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

  it('контрольные суммы обновлённых файлов пересчитаны, остальные не тронуты', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const before = (await loadChecksums(root))?.files ?? {};
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const after = (await loadChecksums(root))?.files ?? {};
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const path of Object.keys(before)) {
      if (PINNED_PATHS.includes(path)) expect(after[path], path).not.toBe(before[path]);
      else expect(after[path], path).toBe(before[path]);
    }
  });

  it('изменённый вручную файл с версией блокирует весь upgrade и ничего не пишет', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    await writeFile(join(root, 'CLAUDE.md'), `${await readUtf8(root, 'CLAUDE.md')}\nМоя строка.\n`, 'utf8');
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toContainEqual(expect.objectContaining({ code: 'upgrade-managed-modified', path: 'CLAUDE.md' }));
    expect(result.analysis.blockers[0]?.message).toContain('0.3.0-beta.3');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('правка в файле, который upgrade не трогает, его не блокирует и сохраняется', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const edited = `${await readUtf8(root, 'protocols/seams.md')}\nЛокальная заметка.\n`;
    await writeFile(join(root, 'protocols/seams.md'), edited, 'utf8');
    const result = await upgradeProject(root, { apply: true });
    expect(result.applied).toBe(true);
    expect(await readUtf8(root, 'protocols/seams.md')).toBe(edited);
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

describe('doctor и версия проекта', () => {
  it('проект беты с тем же составом файлов зелёный и получает подсказку об upgrade', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings.map((item) => item.code)).toEqual(['project-version-older']);
    expect(report.findings[0]?.level).toBe('info');
    expect(report.findings[0]?.message).toContain(`npx --package create-vibe-maestro@${VERSION} vibe-maestro upgrade --path ${quotePathArg(root)}`);

    const cli = collect();
    expect(await runMaestroCli(['doctor', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('project-version-older');
  });

  it('проект более новой версии с другим составом файлов — одна понятная находка', async () => {
    const target = join(await makeTempDir('newer-'), 'новее');
    expect((await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    const manifest = await loadManifest(target);
    manifest.product.version = '9.0.0';
    manifest.inventory = manifest.inventory.filter((entry) => entry.path !== 'protocols/seams.md');
    manifest.managed = manifest.managed.filter((entry) => entry.path !== 'protocols/seams.md');
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

  it('переименованная папка: сообщение называет оба имени', async () => {
    const { root } = await materialize('0.3.0-beta.3-standard');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    const renamed = join(dirname(root), 'другое-имя');
    await cp(root, renamed, { recursive: true });
    const report = await doctorProject(renamed);
    const finding = report.findings.find((item) => item.code === 'manifest-canonical-mismatch');
    expect(finding?.message).toContain('«maestro-fixture»');
    expect(finding?.message).toContain('«другое-имя»');
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
          if (calls === 3) {
            // Имитация того, что backup первого пути потерян (на Windows — блокировка файла).
            await rm(join(root, STAGING_DIR, 'backup', 'CLAUDE.md'), { force: true });
            throw new Error(`сбой на ${path}`);
          }
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(result.error).toContain('откатить удалось не всё');
    expect(result.error).toContain('CLAUDE.md');
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
