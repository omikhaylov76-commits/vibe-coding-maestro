/** Доверенный inventory обязательных системных путей, поставляемый с этой версией пакета. */
export const TEMPLATE_FILES: readonly string[] = [
  'CLAUDE.md',
  'AGENTS.md',
  'wiki/hot.md',
  'wiki/index.md',
  'wiki/log.md',
  'wiki/roadmap.md',
  'maestro/inbox/README.md',
  'maestro/runbooks/cowork-discovery.md',
  'maestro/runbooks/cowork-audit.md',
  '.claude/commands/build.md',
  '.claude/commands/status.md',
  '.claude/commands/wiki.md',
  '.claude/commands/handoff.md',
  '.claude/agents/code-reviewer.md',
  '.gitattributes',
];

/** Стартовые содержательные документы: Maestro создаёт, затем ими владеет проект. */
export const CONTENT_OWNED_FILES: readonly string[] = [
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

export const TRUSTED_MANAGED_INVENTORY: Readonly<Record<string, 'managed' | 'merged' | 'generated'>> = {
  ...Object.fromEntries(TEMPLATE_FILES.map((path) => [path, 'managed' as const])),
  ...Object.fromEntries(CONTENT_OWNED_FILES.map((path) => [path, 'generated' as const])),
  ...Object.fromEntries(LAZY_DIRS.map((path) => [`${path}/.gitkeep`, 'managed' as const])),
  '.gitignore': 'merged',
  '.maestro/manifest.json': 'generated',
  '.maestro/checksums.json': 'generated',
};
