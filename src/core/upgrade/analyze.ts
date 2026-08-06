import { lstat, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { absolutePathHasSymlink, pathHasSymlink } from '../doctor/fs-utils.js';
import { canonicalManagedKind, canonicalOwnershipInventory, CONTENT_OWNED_FILES, TEMPLATE_FILES } from '../inventory.js';
import type { CanonicalOwnership } from '../inventory.js';
import {
  CHECKSUMS_PATH,
  contentChecksum,
  isCanonicalManifest,
  loadChecksums,
  loadManifest,
  MANIFEST_PATH,
  serializeJson,
  sha256,
  buildManifest,
} from '../manifest.js';
import type { Manifest, ProjectDepth } from '../manifest.js';
import { CREATE_COMMAND, VERSION } from '../meta.js';
import { readPackageJson, packageRoot, templatesDir } from '../paths.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { renderTemplate } from '../template.js';
import type { TemplateVars } from '../template.js';
import {
  BASELINE_ID,
  BASELINE_PRODUCT_VERSIONS,
  BASELINE_TEMPLATES,
  baselineOwnershipInventory,
} from './baseline.js';
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

function analysis(root: string, status: UpgradeStatus, fromVersion: string | null, blockers: UpgradeBlocker[]): UpgradeAnalysis {
  return {
    reportVersion: 1,
    status,
    root,
    baselineId: BASELINE_ID,
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

/** Точная форма manifest, которую записал бы init предыдущей версии. */
function matchesBaselineShape(manifest: Manifest): boolean {
  const expected = baselineOwnershipInventory(manifest.project.depth);
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
 * действительно канонический проект предыдущей версии в его собственной папке,
 * содержимое файлов даже не читается.
 */
export async function analyzeUpgrade(rootInput: string): Promise<UpgradePlan> {
  const root = await canonicalizeSystemTempPrefix(resolve(rootInput));

  if (await absolutePathHasSymlink(root)) {
    return blocked(root, null, blocker('upgrade-root-symlink', 'Путь к корню проекта не должен содержать symbolic link.', root));
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
  if (manifest.project.name !== basename(root)) {
    return blocked(root, fromVersion, blocker('upgrade-manifest-not-native', 'Manifest принадлежит другой папке: имя проекта не совпадает с именем каталога.', MANIFEST_PATH));
  }

  const current = canonicalOwnershipInventory(depth);
  const baseline = baselineOwnershipInventory(depth);

  if (isCanonicalManifest(manifest)) {
    return { analysis: analysis(root, 'current', fromVersion, []), root, writes: [] };
  }
  if (!matchesBaselineShape(manifest)) {
    return blocked(root, fromVersion, blocker(
      'upgrade-unsupported-baseline',
      `Поддерживается только известный предшественник ${BASELINE_ID}; форма inventory этого проекта ему не соответствует.`,
      MANIFEST_PATH,
    ));
  }
  if (!BASELINE_PRODUCT_VERSIONS.includes(fromVersion)) {
    return blocked(root, fromVersion, blocker(
      'upgrade-unsupported-version',
      `Версия продукта ${fromVersion} не входит в поддерживаемый baseline ${BASELINE_ID}.`,
      MANIFEST_PATH,
    ));
  }

  const blockers: UpgradeBlocker[] = [];

  // Полное дерево предшественника: manifest не имеет права выдавать неполную папку за проект.
  for (const path of Object.keys(baseline)) {
    if (!await isRegularFile(join(root, path))) {
      blockers.push(blocker('upgrade-incomplete-tree', 'Обязательный путь предыдущего канона отсутствует или не является обычным файлом.', path));
    }
  }
  // Новый канон обязан быть надмножеством: удаление путей этот upgrade не выполняет.
  for (const path of Object.keys(baseline)) {
    if (!(path in current)) blockers.push(blocker('upgrade-removal-unsupported', 'Путь предыдущего канона отсутствует в текущем; upgrade ничего не удаляет.', path));
  }
  if (blockers.length > 0) return blocked(root, fromVersion, ...blockers);

  if (await exists(join(root, STAGING_DIR))) {
    return blocked(root, fromVersion, blocker(
      'upgrade-staging-present',
      'Каталог транзакции уже существует: возможно, прошлый запуск был прерван. Проверьте и удалите его вручную.',
      STAGING_DIR,
    ));
  }

  // 1. Восстановление подстановок по прошлым каноническим шаблонам.
  const vars: { projectName?: string; date?: string } = {};
  const baselineSources = new Map<string, string>();
  for (const template of BASELINE_TEMPLATES) {
    let source: string;
    try {
      source = (await readFile(join(packageRoot(), template.source), 'utf8')).replace(/\r\n/g, '\n');
    } catch (cause) {
      blockers.push(blocker('upgrade-baseline-unreadable', `Baseline-шаблон пакета недоступен: ${cause instanceof Error ? cause.message : String(cause)}`, template.source));
      continue;
    }
    if (sha256(source) !== template.sha256) {
      blockers.push(blocker('upgrade-baseline-corrupt', 'Baseline-шаблон пакета не совпадает со своей контрольной суммой и не может быть авторитетом.', template.source));
      continue;
    }
    baselineSources.set(template.path, source);

    if (await pathHasSymlink(root, template.path)) {
      blockers.push(blocker('upgrade-path-symlink', 'Обновляемый путь не должен содержать symbolic link.', template.path));
      continue;
    }
    const actual = await readFile(join(root, template.path), 'utf8');
    const recovered = recoverTemplateVars(source, actual, manifest.project.startingPoint);
    if (recovered === null) {
      blockers.push(blocker('upgrade-managed-modified', 'Managed-файл изменён относительно прошлого канона: upgrade не перезаписывает изменённое содержимое.', template.path));
      continue;
    }
    for (const key of ['projectName', 'date'] as const) {
      const value = recovered[key];
      if (value === undefined) continue;
      if (vars[key] !== undefined && vars[key] !== value) {
        blockers.push(blocker('upgrade-variable-conflict', `Подстановка ${key} восстанавливается по-разному в разных managed-файлах.`, template.path));
        continue;
      }
      vars[key] = value;
    }
  }
  if (blockers.length > 0) return blocked(root, fromVersion, ...blockers);

  // 2. Контрольные суммы обязаны подтверждать ту же картину: расхождение metadata — тоже конфликт.
  const checksums = await loadChecksums(root);
  if (checksums === null) {
    return blocked(root, fromVersion, blocker('upgrade-checksums-invalid', 'Контрольные суммы проекта отсутствуют или повреждены.', CHECKSUMS_PATH));
  }
  for (const template of BASELINE_TEMPLATES) {
    const recorded = checksums.files[template.path];
    const actual = contentChecksum(template.path, await readFile(join(root, template.path)));
    if (recorded !== actual) {
      blockers.push(blocker('upgrade-checksum-mismatch', 'Записанная контрольная сумма не совпадает с файлом: metadata проекта противоречива.', template.path));
    }
  }
  if (blockers.length > 0) return blocked(root, fromVersion, ...blockers);

  // 3. Новые пути канона. Содержимое собирается только из шаблонов текущей версии.
  const newPaths = Object.keys(current).filter((path) => !(path in baseline));
  const writes: UpgradePlan['writes'] = [];
  const creates: UpgradeChange[] = [];

  const renderVars = (source: string): TemplateVars | null => {
    const uses = templateUses(source);
    if ((uses.projectName && vars.projectName === undefined) || (uses.date && vars.date === undefined)) return null;
    return { projectName: vars.projectName ?? '', date: vars.date ?? '', startingPoint: manifest.project.startingPoint };
  };

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

  // 4. Обновления managed-файлов с доказанным preimage.
  const updates: UpgradeChange[] = [];
  const unchanged: string[] = [];
  for (const template of BASELINE_TEMPLATES) {
    const source = await readTemplate(template.path);
    const templateVars = renderVars(source);
    if (templateVars === null) {
      blockers.push(blocker('upgrade-variable-unrecoverable', 'Шаблон требует подстановку, которую нельзя восстановить из проекта; угадывать её нельзя.', template.path));
      continue;
    }
    const content = renderTemplate(source, templateVars);
    const actual = (await readFile(join(root, template.path), 'utf8')).replace(/\r\n/g, '\n');
    if (content.replace(/\r\n/g, '\n') === actual) {
      unchanged.push(template.path);
      continue;
    }
    updates.push({ path: template.path, ownership: current[template.path] as CanonicalOwnership });
    writes.push({ path: template.path, content, action: 'update' });
  }
  if (blockers.length > 0) return blocked(root, fromVersion, ...blockers);

  // 5. Metadata. Manifest пересобирается по текущему канону; проектные поля переносятся как есть.
  const nextManifest = buildManifest({
    projectName: manifest.project.name,
    startingPoint: manifest.project.startingPoint,
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

  const result = analysis(root, 'upgradable', fromVersion, []);
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
