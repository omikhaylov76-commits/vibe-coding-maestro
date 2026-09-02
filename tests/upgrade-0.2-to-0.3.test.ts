import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import { renderTemplate } from '../src/core/template.js';
import { isCanonicalManifest, loadChecksums, loadManifest, MANIFEST_PATH } from '../src/core/manifest.js';
import { VERSION } from '../src/core/meta.js';
import { packageRoot } from '../src/core/paths.js';
import { analyzeUpgrade, STAGING_DIR, upgradeProject } from '../src/core/upgrade/index.js';
import {
  BASELINE_MANAGED_SHA256,
  BASELINE_TEMPLATE_FILES,
  BASELINE_TEMPLATES,
  baselineOwnershipInventory,
} from '../src/core/upgrade/baseline.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, sha256, snapshotTree } from './helpers.js';
import { baseline02Source, canonicalManagedSource, makeLegacy02Project } from './legacy-0.2.js';

const execFileAsync = promisify(execFile);

afterEach(cleanupTempDirs);

/** Пути, которых в каноне 0.2 не было. */
const NEW_PATHS = [
  '.claude/commands/plan.md',
  'maestro/runbooks/cowork-plan.md',
  'protocols/plan.md',
  'wiki/plans/0001-starter.md',
  'wiki/plans/README.md',
  'wiki/plans/TEMPLATE.md',
];

/** Managed-файлы, содержимое которых 0.3 обновляет. */
const UPDATED_PATHS = ['.claude/commands/build.md', 'AGENTS.md', 'CLAUDE.md', 'protocols/build.md', 'wiki/index.md'];

const codes = (blockers: readonly { code: string }[]): string[] => blockers.map((item) => item.code);

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

/**
 * Опора этой группы — `BASELINE_MANAGED_SHA256`, слепок фактического 0.2-дерева.
 * Он снят с коммита 0.2 и не выводится из `BASELINE_TEMPLATES`, поэтому вопрос
 * «что именно 0.3 изменил» задаётся прошлому, а не самому проверяемому списку.
 */
describe('0.3 Phase 3: baseline 0.2 не дрейфует', () => {
  it('слепок 0.2 покрывает весь managed-инвентарь того канона', () => {
    expect(Object.keys(BASELINE_MANAGED_SHA256).sort()).toEqual([...BASELINE_TEMPLATE_FILES].sort());
  });

  it('BASELINE_TEMPLATES перечисляет ровно те managed-пути, чьё содержимое 0.3 изменил', async () => {
    const changed: string[] = [];
    for (const path of BASELINE_TEMPLATE_FILES) {
      if (sha256(await canonicalManagedSource(path)) !== BASELINE_MANAGED_SHA256[path]) changed.push(path);
    }
    expect(changed.sort()).toEqual(BASELINE_TEMPLATES.map((template) => template.path).sort());
  });

  it('baseline-копия каждого пути совпадает и со своей записью, и со слепком 0.2', async () => {
    for (const template of BASELINE_TEMPLATES) {
      const source = (await readFile(join(packageRoot(), template.source), 'utf8')).replace(/\r\n/g, '\n');
      expect(sha256(source), template.path).toBe(template.sha256);
      expect(template.sha256, template.path).toBe(BASELINE_MANAGED_SHA256[template.path]);
      // Копия обязана быть именно прошлым содержимым, а не текущим шаблоном.
      expect(source, template.path).not.toBe(await canonicalManagedSource(template.path));
    }
  });

  it('фикстура 0.2 отдаёт прошлое содержимое каждого managed-пути', async () => {
    const legacy = await makeLegacy02Project();
    const vars = { projectName: legacy.displayName, date: legacy.date, startingPoint: legacy.startingPoint };
    for (const path of BASELINE_TEMPLATE_FILES) {
      expect(await readUtf8(legacy.root, path), path).toBe(renderTemplate(await baseline02Source(path), vars));
    }
  });
});

