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
 * их с фактическим 0.2-деревом: его слепок живёт здесь же, в
 * `BASELINE_MANAGED_SHA256`.
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

/**
 * Слепок фактического 0.2-дерева: sha256 исходника КАЖДОГО managed-пути того канона.
 *
 * Снят с `templates/project` коммита 20ebe810d904afbe0f401cff77440a4c0b84e8aa и
 * нормализован по LF. `.gitattributes` шаблоном на диске не был — его писала
 * константа init 0.2, поэтому здесь стоит сумма её содержимого.
 *
 * Это единственная опора, независимая от `BASELINE_TEMPLATES`: без неё вопрос
 * «какие managed-файлы 0.3 действительно изменил» пришлось бы задавать самому
 * списку, и тест сравнивал бы список сам с собой. Здесь же он сравнивается с
 * прошлым: путь, чей текущий шаблон разошёлся с записанной суммой, обязан быть
 * в `BASELINE_TEMPLATES`, а совпавший — не имеет права там оказаться.
 */
export const BASELINE_MANAGED_SHA256: Readonly<Record<string, string>> = {
  'CLAUDE.md': 'da2adc9afeb7dc0908177e5eb2492e445697df27ea5be9d3f3dab11387984c02',
  'AGENTS.md': 'c494ae4ecd4a27eb7dd4ec857841684352ea407106ab7a314aa17028db12b495',
  'wiki/index.md': 'a6989e7ac718c72157adf2ff80eef7921701f83b45b7da60a9569cfbf1bc538a',
  'maestro/inbox/README.md': '5c3107b469d1c65d5a9d84132f2b0cfb85804b813ad5b9b65248dc434d6981a3',
  'maestro/runbooks/cowork-discovery.md': '1a32c070375783cfa54a3fad5c9644810f6eda37b7cd1a272f811278360b35c4',
  'maestro/runbooks/cowork-audit.md': 'c3326dfd63dc94bce1bd1779e2d8116685cf7281b7d902c58f9138db6343f50b',
  '.claude/commands/build.md': 'aac17f7752c67645e7e5b027ffc08f9a144f075aa06acf7208853070c0b4c3c7',
  '.claude/commands/status.md': '5992b7a927a424539e5cb93fc8c29d109656038b4f5f3093bb3a50fb037e53d1',
  '.claude/commands/wiki.md': '0e31d996ab771ca3f0bd9f2c6d28771770eb0a84e3583b507f59780e6b2e73de',
  '.claude/commands/handoff.md': '359b98a760bbdef61baec6f3ee9377fd1aea458aaa393da5b6723aec7e13a12e',
  '.claude/agents/code-reviewer.md': 'b522bf8dfaef73df89c0045e98cee5636efea4b2787eef434b1c3700035c1568',
  '.gitattributes': 'e08d278fbed2c8aea79c22d307df5e34fc3b70fd419bd651a9b8824eee8fbdb2',
  'protocols/build.md': '2ce00c73e5f3c03bee48e1b34ce34c8253383e2a9469feb5ae05b87b68c1a499',
  'protocols/status.md': '5614f012e8cac1f2071148e2685cbe1f9f94c8c5c72e59838fb072a39ccbb640',
  'protocols/wiki.md': 'c8c2f901e88d6c13595bbd41239755d823d278acdb9c0202aeb1b5832ef24632',
  'protocols/handoff.md': '7aec6bf47408b42fc4bb9e977664295c9461dfd69c3ff438676c99e2d2b86b80',
  'protocols/discovery.md': '20ef8084561a1c93a16003d3dac0426b43bb97b715f445f06ef79dd738e1430a',
  'protocols/audit.md': 'c49f38b83db21af01f0f01552c7e8dc9743cd01c3ad12f3f31940f9cf83f76c6',
  'protocols/context-budget.md': 'e121d6dc75de04ea3624608be5f778d43e99afa815540738ec3a43e47ccdcf8c',
  'protocols/seams.md': 'c7669b55b5d298cbfea97cd3c2284c9cb33aceacc9504e6e3ae3851e669ff5bd',
  'protocols/lessons.md': '04c94dbed682da746d46271fc2563d1e9ee79f3cd10a60d2d06762e3c1421d0e',
  'protocols/build/step-1-rules.md': '4a989545399e0492a9cffe1a88cbbe5ebd972f055f4a2871c33cbad224e46fac',
  'protocols/build/step-2-spec.md': '110f58dae0758974f6d15f186249fa1c4c3dd3967210287d28ce86654152e0e8',
  'protocols/build/step-3-architecture.md': 'ea2b0916a8289c0248318a348f992be91a57c8fdc69227029e4f822530dbada1',
  'protocols/build/step-5-feature-loop.md': '27856936f0217e02fbd0de8ba9172197fcccb3032037e8555695e156362bc9b0',
  'protocols/build/audit-plan.md': '1a6cd6e69044a1985822ed28809123d2980a223fb78e39aa63d4f5618bb66a64',
  'protocols/build/audit-phase.md': 'ac0c1919380516e3c0da09697b2a021a96866016816fb76d7aef2866c8c08f81',
};

export const BASELINE_TEMPLATES: readonly BaselineTemplate[] = [
  { path: 'CLAUDE.md', source: 'registry/baseline/0.2/project/CLAUDE.md', sha256: 'da2adc9afeb7dc0908177e5eb2492e445697df27ea5be9d3f3dab11387984c02' },
  { path: 'AGENTS.md', source: 'registry/baseline/0.2/project/AGENTS.md', sha256: 'c494ae4ecd4a27eb7dd4ec857841684352ea407106ab7a314aa17028db12b495' },
  { path: 'wiki/index.md', source: 'registry/baseline/0.2/project/wiki/index.md', sha256: 'a6989e7ac718c72157adf2ff80eef7921701f83b45b7da60a9569cfbf1bc538a' },
  { path: '.claude/commands/build.md', source: 'registry/baseline/0.2/project/.claude/commands/build.md', sha256: 'aac17f7752c67645e7e5b027ffc08f9a144f075aa06acf7208853070c0b4c3c7' },
  { path: 'protocols/build.md', source: 'registry/baseline/0.2/project/protocols/build.md', sha256: '2ce00c73e5f3c03bee48e1b34ce34c8253383e2a9469feb5ae05b87b68c1a499' },
];
