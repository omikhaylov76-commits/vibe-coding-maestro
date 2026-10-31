import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { absolutePathHasSymlink, pathHasSymlink } from '../doctor/fs-utils.js';
import { GITATTRIBUTES_CONTENT } from '../init.js';
import { canonicalManagedKind, canonicalOwnershipInventory, CONTENT_OWNED_FILES, TEMPLATE_FILES } from '../inventory.js';
import type { CanonicalOwnership } from '../inventory.js';
import {
  CHECKSUMS_PATH,
  contentChecksum,
  isCanonicalManifest,
  loadChecksums,
  loadManifest,
  MANIFEST_PATH,
  normalizeEol,
  serializeJson,
  sha256,
  buildManifest,
} from '../manifest.js';
import type { Manifest, ProjectDepth } from '../manifest.js';
import { CREATE_COMMAND, serviceInvocation, VERSION } from '../meta.js';
import { readPackageJson, packageRoot, templatesDir } from '../paths.js';
import { canonicalizeSystemTempPrefix, onDiskBasename } from '../platform-paths.js';
import { renderTemplate } from '../template.js';
import type { TemplateVars } from '../template.js';
import { compareVersions } from '../version.js';
import { findRelease, supportedVersions } from './releases.js';
import type { Release } from './releases.js';
import { recoverTemplateVars, templateUses } from './instance.js';

/** Каталог транзакции. Внутри `.maestro`, чтобы не появляться в дереве проекта. */
export const STAGING_DIR = '.maestro/upgrade-staging';

export type UpgradeStatus = 'current' | 'upgradable' | 'blocked';

export interface UpgradeBlocker {
  code: string;
  message: string;
  path?: string;
}

export interface UpgradeChange {
  path: string;
  ownership: CanonicalOwnership;
}

/** Машиночитаемое предложение. Содержимое файлов сюда не попадает: это отчёт, а не патч. */
export interface UpgradeAnalysis {
  reportVersion: 1;
  status: UpgradeStatus;
  root: string;
  baselineId: string;
  fromVersion: string | null;
  toVersion: string;
  creates: UpgradeChange[];
  updates: UpgradeChange[];
  unchanged: string[];
  preserves: string[];
  metadata: string[];
  blockers: UpgradeBlocker[];
}

/** Внутренний план: анализ плюс точное содержимое, готовое к записи. */
export interface UpgradePlan {
  analysis: UpgradeAnalysis;
  root: string;
  /** Путь → итоговое содержимое. Порядок фиксирован для детерминированной транзакции. */
  writes: { path: string; content: string; action: 'create' | 'update' }[];
}

const blocker = (code: string, message: string, path?: string): UpgradeBlocker =>
  ({ code, message, ...(path === undefined ? {} : { path }) });

function analysis(root: string, status: UpgradeStatus, fromVersion: string | null, blockers: UpgradeBlocker[], baselineId = 'unknown'): UpgradeAnalysis {
  return {
    reportVersion: 1,
    status,
    root,
    baselineId,
    fromVersion,
    toVersion: VERSION,
    creates: [],
    updates: [],
    unchanged: [],
    preserves: [],
    metadata: [],
    blockers,
  };
}

const blocked = (root: string, fromVersion: string | null, ...blockers: UpgradeBlocker[]): UpgradePlan =>
  ({ analysis: analysis(root, 'blocked', fromVersion, blockers), root, writes: [] });

const blockedAt = (root: string, release: Release, fromVersion: string, blockers: UpgradeBlocker[]): UpgradePlan =>
  ({ analysis: analysis(root, 'blocked', fromVersion, blockers, release.id), root, writes: [] });

