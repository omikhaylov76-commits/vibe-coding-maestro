import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { GITATTRIBUTES_CONTENT, initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import {
  buildManifest,
  contentChecksum,
  serializeJson,
  CHECKSUMS_PATH,
  MANIFEST_PATH,
} from '../src/core/manifest.js';
import type { ProjectDepth } from '../src/core/manifest.js';
import { CREATE_COMMAND } from '../src/core/meta.js';
import type { StartingPoint } from '../src/core/meta.js';
import { packageRoot, readPackageJson, templatesDir } from '../src/core/paths.js';
import { renderTemplate } from '../src/core/template.js';
import {
  BASELINE_MANAGED_SHA256,
  BASELINE_PRODUCT_VERSIONS,
  BASELINE_TEMPLATES,
  baselineOwnershipInventory,
} from '../src/core/upgrade/baseline.js';
import { canonicalManagedKind } from '../src/core/inventory.js';
import { FIXED_DATE, FIXED_NOW, makeTempDir, sha256 } from './helpers.js';

/**
 * Точная реконструкция проекта, созданного каноном 0.2.
 *
 * Проект строится текущим init, затем возвращается к прошлому канону: новые пути
 * удаляются, изменённые managed-файлы восстанавливаются из baseline-копий 0.2,
 * а manifest и checksums пересобираются в форме, которую записывал init 0.2.
 * Источник истины для «как было» — те же baseline-копии, которыми пользуется
 * upgrade, поэтому тест не может незаметно разойтись с продуктом.
 */
export interface LegacyProject {
  root: string;
  displayName: string;
  date: string;
  depth: ProjectDepth;
  startingPoint: StartingPoint;
}

export interface LegacyOptions {
  folder?: string;
  displayName?: string;
  depth?: ProjectDepth;
  startingPoint?: StartingPoint;
  parent?: string;
  git?: boolean;
}

const lf = (text: string): string => text.replace(/\r\n/g, '\n');

/** Baseline-копии, поставляемые пакетом: путь проекта → путь копии внутри пакета. */
const BASELINE_COPIES = new Map(BASELINE_TEMPLATES.map((template) => [template.path, template.source]));

/**
 * Исходник managed-пути в том виде, в каком его поставляет ТЕКУЩИЙ канон.
 * `.gitattributes` шаблоном на диске не является: его пишет константа init.
 */
export async function canonicalManagedSource(path: string): Promise<string> {
  if (path === '.gitattributes') return GITATTRIBUTES_CONTENT;
  return lf(await readFile(join(templatesDir(), 'project', path), 'utf8'));
}

/**
 * Исходник managed-пути в каноне 0.2.
 *
 * Пути, содержимое которых 0.3 изменил, поставляются копией в `registry/baseline`;
 * остальные берутся из текущего шаблона — но только после сверки с замороженным
 * слепком 0.2. Поэтому фикстура не может молча выдать 0.3-содержимое за прошлый
 * канон: путь, выпавший из `BASELINE_TEMPLATES`, падает здесь, а не превращается
 * в «0.2-проект», который на самом деле наполовину 0.3.
 */
export async function baseline02Source(path: string): Promise<string> {
  const copy = BASELINE_COPIES.get(path);
  const source = copy === undefined
    ? await canonicalManagedSource(path)
    : lf(await readFile(join(packageRoot(), copy), 'utf8'));
  expect(sha256(source), `исходник 0.2 для ${path}`).toBe(BASELINE_MANAGED_SHA256[path]);
  return source;
}

/** Строки, добавленные каноном 0.3 в project-owned hot.md. */
const HOT_ADDITIONS: readonly string[] = [
  'active_plan: none\n',
  '<!-- Contract: active_plan is none, or one plans/<file>.md path under wiki/plans/ whose frontmatter has status: active. In 0.3 beta wiki/programs/<slug>/ holds program material that doctor does not check, so it cannot be declared here. A project created before 0.3 has no active_plan field; a missing field is read as none. -->\n',
];

export async function makeLegacy02Project(options: LegacyOptions = {}): Promise<LegacyProject> {
  const parent = options.parent ?? await makeTempDir('legacy-0.2-');
  const folder = options.folder ?? 'наследие 0.2';
  const displayName = options.displayName ?? folder;
  const depth: ProjectDepth = options.depth ?? 'standard';
  const startingPoint: StartingPoint = options.startingPoint ?? 'idea';

  const created = await initProject({
    target: join(parent, folder),
    name: displayName,
    startingPoint,
    depth,
    git: options.git === true,
    now: FIXED_NOW,
  });
  expect(created.ok, created.error).toBe(true);
  const root = created.target;

  const current = canonicalOwnershipInventory(depth);
  const baseline = baselineOwnershipInventory(depth);

  // 1. Пути, которых в 0.2 не существовало.
  for (const path of Object.keys(current)) {
    if (!(path in baseline)) await rm(join(root, path), { force: true });
  }
  await rm(join(root, 'wiki/plans'), { recursive: true, force: true });

  // 2. ВСЕ managed-файлы возвращаются к прошлому каноническому содержимому.
  // Откат только по BASELINE_TEMPLATES оставлял бы в «0.2-проекте» файлы 0.3 и
  // делал неполноту этого списка принципиально ненаблюдаемой.
  const vars = { projectName: displayName, date: FIXED_DATE, startingPoint };
  for (const [path, ownership] of Object.entries(baseline)) {
    if (ownership !== 'managed' && ownership !== 'immutable') continue;
    if (path.endsWith('/.gitkeep')) {
      // Пустой маркер каталога: в обоих канонах это ноль байт, восстанавливать нечего.
      expect(await readFile(join(root, path), 'utf8'), path).toBe('');
      continue;
    }
    await writeFile(join(root, path), renderTemplate(await baseline02Source(path), vars), 'utf8');
  }

  // 3. project-owned hot.md: в 0.2 полей 0.3 в нём не было.
  const hotPath = join(root, 'wiki/hot.md');
  let hot = await readFile(hotPath, 'utf8');
  for (const line of HOT_ADDITIONS) {
    expect(hot).toContain(line);
    hot = hot.replace(line, '');
  }
  await writeFile(hotPath, hot, 'utf8');

  // 4. Manifest и checksums в форме init 0.2.
  const manifest = buildManifest({
    projectName: folder,
    startingPoint,
    createdAt: FIXED_NOW.toISOString(),
    productName: readPackageJson().name,
    productVersion: BASELINE_PRODUCT_VERSIONS[0] as string,
    createdBy: CREATE_COMMAND,
    projectId: (JSON.parse(await readFile(join(root, MANIFEST_PATH), 'utf8')) as { project: { id: string } }).project.id,
    depth,
    managed: Object.entries(baseline).map(([path, ownership]) => ({ path, kind: canonicalManagedKind(path, ownership) })),
    inventory: Object.entries(baseline).map(([path, ownership]) => ({ path, ownership })),
  });
  await writeFile(join(root, MANIFEST_PATH), serializeJson(manifest), 'utf8');

  const files: Record<string, string> = {};
  for (const path of Object.keys(baseline).sort()) {
    const ownership = baseline[path];
    if (ownership !== 'managed' && ownership !== 'immutable') continue;
    files[path] = contentChecksum(path, await readFile(join(root, path)));
  }
  await writeFile(join(root, CHECKSUMS_PATH), serializeJson({ files }), 'utf8');

  return { root, displayName, date: FIXED_DATE, depth, startingPoint };
}
