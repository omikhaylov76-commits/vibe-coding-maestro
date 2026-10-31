/**
 * Реестр опубликованных канонов: от каких версий upgrade умеет обновлять проект.
 *
 * Каждая запись — замороженный факт о прошлом: какие версии записывали этот
 * канон, точная форма `manifest.inventory` и sha256 исходника каждого
 * managed-файла. Core (init, doctor, inventory) по-прежнему знает только
 * текущий канон; знание о прошлом живёт здесь и в `baseline.ts`.
 *
 * Как выпускать новую версию:
 * - шаблоны и inventory не менялись — допишите версию в `versions` последней записи;
 * - изменились — заведите новую запись для новой версии, а в прошлой положите
 *   в `templates` копии изменённых исходников (`registry/baseline/<id>/project/…`).
 * Тест `tests/upgrade-releases.test.ts` не даст забыть ни то, ни другое.
 */

import {
  BASELINE_ID,
  BASELINE_MANAGED_SHA256,
  BASELINE_PRODUCT_VERSIONS,
  BASELINE_TEMPLATES,
  baselineOwnershipInventory,
} from './baseline.js';
import type { BaselineDepth, BaselineOwnership, BaselineTemplate } from './baseline.js';

export interface Release {
  /** Идентификатор канона в отчётах upgrade. */
  id: string;
  /** Опубликованные версии, которые записывали ровно этот канон. */
  versions: readonly string[];
  /** Точная форма `manifest.inventory`, которую записывал init этих версий. */
  inventory: (depth: BaselineDepth) => Readonly<Record<string, BaselineOwnership>>;
  /** sha256 исходника каждого managed-файла (LF), кроме пустых `.gitkeep`. */
  managedSha256: Readonly<Record<string, string>>;
  /** Копии исходников, которые отличаются от шаблонов текущей версии. */
  templates: readonly BaselineTemplate[];
}

/** TEMPLATE_FILES канона 0.3 (beta.1 — beta.4), заморожены. */
const V03_TEMPLATE_FILES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'wiki/index.md',
  'wiki/plans/README.md',
  'wiki/plans/TEMPLATE.md',
  'maestro/inbox/README.md',
  'maestro/runbooks/cowork-discovery.md',
  'maestro/runbooks/cowork-audit.md',
  'maestro/runbooks/cowork-plan.md',
  '.claude/commands/build.md',
  '.claude/commands/status.md',
  '.claude/commands/wiki.md',
  '.claude/commands/handoff.md',
  '.claude/commands/plan.md',
  '.claude/agents/code-reviewer.md',
  '.gitattributes',
  'protocols/build.md',
  'protocols/status.md',
  'protocols/wiki.md',
  'protocols/handoff.md',
  'protocols/discovery.md',
  'protocols/plan.md',
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

/** CONTENT_OWNED_FILES канона 0.3 (beta.1 — beta.4), заморожены. */
const V03_CONTENT_OWNED_FILES: readonly string[] = [
  'wiki/hot.md',
  'wiki/log.md',
  'wiki/roadmap.md',
  'wiki/concepts/discovery.md',
  'wiki/plans/0001-starter.md',
];

const V03_LAZY_DIRS: readonly string[] = [
  'maestro/sources',
  'maestro/runbooks',
  'wiki/progress',
  'wiki/decisions',
  'wiki/audits',
  'wiki/handoffs',
  'wiki/attic',
];

const V03_LIGHT_LAZY_DIRS: readonly string[] = ['maestro/sources', 'maestro/runbooks', 'wiki/progress', 'wiki/decisions'];

function v03LazyDirs(depth: BaselineDepth): readonly string[] {
  if (depth === 'light') return V03_LIGHT_LAZY_DIRS;
  if (depth === 'advanced') return [...V03_LAZY_DIRS, 'wiki/lessons'];
  return V03_LAZY_DIRS;
}

