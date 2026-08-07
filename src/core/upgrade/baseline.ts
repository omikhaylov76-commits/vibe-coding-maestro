/**
 * Замороженный факт о предыдущем каноне (0.2 beta).
 *
 * Это единственное место, где живут знания о прошлой версии. Core (init, doctor,
 * inventory, manifest) описывает ТОЛЬКО текущий канон и никогда не спрашивает,
 * «а как было раньше»: зависимость направлена строго upgrade → core. Любая ветка
 * совместимости внутри core превратилась бы в угаданный converter.
 *
 * Списки ниже скопированы из `src/core/inventory.ts` на коммите 0.2 beta и
 * заморожены навсегда: они описывают прошлое, поэтому не имеют права следовать
 * за изменениями текущего inventory. Дрейф ловится тестом, который сравнивает
 * их с фактическим 0.2-деревом.
 */

export const BASELINE_ID = '0.2-canonical';

/**
 * Версии продукта, для которых этот baseline признаётся.
 *
 * Версия сама по себе НЕ является доказательством предшественника: строку в
 * манифесте может написать кто угодно, а ранние сборки текущей ветки публиковали
 * ту же строку. Она лишь отсекает заведомо чужие пакеты. Настоящее доказательство
 * предшественника — точная форма inventory.
 */
export const BASELINE_PRODUCT_VERSIONS: readonly string[] = ['0.2.0-beta.1'];

/** TEMPLATE_FILES канона 0.2. */
export const BASELINE_TEMPLATE_FILES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'wiki/index.md',
  'maestro/inbox/README.md',
  'maestro/runbooks/cowork-discovery.md',
  'maestro/runbooks/cowork-audit.md',
  '.claude/commands/build.md',
  '.claude/commands/status.md',
  '.claude/commands/wiki.md',
  '.claude/commands/handoff.md',
  '.claude/agents/code-reviewer.md',
  '.gitattributes',
  'protocols/build.md',
  'protocols/status.md',
  'protocols/wiki.md',
  'protocols/handoff.md',
  'protocols/discovery.md',
  'protocols/audit.md',
  'protocols/context-budget.md',
  'protocols/seams.md',
  'protocols/lessons.md',
  'protocols/build/step-1-rules.md',
  'protocols/build/step-2-spec.md',
  'protocols/build/step-3-architecture.md',
  'protocols/build/step-5-feature-loop.md',
  'protocols/build/audit-plan.md',
  'protocols/build/audit-phase.md',
];

/** CONTENT_OWNED_FILES канона 0.2. */
export const BASELINE_CONTENT_OWNED_FILES: readonly string[] = [
  'wiki/hot.md',
  'wiki/log.md',
  'wiki/roadmap.md',
  'wiki/concepts/discovery.md',
];

const BASELINE_LAZY_DIRS: readonly string[] = [
  'maestro/sources',
  'maestro/runbooks',
  'wiki/progress',
  'wiki/decisions',
  'wiki/audits',
  'wiki/handoffs',
  'wiki/attic',
];

const BASELINE_LIGHT_LAZY_DIRS: readonly string[] = [
  'maestro/sources',
  'maestro/runbooks',
  'wiki/progress',
  'wiki/decisions',
];

const BASELINE_ADVANCED_LAZY_DIRS: readonly string[] = [...BASELINE_LAZY_DIRS, 'wiki/lessons'];

export type BaselineDepth = 'light' | 'standard' | 'advanced';
export type BaselineOwnership = 'managed' | 'generated' | 'project-owned' | 'immutable';

export function baselineLazyDirs(depth: BaselineDepth): readonly string[] {
  if (depth === 'light') return BASELINE_LIGHT_LAZY_DIRS;
  if (depth === 'advanced') return BASELINE_ADVANCED_LAZY_DIRS;
  return BASELINE_LAZY_DIRS;
}

/** Точная форма `manifest.inventory`, которую записывал init 0.2. */
export function baselineOwnershipInventory(depth: BaselineDepth): Readonly<Record<string, BaselineOwnership>> {
  return {
    ...Object.fromEntries(BASELINE_TEMPLATE_FILES.map((path) => [path, 'managed' as const])),
    ...Object.fromEntries(BASELINE_CONTENT_OWNED_FILES.map((path) => [path, 'project-owned' as const])),
    ...Object.fromEntries(baselineLazyDirs(depth).map((path) => [
      `${path}/.gitkeep`,
      path === 'maestro/sources' ? 'immutable' as const : 'managed' as const,
    ])),
    '.gitignore': 'project-owned',
    '.maestro/manifest.json': 'generated',
    '.maestro/checksums.json': 'generated',
  };
}

/**
 * Managed-файлы, содержимое которых 0.3 обязан обновить, вместе с их прошлым
 * каноническим источником.
 *
 * Список содержит РОВНО те пути, которые upgrade имеет право перезаписать.
 * Managed-файл, который новый канон не меняет, сюда не входит: требовать его
 * неизменности значило бы блокировать обновление из-за правки в файле, который
 * никто не собирался трогать.
 *
 * `source` — точная копия шаблона 0.2, поставляемая в пакете; `sha256` — сумма
 * этой копии, нормализованной по LF. Пакет проверяет её перед тем, как считать
 * baseline авторитетом: испорченный или подменённый baseline не имеет права
 * разрешать перезапись файлов проекта.
 */
export interface BaselineTemplate {
  /** Путь внутри проекта. */
  path: string;
  /** Путь копии шаблона 0.2 относительно корня пакета. */
  source: string;
  /** sha256 копии шаблона 0.2 (LF-нормализованной). */
  sha256: string;
}

export const BASELINE_TEMPLATES: readonly BaselineTemplate[] = [
  { path: 'CLAUDE.md', source: 'registry/baseline/0.2/project/CLAUDE.md', sha256: 'da2adc9afeb7dc0908177e5eb2492e445697df27ea5be9d3f3dab11387984c02' },
  { path: 'AGENTS.md', source: 'registry/baseline/0.2/project/AGENTS.md', sha256: 'c494ae4ecd4a27eb7dd4ec857841684352ea407106ab7a314aa17028db12b495' },
  { path: 'wiki/index.md', source: 'registry/baseline/0.2/project/wiki/index.md', sha256: 'a6989e7ac718c72157adf2ff80eef7921701f83b45b7da60a9569cfbf1bc538a' },
  { path: 'protocols/build.md', source: 'registry/baseline/0.2/project/protocols/build.md', sha256: '2ce00c73e5f3c03bee48e1b34ce34c8253383e2a9469feb5ae05b87b68c1a499' },
];
