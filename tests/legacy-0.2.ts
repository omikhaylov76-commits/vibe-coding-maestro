import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import { initProject } from '../src/core/init.js';
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
import { packageRoot, readPackageJson } from '../src/core/paths.js';
import { renderTemplate } from '../src/core/template.js';
import {
  BASELINE_PRODUCT_VERSIONS,
  BASELINE_TEMPLATES,
  baselineOwnershipInventory,
} from '../src/core/upgrade/baseline.js';
import { canonicalManagedKind } from '../src/core/inventory.js';
import { FIXED_DATE, FIXED_NOW, makeTempDir } from './helpers.js';

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

/** Строки, добавленные каноном 0.3 в project-owned hot.md. */
const HOT_ADDITIONS: readonly string[] = [
  'active_plan: none\n',
  '<!-- Contract: active_plan is none, or one wiki-relative plan path whose frontmatter has status: active. A project created before 0.3 has no active_plan field; a missing field is read as none. -->\n',
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

  // 2. Managed-файлы возвращаются к прошлому каноническому содержимому.
  const vars = { projectName: displayName, date: FIXED_DATE, startingPoint };
  for (const template of BASELINE_TEMPLATES) {
    const source = await readFile(join(packageRoot(), template.source), 'utf8');
    await writeFile(join(root, template.path), renderTemplate(source, vars), 'utf8');
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