function v03OwnershipInventory(depth: BaselineDepth): Readonly<Record<string, BaselineOwnership>> {
  return {
    ...Object.fromEntries(V03_TEMPLATE_FILES.map((path) => [path, 'managed' as const])),
    ...Object.fromEntries(V03_CONTENT_OWNED_FILES.map((path) => [path, 'project-owned' as const])),
    ...Object.fromEntries(v03LazyDirs(depth).map((path) => [
      `${path}/.gitkeep`,
      path === 'maestro/sources' ? 'immutable' as const : 'managed' as const,
    ])),
    '.gitignore': 'project-owned',
    '.maestro/manifest.json': 'generated',
    '.maestro/checksums.json': 'generated',
  };
}

/** Слепок `templates/project` коммита d360a0e (0.3.0-beta.3); beta.1 и beta.2 совпадают с ним побайтово. */
const V03_BETA_MANAGED_SHA256: Readonly<Record<string, string>> = {
  'CLAUDE.md': '56c3654c7124679c65ba8c2393b39013d92ce96546f9ec10faff45feef5dfa9c',
  'AGENTS.md': 'e59e9fb1ebb94785bf7e0a48116a50a5b05e8610c9b791677100c71d54fbd539',
  'wiki/index.md': '903c939cbcd79c906b6b3731f7cbb95b9e574f521a78aa16a27ee1969b223517',
  'wiki/plans/README.md': 'ae2c00fc304841bb3bf19cfdaf467ab34eafbf13b8611df4b203f653ae467c7b',
  'wiki/plans/TEMPLATE.md': '6a4eb904f538e3e513c222577749637b43f2402f729be2d8622aad2c991025f7',
  'maestro/inbox/README.md': '5c3107b469d1c65d5a9d84132f2b0cfb85804b813ad5b9b65248dc434d6981a3',
  'maestro/runbooks/cowork-discovery.md': '1a32c070375783cfa54a3fad5c9644810f6eda37b7cd1a272f811278360b35c4',
  'maestro/runbooks/cowork-audit.md': 'c3326dfd63dc94bce1bd1779e2d8116685cf7281b7d902c58f9138db6343f50b',
  'maestro/runbooks/cowork-plan.md': '9f56abbd43aeb148f442f9a69fc45dd564264c0478defb385772cd55af9a50fb',
  '.claude/commands/build.md': '726794f26d3a74132182ab77212220bede8c6953120b272f662a4683547113d2',
  '.claude/commands/status.md': '5992b7a927a424539e5cb93fc8c29d109656038b4f5f3093bb3a50fb037e53d1',
  '.claude/commands/wiki.md': '0e31d996ab771ca3f0bd9f2c6d28771770eb0a84e3583b507f59780e6b2e73de',
  '.claude/commands/handoff.md': '359b98a760bbdef61baec6f3ee9377fd1aea458aaa393da5b6723aec7e13a12e',
  '.claude/commands/plan.md': '8ca0ebd187167adc528c07d37fc855ac7da275b7e87c8d7ed97aa7825b48896f',
  '.claude/agents/code-reviewer.md': 'b522bf8dfaef73df89c0045e98cee5636efea4b2787eef434b1c3700035c1568',
  '.gitattributes': 'e08d278fbed2c8aea79c22d307df5e34fc3b70fd419bd651a9b8824eee8fbdb2',
  'protocols/build.md': '616d73e765778dfd10551e4a6d6973b9685119c71062e90a4e8d6880cdcaf7e5',
  'protocols/status.md': '5614f012e8cac1f2071148e2685cbe1f9f94c8c5c72e59838fb072a39ccbb640',
  'protocols/wiki.md': 'c8c2f901e88d6c13595bbd41239755d823d278acdb9c0202aeb1b5832ef24632',
  'protocols/handoff.md': '7aec6bf47408b42fc4bb9e977664295c9461dfd69c3ff438676c99e2d2b86b80',
  'protocols/discovery.md': '20ef8084561a1c93a16003d3dac0426b43bb97b715f445f06ef79dd738e1430a',
  'protocols/plan.md': 'fe6c697b24d460a4da506b2f793e702b442798eb9bb0fbc08453af456188681a',
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

/** 0.3.0-beta.4: команды проекта закрепляют точную версию вместо `@latest`. */
const V03_BETA4_MANAGED_SHA256: Readonly<Record<string, string>> = {
  ...V03_BETA_MANAGED_SHA256,
  'CLAUDE.md': '81c52a84fb7c9c5f799c432159f5f950680255062d6295be380ee65142c5e3c5',
  'AGENTS.md': '2142c1291a8dd54122e10e8a9fde4b6fd9d0e055a23e20351c92d71370fd8bda',
  '.claude/commands/build.md': 'e677a3cb59f21e322cfd87e5b63ce6aac80446c1eeeb1c908ca5320391339cf0',
  'protocols/build.md': '875dc17f342c4e6c38a606f87c59af34c62f0cdd080d41bf27771d2667156cd0',
  'protocols/plan.md': '75a01fd5e604b4bcac9675174d6a9f77f6d8b5e80432ad0bdde453197646b6b4',
};

const v03BetaCopy = (path: string): BaselineTemplate => ({
  path,
  source: `registry/baseline/0.3-beta/project/${path}`,
  sha256: V03_BETA_MANAGED_SHA256[path] as string,
});

/** Копии шаблонов 0.3.0-beta.4, изменённых в 0.3.0. В beta.1–3 эти же файлы были побайтово такими же, кроме закреплённых команд. */
const v03Beta4Copy = (path: string): BaselineTemplate => ({
  path,
  source: `registry/baseline/0.3.0-beta.4/project/${path}`,
  sha256: V03_BETA4_MANAGED_SHA256[path] as string,
});

/** Пути, которые 0.3.0 изменил, не трогая версию: в 0.3-beta и beta.4 они одинаковы. */
const CHANGED_IN_030_SAME_SINCE_BETA1: readonly string[] = [
  'maestro/runbooks/cowork-audit.md',
  'wiki/index.md',
  'wiki/plans/README.md',
  'wiki/plans/TEMPLATE.md',
  '.claude/agents/code-reviewer.md',
  'protocols/wiki.md',
  'protocols/handoff.md',
  'protocols/context-budget.md',
];

/** TEMPLATE_FILES канона 0.3.0, заморожены. */
const V030_TEMPLATE_FILES: readonly string[] = [
  '.claude/rules/maestro.md',
  'wiki/plans/README.md',
  'wiki/plans/TEMPLATE.md',
  'maestro/inbox/README.md',
  'maestro/runbooks/cowork-discovery.md',
  'maestro/runbooks/cowork-audit.md',
  'maestro/runbooks/cowork-plan.md',
  '.claude/commands/build.md',
  '.claude/commands/status.md',
  '.claude/commands/wiki.md',
  '.claude/commands/handoff.md',
  '.claude/commands/plan.md',
  '.claude/agents/code-reviewer.md',
  '.claude/agents/explorer.md',
  'maestro/templates/handoff.md',
  'maestro/templates/adr.md',
  'maestro/templates/progress.md',
  '.gitattributes',
  'protocols/build.md',
  'protocols/status.md',
  'protocols/wiki.md',
  'protocols/handoff.md',
  'protocols/discovery.md',
  'protocols/plan.md',
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

/** CONTENT_OWNED_FILES канона 0.3.0, заморожены. */
const V030_CONTENT_OWNED_FILES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/rules/project.md',
  '.claude/settings.json',
  'wiki/index.md',
  'wiki/hot.md',
  'wiki/log.md',
  'wiki/roadmap.md',
  'wiki/concepts/discovery.md',
  'wiki/plans/0001-starter.md',
];

/** Форма inventory канонов 0.3.0 и новее: managed-шаблоны, файлы проекта, каталоги по глубине. */
function ownershipInventory(templateFiles: readonly string[], contentOwnedFiles: readonly string[]) {
  return (depth: BaselineDepth): Readonly<Record<string, BaselineOwnership>> => ({
    ...Object.fromEntries(templateFiles.map((path) => [path, 'managed' as const])),
    ...Object.fromEntries(contentOwnedFiles.map((path) => [path, 'project-owned' as const])),
    ...Object.fromEntries(v03LazyDirs(depth).map((path) => [
      `${path}/.gitkeep`,
      path === 'maestro/sources' ? 'immutable' as const : 'managed' as const,
    ])),
    '.gitignore': 'project-owned',
    '.maestro/manifest.json': 'generated',
    '.maestro/checksums.json': 'generated',
  });
}

const v030OwnershipInventory = ownershipInventory(V030_TEMPLATE_FILES, V030_CONTENT_OWNED_FILES);

/** Слепок `templates/project` 0.3.0. */
const V030_MANAGED_SHA256: Readonly<Record<string, string>> = {
  '.claude/rules/maestro.md': 'f30e231f962a1dd27f423f6173829ecf45c9df30ce50bcbd88dfd4db65e78da0',
  'wiki/plans/README.md': '58ebd5e72578ed963f81ebffbbf593930f20cc0d8ddc6a8d68c6a6caedbb7558',
  'wiki/plans/TEMPLATE.md': 'c1342f4578b42c7e23cde4caf010a3d7645141e274e284cfcdf2411469fe9dd4',
  'maestro/inbox/README.md': '5c3107b469d1c65d5a9d84132f2b0cfb85804b813ad5b9b65248dc434d6981a3',
  'maestro/runbooks/cowork-discovery.md': '1a32c070375783cfa54a3fad5c9644810f6eda37b7cd1a272f811278360b35c4',
  'maestro/runbooks/cowork-audit.md': '85b988f6079339ce188dd75aa781bc170c4fd0a8081fc7097705fa12648ebafa',
  'maestro/runbooks/cowork-plan.md': '9f56abbd43aeb148f442f9a69fc45dd564264c0478defb385772cd55af9a50fb',
  '.claude/commands/build.md': 'e677a3cb59f21e322cfd87e5b63ce6aac80446c1eeeb1c908ca5320391339cf0',
  '.claude/commands/status.md': '5992b7a927a424539e5cb93fc8c29d109656038b4f5f3093bb3a50fb037e53d1',
  '.claude/commands/wiki.md': '0e31d996ab771ca3f0bd9f2c6d28771770eb0a84e3583b507f59780e6b2e73de',
  '.claude/commands/handoff.md': '359b98a760bbdef61baec6f3ee9377fd1aea458aaa393da5b6723aec7e13a12e',
  '.claude/commands/plan.md': '8ca0ebd187167adc528c07d37fc855ac7da275b7e87c8d7ed97aa7825b48896f',
  '.claude/agents/code-reviewer.md': '8331683bcd2fea69bd7cf869f6daf2193beefff7ac8c629704511aff24ad227d',
  '.claude/agents/explorer.md': 'ba59cc4e6e91dfe47938cf95338ec834ad4cd6f43fdc50c24fd250d54538b95b',
  'maestro/templates/handoff.md': '2e5b16ac79f9dd9f247ff34330d2b92762a0861f35f71edfbb772eed3a80f9cc',
  'maestro/templates/adr.md': '31f54f50b444997a0edf066e8cc4a47b4b595cebb8280b2b7169b3df6cb757df',
  'maestro/templates/progress.md': '98927bc41afeeb23523abb0dbab8f0221b9ca8653b02475aa1a130cf8a6d00fc',
  '.gitattributes': 'e08d278fbed2c8aea79c22d307df5e34fc3b70fd419bd651a9b8824eee8fbdb2',
  'protocols/build.md': '8d65437a72972fe6ad0a4c02c8207e34ebba0ca40dbe37c6ce5e41a30b919785',
  'protocols/status.md': '5614f012e8cac1f2071148e2685cbe1f9f94c8c5c72e59838fb072a39ccbb640',
  'protocols/wiki.md': '4054ae1b6f0912430521baaf6230ebeb8263cbbf00195113291fb8206d3c5338',
  'protocols/handoff.md': '104a875baf39320d988fe07d9c3a9db6f94dd00015312c937b6fd1e58195a5a1',
  'protocols/discovery.md': '20ef8084561a1c93a16003d3dac0426b43bb97b715f445f06ef79dd738e1430a',
  'protocols/plan.md': 'a07b4c86bc2fb4990d5e1388e98a289ba88cf6fdf431af676a6ff94b2e3be856',
  'protocols/audit.md': 'c49f38b83db21af01f0f01552c7e8dc9743cd01c3ad12f3f31940f9cf83f76c6',
  'protocols/context-budget.md': '2747055ef1c39200043b24ed4ee7d59e93a05896b3a4ebd457f21fa725c7ab06',
  'protocols/seams.md': 'c7669b55b5d298cbfea97cd3c2284c9cb33aceacc9504e6e3ae3851e669ff5bd',
  'protocols/lessons.md': '04c94dbed682da746d46271fc2563d1e9ee79f3cd10a60d2d06762e3c1421d0e',
  'protocols/build/step-1-rules.md': '4a989545399e0492a9cffe1a88cbbe5ebd972f055f4a2871c33cbad224e46fac',
  'protocols/build/step-2-spec.md': '110f58dae0758974f6d15f186249fa1c4c3dd3967210287d28ce86654152e0e8',
  'protocols/build/step-3-architecture.md': 'ea2b0916a8289c0248318a348f992be91a57c8fdc69227029e4f822530dbada1',
  'protocols/build/step-5-feature-loop.md': '27856936f0217e02fbd0de8ba9172197fcccb3032037e8555695e156362bc9b0',
  'protocols/build/audit-plan.md': '1a6cd6e69044a1985822ed28809123d2980a223fb78e39aa63d4f5618bb66a64',
  'protocols/build/audit-phase.md': 'ac0c1919380516e3c0da09697b2a021a96866016816fb76d7aef2866c8c08f81',
};

/** 0.3.1: тот же состав файлов; в правилах Maestro управляемые команды названы поимённо. */
const V031_MANAGED_SHA256: Readonly<Record<string, string>> = {
  ...V030_MANAGED_SHA256,
  '.claude/rules/maestro.md': '340131be8c15a06fb7905452f000fa7dac775093c85370163c0af68c14198cae',
};

/** Копии шаблонов 0.3.1, изменённых в 0.4.0. В 0.3.0 протоколы были побайтово такими же. */
const v031Copy = (path: string): BaselineTemplate => ({
  path,
  source: `registry/baseline/0.3.1/project/${path}`,
  sha256: V031_MANAGED_SHA256[path] as string,
});

/** Файлы, которые 0.4.0 изменил: в 0.3.0 и 0.3.1 они одинаковы. */
const CHANGED_IN_040_SAME_SINCE_030: readonly string[] = ['.claude/agents/code-reviewer.md', '.claude/agents/explorer.md', 'protocols/build.md', 'protocols/handoff.md'];

/** Канон 0.4.0: протокол «Завершение» (Maestro) и паспорт проекта (проект). */
const V040_TEMPLATE_FILES: readonly string[] = [...V030_TEMPLATE_FILES, 'protocols/completion.md'];
const V040_CONTENT_OWNED_FILES: readonly string[] = [...V030_CONTENT_OWNED_FILES, 'wiki/passport.md'];

/** Слепок `templates/project` 0.4.0. */
const V040_MANAGED_SHA256: Readonly<Record<string, string>> = {
  ...V030_MANAGED_SHA256,
  '.claude/rules/maestro.md': '6c230aa2dbd3105f8afd242d7dfa6749499cca8e1b6d974ff496ba6e7928a930',
  '.claude/agents/code-reviewer.md': 'ce515ba41d042f6cd26475f693e1cb1a24a007d0d515d3876c467759e7a81f86',
  '.claude/agents/explorer.md': '27b8239748816977c5ee628782b43330a1b803df19899dd081a1962d71a42d13',
  'protocols/build.md': 'e7c1df3dc5b44ed6b03c4d83e28afcdc7e048b48fb20168f622238d6b7d502a9',
  'protocols/handoff.md': '4f01fb23b248d4acd1d5b917fc08971d763eeccf893286d58decc4b3345d1ce2',
  'protocols/completion.md': '7dba5ef6d31427c7cad88f6dd81218d48e978a1b88610f2a70c5eec736cdf302',
};

export const RELEASES: readonly Release[] = [
  {
    id: BASELINE_ID,
    versions: BASELINE_PRODUCT_VERSIONS,
    inventory: baselineOwnershipInventory,
    managedSha256: BASELINE_MANAGED_SHA256,
    templates: BASELINE_TEMPLATES,
  },
  {
    // beta.1 в npm не публиковалась, но ею созданы первые проекты на 0.3.
    id: '0.3-beta',
    versions: ['0.3.0-beta.1', '0.3.0-beta.2', '0.3.0-beta.3'],
    inventory: v03OwnershipInventory,
    managedSha256: V03_BETA_MANAGED_SHA256,
    templates: [
      ...['CLAUDE.md', 'AGENTS.md', '.claude/commands/build.md', 'protocols/build.md', 'protocols/plan.md'].map(v03BetaCopy),
      ...CHANGED_IN_030_SAME_SINCE_BETA1.map(v03Beta4Copy),
    ],
  },
  {
    id: '0.3.0-beta.4',
    versions: ['0.3.0-beta.4'],
    inventory: v03OwnershipInventory,
    managedSha256: V03_BETA4_MANAGED_SHA256,
    templates: ['CLAUDE.md', 'AGENTS.md', 'protocols/build.md', 'protocols/plan.md', ...CHANGED_IN_030_SAME_SINCE_BETA1].map(v03Beta4Copy),
  },
  {
    id: '0.3.0',
    versions: ['0.3.0'],
    inventory: v030OwnershipInventory,
    managedSha256: V030_MANAGED_SHA256,
    templates: [
      {
        path: '.claude/rules/maestro.md',
        source: 'registry/baseline/0.3.0/project/.claude/rules/maestro.md',
        sha256: V030_MANAGED_SHA256['.claude/rules/maestro.md'] as string,
      },
      ...CHANGED_IN_040_SAME_SINCE_030.map(v031Copy),
    ],
  },
  {
    id: '0.3.1',
    versions: ['0.3.1'],
    inventory: v030OwnershipInventory,
    managedSha256: V031_MANAGED_SHA256,
    templates: ['.claude/rules/maestro.md', ...CHANGED_IN_040_SAME_SINCE_030].map(v031Copy),
  },
  {
    id: '0.4.0',
    versions: ['0.4.0'],
    inventory: ownershipInventory(V040_TEMPLATE_FILES, V040_CONTENT_OWNED_FILES),
    managedSha256: V040_MANAGED_SHA256,
    templates: [],
  },
];

export function findRelease(version: string): Release | undefined {
  return RELEASES.find((release) => release.versions.includes(version));
}

/** Все версии, с которых upgrade умеет обновлять, по порядку выпуска. */
export function supportedVersions(): string[] {
  return RELEASES.flatMap((release) => [...release.versions]);
}