async function isRegularFile(absolute: string): Promise<boolean> {
  try {
    return (await lstat(absolute)).isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

async function readTemplate(relativePath: string): Promise<string> {
  return readFile(join(templatesDir(), 'project', relativePath), 'utf8');
}

/** Исходник managed-пути текущей версии. `.gitattributes` пишет константа init, а не шаблон. */
async function currentSource(relativePath: string): Promise<string> {
  if (relativePath === '.gitattributes') return GITATTRIBUTES_CONTENT;
  return normalizeEol(await readTemplate(relativePath));
}

/**
 * Исходник managed-пути в прошлом каноне.
 *
 * Изменённые с тех пор пути поставляются копией в `registry/baseline`; остальные
 * берутся из текущего шаблона, но только если его сумма совпадает с замороженным
 * слепком. Иначе пакет не знает, как выглядел файл, и не имеет права его трогать.
 */
async function releaseSource(release: Release, relativePath: string): Promise<{ source: string } | { blocker: UpgradeBlocker }> {
  const copy = release.templates.find((template) => template.path === relativePath);
  if (copy !== undefined) {
    let source: string;
    try {
      source = normalizeEol(await readFile(join(packageRoot(), copy.source), 'utf8'));
    } catch (cause) {
      return { blocker: blocker('upgrade-baseline-unreadable', `Baseline-шаблон пакета недоступен: ${cause instanceof Error ? cause.message : String(cause)}`, copy.source) };
    }
    if (sha256(source) !== copy.sha256) {
      return { blocker: blocker('upgrade-baseline-corrupt', 'Baseline-шаблон пакета не совпадает со своей контрольной суммой и не может быть авторитетом.', copy.source) };
    }
    return { source };
  }
  const source = await currentSource(relativePath);
  if (release.managedSha256[relativePath] !== sha256(source)) {
    return { blocker: blocker(
      'upgrade-baseline-drift',
      `В пакете нет копии этого файла в версии ${release.versions.join(', ')}: без неё upgrade не может доказать, что файл не изменён. Это дефект пакета — сообщите о нём.`,
      relativePath,
    ) };
  }
  return { source };
}

/** Точная форма manifest, которую записал бы init прошлой версии. */
function matchesShape(manifest: Manifest, expected: Readonly<Record<string, CanonicalOwnership>>): boolean {
  const paths = Object.keys(expected);
  if (manifest.inventory.length !== paths.length || manifest.managed.length !== paths.length) return false;
  const inventory = new Map(manifest.inventory.map((entry) => [entry.path, entry.ownership]));
  const managed = new Map(manifest.managed.map((entry) => [entry.path, entry.kind]));
  return Object.entries(expected).every(([path, ownership]) =>
    inventory.get(path) === ownership && managed.get(path) === canonicalManagedKind(path, ownership));
}

/**
 * Read-only разбор проекта: ни один байт не записывается.
 *
 * Порядок проверок — от авторитета к содержимому. Пока не доказано, что это
 * действительно канонический проект известной прошлой версии в его собственной
 * папке, содержимое файлов даже не читается.
 */
export async function analyzeUpgrade(rootInput: string): Promise<UpgradePlan> {
  const root = await canonicalizeSystemTempPrefix(resolve(rootInput));

  if (await absolutePathHasSymlink(root)) {
    return blocked(root, null, blocker('upgrade-root-symlink', 'Путь к корню проекта не должен содержать symbolic link.', root));
  }
  if (!await exists(root)) {
    return blocked(root, null, blocker('upgrade-path-missing', `Папка не найдена: ${root}. Проверьте путь; путь с пробелами возьмите в кавычки.`));
  }
  if (!await isRegularFile(join(root, MANIFEST_PATH))) {
    return blocked(root, null, blocker(
      'upgrade-not-canonical',
      'Папка не является каноническим проектом Vibe Coding Maestro: manifest отсутствует. Upgrade не преобразует произвольные папки.',
      MANIFEST_PATH,
    ));
  }

  let manifest: Manifest;
  try {
    manifest = await loadManifest(root);
  } catch (cause) {
    return blocked(root, null, blocker('upgrade-manifest-invalid', `Манифест повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, MANIFEST_PATH));
  }

  const fromVersion = manifest.product.version;
  const depth: ProjectDepth = manifest.project.depth;

  /**
   * Manifest описывает намерение, но сам по себе не даёт upgrade authority.
   * Скопированный в чужую папку манифест обязан провалиться здесь.
   */
  if (manifest.product.name !== readPackageJson().name || manifest.product.createdBy !== CREATE_COMMAND) {
    return blocked(root, fromVersion, blocker('upgrade-foreign-manifest', 'Manifest создан не этим продуктом.', MANIFEST_PATH));
  }
  if (manifest.project.name !== onDiskBasename(root)) {
    return blocked(root, fromVersion, blocker(
      'upgrade-manifest-not-native',
      `Manifest принадлежит другой папке: проект называется «${manifest.project.name}», а папка — «${onDiskBasename(root)}». Если папку переименовали или склонировали под другим именем, верните ей имя «${manifest.project.name}».`,
      MANIFEST_PATH,
    ));
  }

  const current = canonicalOwnershipInventory(depth);

  const order = compareVersions(fromVersion, VERSION);
  if (order !== null && order > 0) {
    return blocked(root, fromVersion, blocker(
      'upgrade-project-newer',
      `Проект уже на более новой версии ${fromVersion}, а запущена ${VERSION}; откатывать версию upgrade не умеет. Используйте ${serviceInvocation(fromVersion)}.`,
      MANIFEST_PATH,
    ));
  }
  if (fromVersion === VERSION) {
    if (isCanonicalManifest(manifest)) {
      return { analysis: analysis(root, 'current', fromVersion, [], VERSION), root, writes: [] };
    }
    return blocked(root, fromVersion, blocker(
      'upgrade-unsupported-baseline',
      `Manifest называет версию ${VERSION}, но его форма inventory не совпадает с каноном этой версии.`,
      MANIFEST_PATH,
    ));
  }

  const release = findRelease(fromVersion);
  if (release === undefined) {
    return blocked(root, fromVersion, blocker(
      'upgrade-unsupported-version',
      `Upgrade не знает версию ${fromVersion}. Обновлять он умеет с версий: ${supportedVersions().join(', ')}.`,
      MANIFEST_PATH,
    ));
  }
  const baseline = release.inventory(depth);
  if (!matchesShape(manifest, baseline)) {
    return blockedAt(root, release, fromVersion, [blocker(
      'upgrade-unsupported-baseline',
      `Форма inventory проекта не совпадает с каноном ${release.id}, который записывала версия ${fromVersion}.`,
      MANIFEST_PATH,
    )]);
  }

  const blockers: UpgradeBlocker[] = [];

  // Полное дерево предшественника: manifest не имеет права выдавать неполную папку за проект.
  for (const path of Object.keys(baseline)) {
    if (!await isRegularFile(join(root, path))) {
      blockers.push(blocker('upgrade-incomplete-tree', 'Обязательный путь предыдущего канона отсутствует или не является обычным файлом.', path));
    }
  }
  // Новый канон обязан быть надмножеством с тем же владением: ни удалять, ни передавать пути этот upgrade не умеет.
  for (const [path, ownership] of Object.entries(baseline)) {
    if (!(path in current)) blockers.push(blocker('upgrade-removal-unsupported', 'Путь предыдущего канона отсутствует в текущем; upgrade ничего не удаляет.', path));
    else if (current[path] !== ownership) blockers.push(blocker('upgrade-ownership-change-unsupported', `Владение путём меняется (${ownership} → ${current[path]}); этот upgrade такого перехода не знает.`, path));
  }
  if (blockers.length > 0) return blockedAt(root, release, fromVersion, blockers);

  if (await exists(join(root, STAGING_DIR))) {
    return blockedAt(root, release, fromVersion, [blocker(
      'upgrade-staging-present',
      'Каталог транзакции уже существует: прошлый запуск был прерван. В его подпапке backup/ лежат прежние версии файлов. Сверьте проект (git status, git diff), верните нужное из backup/ и только потом удалите каталог.',
      STAGING_DIR,
    )]);
  }

  const checksums = await loadChecksums(root);
  if (checksums === null) {
    return blockedAt(root, release, fromVersion, [blocker('upgrade-checksums-invalid', 'Контрольные суммы проекта отсутствуют или повреждены.', CHECKSUMS_PATH)]);
  }

  // 1. Managed-пути прошлого канона: прошлый исходник, новый исходник и, если upgrade
  // их затрагивает, доказательство, что файл на диске — неизменённый рендер прошлого.
  const vars: { projectName?: string; date?: string } = {};
  const affected: { path: string; next: string; actual: string }[] = [];
  const optional: { path: string; source: string }[] = [];
  const startingPoint = manifest.project.startingPoint;

  const remember = (path: string, recovered: { projectName?: string; date?: string }): boolean => {
    for (const key of ['projectName', 'date'] as const) {
      const value = recovered[key];
      if (value === undefined) continue;
      if (vars[key] !== undefined && vars[key] !== value) {
        blockers.push(blocker('upgrade-variable-conflict', `Подстановка ${key} восстанавливается по-разному в разных managed-файлах.`, path));
        return false;
      }
      vars[key] = value;
    }
    return true;
  };

  for (const [path, ownership] of Object.entries(baseline)) {
    if (ownership !== 'managed' && ownership !== 'immutable') continue;
    // Пустой маркер каталога: во всех канонах это ноль байт, обновлять нечего.
    if (path.endsWith('/.gitkeep')) continue;
    const previous = await releaseSource(release, path);
    if ('blocker' in previous) { blockers.push(previous.blocker); continue; }
    const next = await currentSource(path);
    const pinsVersion = templateUses(previous.source).version || templateUses(next).version;
    if (previous.source === next && !pinsVersion) {
      // Этот upgrade путь не трогает: правки пользователя в нём — не его забота.
      optional.push({ path, source: previous.source });
      continue;
    }

    if (await pathHasSymlink(root, path)) {
      blockers.push(blocker('upgrade-path-symlink', 'Обновляемый путь не должен содержать symbolic link.', path));
      continue;
    }
    const actual = normalizeEol(await readFile(join(root, path), 'utf8'));
    const recovered = recoverTemplateVars(previous.source, actual, startingPoint, fromVersion);
    if (recovered === null) {
      blockers.push(blocker(
        'upgrade-managed-modified',
        `Файл Maestro изменён вручную относительно версии ${fromVersion}, поэтому upgrade его не перезапишет. Верните файл к исходному виду или перенесите свои правки в собственный файл проекта, затем повторите.`,
        path,
      ));
      continue;
    }
    if (!remember(path, recovered)) continue;
    if (checksums.files[path] !== contentChecksum(path, actual)) {
      blockers.push(blocker('upgrade-checksum-mismatch', 'Записанная контрольная сумма не совпадает с файлом: metadata проекта противоречива.', path));
      continue;
    }
    affected.push({ path, next, actual });
  }
  if (blockers.length > 0) return blockedAt(root, release, fromVersion, blockers);

  // Недостающие подстановки можно взять из файлов, которые upgrade не трогает. Это
  // только подсказка: правка в таком файле не имеет права остановить обновление,
  // поэтому расхождение здесь не блокирует, а уже известное значение не меняется.
  for (const { path, source } of optional) {
    if (vars.projectName !== undefined && vars.date !== undefined) break;
    const uses = templateUses(source);
    if (!uses.projectName && !uses.date) continue;
    if (await pathHasSymlink(root, path)) continue;
    const recovered = recoverTemplateVars(source, await readFile(join(root, path), 'utf8'), startingPoint, fromVersion);
    if (recovered === null) continue;
    vars.projectName ??= recovered.projectName;
    vars.date ??= recovered.date;
  }

  const renderVars = (source: string): TemplateVars | null => {
    const uses = templateUses(source);
    if ((uses.projectName && vars.projectName === undefined) || (uses.date && vars.date === undefined)) return null;
    return { projectName: vars.projectName ?? '', date: vars.date ?? '', startingPoint, version: VERSION };
  };

  // 2. Новые пути канона. Содержимое собирается только из шаблонов текущей версии.
  const newPaths = Object.keys(current).filter((path) => !(path in baseline));
  const writes: UpgradePlan['writes'] = [];
  const creates: UpgradeChange[] = [];

  for (const path of newPaths.sort()) {
    const ownership = current[path] as CanonicalOwnership;
    if (await pathHasSymlink(root, path)) {
      blockers.push(blocker('upgrade-path-symlink', 'Добавляемый путь не должен содержать symbolic link.', path));
      continue;
    }
    if (await exists(join(root, path))) {
      blockers.push(blocker('upgrade-path-collision', 'Добавляемый путь уже занят: upgrade не перезаписывает существующее содержимое.', path));
      continue;
    }
    let content: string;
    if (TEMPLATE_FILES.includes(path) || CONTENT_OWNED_FILES.includes(path)) {
      const source = await readTemplate(path);
      const templateVars = renderVars(source);
      if (templateVars === null) {
        blockers.push(blocker('upgrade-variable-unrecoverable', 'Шаблон требует подстановку, которую нельзя восстановить из проекта; угадывать её нельзя.', path));
        continue;
      }
      content = renderTemplate(source, templateVars);
    } else if (path.endsWith('/.gitkeep')) {
      content = '';
    } else {
      blockers.push(blocker('upgrade-unknown-new-path', 'Новый канонический путь неизвестного вида: upgrade не выдумывает его содержимое.', path));
      continue;
    }
    creates.push({ path, ownership });
    writes.push({ path, content, action: 'create' });
  }

  // 3. Обновления managed-файлов с доказанным preimage.
  const updates: UpgradeChange[] = [];
  const unchanged: string[] = [];
  for (const { path, next, actual } of affected) {
    const templateVars = renderVars(next);
    if (templateVars === null) {
      blockers.push(blocker('upgrade-variable-unrecoverable', 'Шаблон требует подстановку, которую нельзя восстановить из проекта; угадывать её нельзя.', path));
      continue;
    }
    const content = path === '.gitattributes' ? next : renderTemplate(next, templateVars);
    if (normalizeEol(content) === actual) {
      unchanged.push(path);
      continue;
    }
    updates.push({ path, ownership: current[path] as CanonicalOwnership });
    writes.push({ path, content, action: 'update' });
  }
  if (blockers.length > 0) return blockedAt(root, release, fromVersion, blockers);

  // 4. Metadata. Manifest пересобирается по текущему канону; проектные поля переносятся как есть.
  const nextManifest = buildManifest({
    projectName: manifest.project.name,
    startingPoint,
    createdAt: manifest.project.createdAt,
    productName: readPackageJson().name,
    productVersion: VERSION,
    createdBy: CREATE_COMMAND,
    projectId: manifest.project.id,
    depth,
    managed: Object.entries(current).map(([path, ownership]) => ({ path, kind: canonicalManagedKind(path, ownership) })),
    inventory: Object.entries(current).map(([path, ownership]) => ({ path, ownership })),
  });

  // Суммы существующих файлов сохраняются как есть: upgrade не переоценивает чужие файлы.
  const nextChecksums: Record<string, string> = { ...checksums.files };
  for (const write of writes) {
    if (current[write.path] === 'managed' || current[write.path] === 'immutable') {
      nextChecksums[write.path] = contentChecksum(write.path, write.content);
    }
  }

  const result = analysis(root, 'upgradable', fromVersion, [], release.id);
  result.creates = creates;
  result.updates = updates;
  result.unchanged = unchanged.sort();
  result.metadata = [MANIFEST_PATH, CHECKSUMS_PATH];
  result.preserves = Object.entries(baseline)
    .filter(([path, ownership]) => ownership === 'project-owned' && path in current)
    .map(([path]) => path)
    .sort();

  return {
    analysis: result,
    root,
    writes: [
      ...writes,
      { path: MANIFEST_PATH, content: serializeJson(nextManifest), action: 'update' },
      { path: CHECKSUMS_PATH, content: serializeJson({ files: sortKeys(nextChecksums) }), action: 'update' },
    ],
  };
}

/** Ключи сортируются так же, как в init: повторный запуск даёт побайтово тот же файл. */
function sortKeys(files: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) {
    const value = files[key];
    if (value !== undefined) sorted[key] = value;
  }
  return sorted;
}
