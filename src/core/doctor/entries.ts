import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { warning } from './types.js';
import type { DoctorFinding } from './types.js';

const ENTRY_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;
const SETTINGS_PATH = '.claude/settings.json';

async function readOptional(absolute: string): Promise<string | null> {
  try {
    return await readFile(absolute, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Двери и настройки принадлежат проекту, и их содержимое doctor не сверяет. Но две
 * ошибки в них тихо ломают работу агента: команда Maestro другой версии (она остаётся
 * в файле, который проект правил до перехода на 0.3.0) и битый JSON настроек, который
 * Claude Code пропускает целиком — вместе с запретами.
 */
export async function checkProjectEntries(root: string, projectVersion: string, findings: DoctorFinding[]): Promise<void> {
  for (const path of ENTRY_FILES) {
    const text = await readOptional(join(root, path));
    if (text === null) continue;
    for (const match of text.matchAll(/create-vibe-maestro@([^\s`'"]+)\s+vibe-maestro/g)) {
      if (match[1] === projectVersion) continue;
      findings.push(warning(
        'entry-stale-command',
        `В ${path} записана команда Maestro версии ${match[1]}, а проект на ${projectVersion}. Актуальная команда — в .claude/rules/maestro.md; обновите или удалите эту строку.`,
        path,
      ));
      break;
    }
  }
  const settings = await readOptional(join(root, SETTINGS_PATH));
  if (settings === null) return;
  try {
    JSON.parse(settings);
  } catch {
    findings.push(warning('settings-json-invalid', 'Файл не разбирается как JSON: Claude Code пропустит его целиком, вместе с запретами. Исправьте JSON.', SETTINGS_PATH));
  }
}
