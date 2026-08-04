import { PRODUCT_NAME } from './meta.js';

/**
 * Минимальный обязательный набор правил.
 * Порядок важен: отрицание !.env.example должно идти после .env.*
 */
export const REQUIRED_GITIGNORE_ENTRIES: readonly string[] = [
  'node_modules/',
  '/dist/',
  '/build/',
  '/coverage/',
  '.env',
  '.env.*',
  '!.env.example',
  '*.log',
  '.DS_Store',
];

const BLOCK_HEADER = `# --- ${PRODUCT_NAME} ---`;

export interface GitignoreMergeResult {
  content: string;
  created: boolean;
  changed: boolean;
  addedEntries: string[];
}

/**
 * Приводит строку .gitignore к сравнимому виду.
 * node_modules и node_modules/ считаются одной записью, отступы не значимы.
 */
function normalizeEntry(line: string): string {
  return line.trim().replace(/\/+$/, '');
}

function isMeaningful(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== '' && !trimmed.startsWith('#');
}

/**
 * Построчное безопасное слияние .gitignore.
 *
 * Гарантии:
 * - существующее содержимое сохраняется без изменений и остаётся префиксом результата;
 * - сравнение построчное, а не по подстроке (комментарий про node_modules не считается правилом);
 * - повторный вызов не добавляет дубликатов;
 * - стиль переводов строк существующего файла сохраняется.
 */
export function mergeGitignore(
  existing: string | null,
  requiredEntries: readonly string[] = REQUIRED_GITIGNORE_ENTRIES,
): GitignoreMergeResult {
  const created = existing === null || existing === '';
  const source = existing ?? '';
  const eol = source.includes('\r\n') ? '\r\n' : '\n';

  const present = new Set(
    source
      .split(/\r?\n/)
      .filter(isMeaningful)
      .map(normalizeEntry),
  );

  const addedEntries: string[] = [];
  for (const entry of requiredEntries) {
    const normalized = normalizeEntry(entry);
    if (present.has(normalized)) continue;
    present.add(normalized);
    addedEntries.push(entry);
  }

  let base = source;
  if (base !== '' && !base.endsWith('\n')) base += eol;

  if (addedEntries.length === 0) {
    return { content: base, created, changed: created && base !== source, addedEntries };
  }

  const block: string[] = [];
  if (base !== '') block.push('');
  block.push(BLOCK_HEADER, ...addedEntries);

  return {
    content: base + block.join(eol) + eol,
    created,
    changed: true,
    addedEntries,
  };
}
