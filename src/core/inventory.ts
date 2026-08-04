/** Доверенный inventory обязательных системных путей, поставляемый с этой версией пакета. */
export const TEMPLATE_FILES: readonly string[] = [
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

/** Стартовые содержательные документы: Maestro создаёт, затем ими владеет проект. */
export const CONTENT_OWNED_FILES: readonly string[] = [
  'wiki/hot.md',
  'wiki/log.md',
  'wiki/roadmap.md',
  'wiki/concepts/discovery.md',
];

export const LAZY_DIRS: readonly string[] = [
  'maestro/sources',
  'maestro/runbooks',
  'wiki/progress',
  'wiki/decisions',
  'wiki/audits',
  'wiki/handoffs',
  'wiki/attic',
];

export const LIGHT_LAZY_DIRS: readonly string[] = [
  'maestro/sources',
  'maestro/runbooks',
  'wiki/progress',
  'wiki/decisions',
];

export const ADVANCED_LAZY_DIRS: readonly string[] = [...LAZY_DIRS, 'wiki/lessons'];

export type InventoryDepth = 'light' | 'standard' | 'advanced';
export type CanonicalOwnership = 'managed' | 'generated' | 'project-owned' | 'immutable';

export function lazyDirsForDepth(depth: InventoryDepth): readonly string[] {
  if (depth === 'light') return LIGHT_LAZY_DIRS;
  if (depth === 'advanced') return ADVANCED_LAZY_DIRS;
  return LAZY_DIRS;
}

export function canonicalOwnershipInventory(depth: InventoryDepth): Readonly<Record<string, CanonicalOwnership>> {
  return {
    ...Object.fromEntries(TEMPLATE_FILES.map((path) => [path, 'managed' as const])),
    ...Object.fromEntries(CONTENT_OWNED_FILES.map((path) => [path, 'project-owned' as const])),
    ...Object.fromEntries(lazyDirsForDepth(depth).map((path) => [`${path}/.gitkeep`, path === 'maestro/sources' ? 'immutable' as const : 'managed' as const])),
    '.gitignore': 'project-owned',
    '.maestro/manifest.json': 'generated',
    '.maestro/checksums.json': 'generated',
  };
}

export type CanonicalManagedKind = 'managed' | 'merged' | 'generated';

/** Совместимая проекция canonical ownership в legacy-поле manifest.managed. */
export function canonicalManagedKind(path: string, ownership: CanonicalOwnership): CanonicalManagedKind {
  if (ownership === 'managed' || ownership === 'immutable') return 'managed';
  if (ownership === 'generated') return 'generated';
  return path === '.gitignore' ? 'merged' : 'generated';
}