describe('0.3 Phase 3: воспроизведение дефекта на проекте 0.2', () => {
  it('канонический проект 0.2 считается текущим бинарником неканоническим', async () => {
    const legacy = await makeLegacy02Project();
    const manifest = await loadManifest(legacy.root);

    // Manifest сам по себе валиден и точно повторяет форму 0.2.
    expect(manifest.inventory.map((entry) => entry.path).sort())
      .toEqual(Object.keys(baselineOwnershipInventory(legacy.depth)).sort());
    expect(isCanonicalManifest(manifest)).toBe(false);

    const report = await doctorProject(legacy.root, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toContain('manifest-canonical-mismatch');
    expect(report.findings.some((finding) => finding.code === 'manifest-inventory-mismatch')).toBe(true);
  });

  it('create --force отказывается достраивать проект 0.2', async () => {
    const legacy = await makeLegacy02Project();
    const before = await snapshotTree(legacy.root);
    const result = await initProject({ target: legacy.root, startingPoint: 'idea', force: true, git: false, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('не является каноническим проектом');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });
});

describe('0.3 Phase 3: analyzer не пишет ни байта', () => {
  it('предлагает точный upgrade и оставляет дерево неизменным', async () => {
    const legacy = await makeLegacy02Project();
    const before = await snapshotTree(legacy.root);

    const { analysis } = await analyzeUpgrade(legacy.root);
    expect(analysis.status).toBe('upgradable');
    expect(analysis.blockers).toEqual([]);
    expect(analysis.creates.map((item) => item.path).sort()).toEqual(NEW_PATHS);
    expect(analysis.updates.map((item) => item.path).sort()).toEqual(UPDATED_PATHS);
    expect(analysis.preserves).toContain('wiki/hot.md');
    expect(analysis.preserves).toContain('.gitignore');
    expect(analysis.toVersion).toBe(VERSION);

    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('dry-run через CLI ничего не записывает и подсказывает --apply', async () => {
    const legacy = await makeLegacy02Project();
    const before = await snapshotTree(legacy.root);
    const cli = collect();

    expect(await runMaestroCli(['upgrade', '--path', legacy.root], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('ни один байт не записан');
    expect(cli.stdout()).toContain('upgrade --path');
    expect(cli.stdout()).toContain('--apply');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('project-owned и незнакомые файлы в предложении не значатся', async () => {
    const legacy = await makeLegacy02Project();
    await writeFile(join(legacy.root, 'wiki/concepts/своё.md'), '---\ntype: note\n---\n\n# Своё\n', 'utf8');
    const { analysis, writes } = await analyzeUpgrade(legacy.root);
    const touched = writes.map((write) => write.path);
    expect(touched).not.toContain('wiki/hot.md');
    expect(touched).not.toContain('wiki/concepts/своё.md');
    expect(touched).not.toContain('.gitignore');
    expect(analysis.metadata).toEqual(['.maestro/manifest.json', '.maestro/checksums.json']);
  });
});

describe('0.3 Phase 3: применение upgrade', () => {
  it('обновляет канон, сохраняет проектные файлы и делает doctor --strict зелёным', async () => {
    const legacy = await makeLegacy02Project();
    const preserved: Record<string, string> = {};
    for (const path of ['wiki/hot.md', 'wiki/log.md', 'wiki/roadmap.md', 'wiki/concepts/discovery.md', '.gitignore']) {
      preserved[path] = await readUtf8(legacy.root, path);
    }
    await writeFile(join(legacy.root, 'ЧИТАЙ.md'), 'файл пользователя\n', 'utf8');

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok, result.error).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.createdFiles.sort()).toEqual(NEW_PATHS);
    expect(result.updatedFiles.sort()).toEqual([...UPDATED_PATHS, '.maestro/checksums.json', '.maestro/manifest.json'].sort());

    for (const path of NEW_PATHS) expect(existsSync(join(legacy.root, path)), path).toBe(true);
    for (const [path, content] of Object.entries(preserved)) {
      expect(await readUtf8(legacy.root, path), path).toBe(content);
    }
    expect(await readUtf8(legacy.root, 'ЧИТАЙ.md')).toBe('файл пользователя\n');
    expect(await readUtf8(legacy.root, 'wiki/hot.md')).not.toContain('active_plan');
    expect(existsSync(join(legacy.root, STAGING_DIR))).toBe(false);

    const report = await doctorProject(legacy.root, { strict: true });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('переносит идентичность проекта и переводит manifest в текущий канон', async () => {
    const legacy = await makeLegacy02Project();
    const before = await loadManifest(legacy.root);
    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);

    const after = await loadManifest(legacy.root);
    expect(after.project.id).toBe(before.project.id);
    expect(after.project.createdAt).toBe(before.project.createdAt);
    expect(after.project.name).toBe(before.project.name);
    expect(after.project.startingPoint).toBe(before.project.startingPoint);
    expect(after.project.depth).toBe(before.project.depth);
    expect(after.product.version).toBe(VERSION);
    expect(isCanonicalManifest(after)).toBe(true);
    expect(after.inventory.map((entry) => entry.path).sort())
      .toEqual(Object.keys(canonicalOwnershipInventory(legacy.depth)).sort());

    const checksums = await loadChecksums(legacy.root);
    for (const path of [...NEW_PATHS.filter((item) => item !== 'wiki/plans/0001-starter.md'), ...UPDATED_PATHS]) {
      expect(checksums?.files[path], path).toMatch(/^[0-9a-f]{64}$/);
    }
    // project-owned стартовый план контрольной суммы Maestro не получает.
    expect(checksums?.files['wiki/plans/0001-starter.md']).toBeUndefined();
  });

  it('сохраняет подстановки проекта в добавленных и обновлённых файлах', async () => {
    const legacy = await makeLegacy02Project({ displayName: 'Проект «Мой Сад» 2.0', folder: 'my garden' });
    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);

    expect(await readUtf8(legacy.root, 'CLAUDE.md')).toContain('Проект «Мой Сад» 2.0');
    expect(await readUtf8(legacy.root, 'wiki/index.md')).toContain('Проект «Мой Сад» 2.0');
    expect(await readUtf8(legacy.root, 'wiki/plans/0001-starter.md')).toContain('Проект «Мой Сад» 2.0');
    expect(await readUtf8(legacy.root, 'wiki/index.md')).toContain(`updated: ${legacy.date}`);
    expect((await doctorProject(legacy.root, { strict: true })).findings).toEqual([]);
  });

  it('повторный upgrade сообщает, что проект уже канонический, и ничего не пишет', async () => {
    const legacy = await makeLegacy02Project();
    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);
    const after = await snapshotTree(legacy.root);

    const repeat = await upgradeProject(legacy.root, { apply: true });
    expect(repeat.analysis.status).toBe('current');
    expect(repeat.applied).toBe(false);
    expect(await snapshotTree(legacy.root)).toEqual(after);
  });

  it('после upgrade повторный init ничего не меняет', async () => {
    const legacy = await makeLegacy02Project();
    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);
    const after = await snapshotTree(legacy.root);

    const result = await initProject({ target: legacy.root, startingPoint: 'idea', force: true, git: false, now: FIXED_NOW });
    expect(result.ok, result.error).toBe(true);
    expect(await snapshotTree(legacy.root)).toEqual(after);
  });

  it('не трогает Git-историю и добавляет только ожидаемые пути', async () => {
    const legacy = await makeLegacy02Project({ git: true, folder: 'git-legacy' });
    const git = async (...args: string[]): Promise<string> =>
      (await execFileAsync('git', args, { cwd: legacy.root })).stdout.trim();
    // Реконструкция 0.2 выполняется поверх созданного коммита; фиксируем её как baseline.
    await git('add', '-A');
    await git('-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'baseline 0.2');
    const head = await git('rev-parse', 'HEAD');
    const log = await git('log', '--format=%H');

    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);

    expect(await git('rev-parse', 'HEAD')).toBe(head);
    expect(await git('log', '--format=%H')).toBe(log);
    // Без trim: у порцелана значимы ведущие пробелы кода состояния.
    const raw = (await execFileAsync('git', ['status', '--porcelain', '-uall'], { cwd: legacy.root })).stdout;
    const status = raw.split('\n').filter((line) => line !== '').map((line) => line.slice(3).replace(/"/g, ''));
    expect(status.sort()).toEqual([...NEW_PATHS, ...UPDATED_PATHS, '.maestro/checksums.json', '.maestro/manifest.json'].sort());
  });
});

describe('0.3 Phase 3: upgrade authority', () => {
  it('произвольная непустая папка отвергается без единой записи', async () => {
    const dir = await makeTempDir('foreign-');
    await writeFile(join(dir, 'README.md'), '# чужой проект\n', 'utf8');
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src/main.ts'), 'export const x = 1;\n', 'utf8');
    const before = await snapshotTree(dir);

    const result = await upgradeProject(dir, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-not-canonical');
    expect(await snapshotTree(dir)).toEqual(before);
  });

  it('пустая папка отвергается без единой записи', async () => {
    const dir = await makeTempDir('empty-');
    const result = await upgradeProject(dir, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-not-canonical');
    expect(await snapshotTree(dir)).toEqual({});
  });

  it('скопированный manifest не даёт upgrade authority неполной папке', async () => {
    const legacy = await makeLegacy02Project({ folder: 'источник' });
    const parent = await makeTempDir('forged-');
    const fake = join(parent, 'источник');
    await mkdir(join(fake, '.maestro'), { recursive: true });
    await cp(join(legacy.root, MANIFEST_PATH), join(fake, MANIFEST_PATH));
    await writeFile(join(fake, 'CLAUDE.md'), 'подделка\n', 'utf8');
    const before = await snapshotTree(fake);

    const result = await upgradeProject(fake, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-incomplete-tree');
    expect(await snapshotTree(fake)).toEqual(before);
  });

  it('полный, но перенесённый в чужую папку проект отвергается', async () => {
    const legacy = await makeLegacy02Project({ folder: 'исходный' });
    const parent = await makeTempDir('moved-');
    const moved = join(parent, 'другое-имя');
    await cp(legacy.root, moved, { recursive: true });
    const before = await snapshotTree(moved);

    const result = await upgradeProject(moved, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-manifest-not-native');
    expect(await snapshotTree(moved)).toEqual(before);
  });

  it('придуманная форма inventory не выдаётся за известного предшественника', async () => {
    const legacy = await makeLegacy02Project();
    const manifest = await loadManifest(legacy.root);
    manifest.inventory = manifest.inventory.filter((entry) => entry.path !== 'protocols/seams.md');
    manifest.managed = manifest.managed.filter((entry) => entry.path !== 'protocols/seams.md');
    await writeFile(join(legacy.root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-unsupported-baseline');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('чужой продукт в manifest не получает upgrade', async () => {
    const legacy = await makeLegacy02Project();
    const manifest = await loadManifest(legacy.root);
    manifest.product.createdBy = 'другой-инструмент';
    await writeFile(join(legacy.root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-foreign-manifest');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });
});

describe('0.3 Phase 3: конфликты блокируют весь upgrade', () => {
  it.each(UPDATED_PATHS)('изменённый managed-файл %s не перезаписывается', async (path) => {
    const legacy = await makeLegacy02Project();
    await writeFile(join(legacy.root, path), `${await readUtf8(legacy.root, path)}\nМоя строка.\n`, 'utf8');
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toContainEqual(expect.objectContaining({ code: 'upgrade-managed-modified', path }));
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('противоречивая контрольная сумма блокирует запись', async () => {
    const legacy = await makeLegacy02Project();
    const checksums = JSON.parse(await readFile(join(legacy.root, '.maestro/checksums.json'), 'utf8')) as { files: Record<string, string> };
    checksums.files['CLAUDE.md'] = 'f'.repeat(64);
    await writeFile(join(legacy.root, '.maestro/checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`, 'utf8');
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-checksum-mismatch');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it.each(['wiki/plans/README.md', 'protocols/plan.md'])('занятый новый путь %s блокирует весь upgrade', async (path) => {
    const legacy = await makeLegacy02Project();
    await mkdir(join(legacy.root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    await writeFile(join(legacy.root, path), 'мой файл\n', 'utf8');
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.analysis.blockers).toContainEqual(expect.objectContaining({ code: 'upgrade-path-collision', path }));
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('каталог на месте нового файла тоже конфликт', async () => {
    const legacy = await makeLegacy02Project();
    await mkdir(join(legacy.root, 'protocols/plan.md'), { recursive: true });
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-path-collision');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });

  it('оставшийся каталог транзакции требует ручного разбора', async () => {
    const legacy = await makeLegacy02Project();
    await mkdir(join(legacy.root, STAGING_DIR), { recursive: true });
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-staging-present');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });
});

describe('0.3 Phase 3: транзакция и откат', () => {
  it('сбой в середине публикации возвращает проект в исходное состояние', async () => {
    const legacy = await makeLegacy02Project();
    const before = await snapshotTree(legacy.root);

    let published = 0;
    const result = await upgradeProject(legacy.root, {
      apply: true,
      hooks: {
        beforeCommit: async () => {
          published += 1;
          if (published === 4) throw new Error('внезапный сбой файловой системы');
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(result.error).toContain('откачено');
    expect(await snapshotTree(legacy.root)).toEqual(before);
    expect(existsSync(join(legacy.root, STAGING_DIR))).toBe(false);
    expect(existsSync(join(legacy.root, 'wiki/plans'))).toBe(false);
  });

  it('сбой на последнем шаге тоже не оставляет половинчатого состояния', async () => {
    const legacy = await makeLegacy02Project();
    const before = await snapshotTree(legacy.root);
    const total = (await analyzeUpgrade(legacy.root)).writes.length;

    let published = 0;
    const result = await upgradeProject(legacy.root, {
      apply: true,
      hooks: {
        beforeCommit: async () => {
          published += 1;
          if (published === total) throw new Error('сбой на последнем шаге');
        },
      },
    });

    expect(result.rolledBack).toBe(true);
    expect(await snapshotTree(legacy.root)).toEqual(before);
    expect((await loadManifest(legacy.root)).product.version).toBe('0.2.0-beta.1');
  });
});

describe('0.3 Phase 3: пути и переводы строк разных ОС', () => {
  it.each([
    ['путь с пробелами', 'проект с пробелами'],
    ['не-ASCII имя', 'проект-日本語-ñ'],
    ['имя с точкой', 'my.project.v2'],
  ])('%s обновляется полностью', async (_title, folder) => {
    const legacy = await makeLegacy02Project({ folder, displayName: `Проект ${folder}` });
    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok, result.error).toBe(true);
    expect((await doctorProject(legacy.root, { strict: true })).findings).toEqual([]);
  });

  it.each(['light', 'standard', 'advanced'] as const)('depth=%s обновляется без потери lazy-каталогов', async (depth) => {
    const legacy = await makeLegacy02Project({ depth, folder: `depth-${depth}` });
    expect((await upgradeProject(legacy.root, { apply: true })).ok).toBe(true);
    const manifest = await loadManifest(legacy.root);
    expect(manifest.project.depth).toBe(depth);
    expect((await doctorProject(legacy.root, { strict: true })).findings).toEqual([]);
  });

  it('рабочая копия с CRLF не считается изменённым файлом и приводится к LF', async () => {
    const legacy = await makeLegacy02Project();
    const path = join(legacy.root, 'CLAUDE.md');
    await writeFile(path, (await readFile(path, 'utf8')).replace(/\n/g, '\r\n'), 'utf8');

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok, result.error).toBe(true);
    expect(await readFile(path, 'utf8')).not.toContain('\r\n');
    expect((await doctorProject(legacy.root, { strict: true })).findings).toEqual([]);
  });

  it('symlink на обновляемом пути блокирует upgrade', async () => {
    const legacy = await makeLegacy02Project();
    const { symlink } = await import('node:fs/promises');
    const outside = join(await makeTempDir('outside-'), 'target.md');
    await writeFile(outside, 'снаружи\n', 'utf8');
    await rm(join(legacy.root, 'CLAUDE.md'));
    try {
      await symlink(outside, join(legacy.root, 'CLAUDE.md'));
    } catch {
      return; // среда без права создавать symlink (Windows без developer mode)
    }
    const before = await snapshotTree(legacy.root);

    const result = await upgradeProject(legacy.root, { apply: true });
    expect(result.ok).toBe(false);
    expect(codes(result.analysis.blockers)).toContain('upgrade-incomplete-tree');
    expect(await snapshotTree(legacy.root)).toEqual(before);
  });
});

describe('0.3 Phase 3: CLI upgrade', () => {
  it('применяет обновление только по --apply и возвращает 0', async () => {
    const legacy = await makeLegacy02Project();
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', legacy.root, '--apply'], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('Обновление применено');
    expect((await doctorProject(legacy.root, { strict: true })).findings).toEqual([]);
  });

  it('на заблокированном проекте возвращает 1 и не пишет ничего', async () => {
    const dir = await makeTempDir('cli-blocked-');
    await writeFile(join(dir, 'file.txt'), 'чужое\n', 'utf8');
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', dir, '--apply'], cli.io)).toBe(1);
    expect(cli.stderr()).toContain('upgrade-not-canonical');
    expect(cli.stdout()).toBe('');
  });

  it('--json печатает детерминированный отчёт', async () => {
    const legacy = await makeLegacy02Project();
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', legacy.root, '--json'], cli.io)).toBe(0);
    const report = JSON.parse(cli.stdout()) as { ok: boolean; applied: boolean; analysis: { status: string; creates: { path: string }[] } };
    expect(report.applied).toBe(false);
    expect(report.analysis.status).toBe('upgradable');
    expect(report.analysis.creates.map((item) => item.path).sort()).toEqual(NEW_PATHS);
  });

  it('--apply недоступен другим командам', async () => {
    const cli = collect();
    expect(await runMaestroCli(['doctor', '--apply'], cli.io)).toBe(2);
    expect(cli.stderr()).toContain('только для upgrade');
  });

  it('свежий проект текущей версии сообщает, что обновлять нечего', async () => {
    const target = join(await makeTempDir('fresh-'), 'свежий');
    expect((await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    const cli = collect();
    expect(await runMaestroCli(['upgrade', '--path', target], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('уже соответствует канону');
  });
});
