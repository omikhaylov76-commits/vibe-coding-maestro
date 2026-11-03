import { rebaseLinks } from './links.js';
import { countChars, LOG_KEEP, LOG_LIMIT } from './limits.js';

export const LOG_PATH = 'wiki/log.md';
export const LOG_DIR = 'wiki/log';

/** Строка в шапке `wiki/log.md`: добавляется при первом переносе, повтор узнаётся по тексту. */
export const LOG_POINTER = 'Старые записи — по месяцам в [log/](log/).';

export interface LogEntry {
  /** Месяц записи `ГГГГ-ММ`. */
  month: string;
  /** Текст записи байт в байт: от её заголовка до следующей датированной записи. */
  text: string;
}

export interface ParsedLog {
  /** Всё до первой датированной записи: frontmatter, правила журнала. */
  preamble: string;
  entries: LogEntry[];
}

const FENCE_RE = /^ {0,3}(?:```|~~~)/;
const HEADING_RE = /^##[ \t]/;
/** Дата — в начале заголовка, можно в квадратных скобках: `## 2026-10-12 — …`, `## [2026-10-19] build | …`. */
const DATED_RE = /^##[ \t]+\[?(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!\d)/;

/**
 * Записи журнала — блоки от `## ` до следующего `## ` вне блоков кода. Блок без даты
 * едет с предыдущей записью, а до первой датированной записи всё — шапка.
 */
export function parseLog(text: string): ParsedLog {
  const starts: { offset: number; month: string }[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (FENCE_RE.test(line)) fenced = !fenced;
    else if (!fenced && HEADING_RE.test(line)) {
      const date = DATED_RE.exec(line);
      if (date !== null) starts.push({ offset, month: `${date[1]}-${date[2]}` });
    }
    offset += line.length;
  }
  if (starts.length === 0) return { preamble: text, entries: [] };
  return {
    preamble: text.slice(0, starts[0]!.offset),
    entries: starts.map((start, index) => ({ month: start.month, text: text.slice(start.offset, starts[index + 1]?.offset ?? text.length) })),
  };
}

export interface LogRotation {
  /** Знаков в `wiki/log.md` сейчас. */
  chars: number;
  keptEntries: number;
  /** Новый текст `wiki/log.md`. */
  log: string;
  /** Файлы месяцев: путь → записи, которые к нему добавляются (уже с поправленными адресами). */
  months: { path: string; entries: number; appended: string }[];
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** Шапка нового файла месяца. */
export function monthHeader(month: string, eol: string): string {
  return `# Журнал: ${month}${eol}${eol}Записи, перенесённые из [log.md](../log.md) командой \`vibe-maestro archive\`: текст прежний, поправлены только адреса ссылок. Новые записи пишутся в \`wiki/log.md\`.${eol}${eol}`;
}

/**
 * Перенос по порогу: `wiki/log.md` больше `LOG_LIMIT` знаков — в нём остаются
 * последние записи на `LOG_KEEP` знаков (минимум одна), старые уходят в файлы
 * месяцев. Нечего переносить — `null`.
 */
export function rotateLog(text: string, moved: ReadonlyMap<string, string> = new Map()): LogRotation | null {
  const chars = countChars(text);
  if (chars <= LOG_LIMIT) return null;
  const { preamble, entries } = parseLog(text);
  let kept = 0;
  let keptChars = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = countChars(entries[index]!.text);
    if (kept > 0 && keptChars + size > LOG_KEEP) break;
    kept += 1;
    keptChars += size;
  }
  const leaving = entries.slice(0, entries.length - kept);
  if (leaving.length === 0) return null;

  const eol = eolOf(text);
  const months = new Map<string, { entries: number; appended: string }>();
  for (const entry of leaving) {
    const path = `${LOG_DIR}/${entry.month}.md`;
    const current = months.get(path) ?? { entries: 0, appended: '' };
    current.entries += 1;
    current.appended += rebaseLinks(entry.text, LOG_PATH, path, moved);
    months.set(path, current);
  }
  const head = preamble.includes(LOG_POINTER)
    ? preamble
    : `${preamble.replace(/(?:\r?\n)+$/, '')}${preamble.trim() === '' ? '' : `${eol}${eol}`}${LOG_POINTER}${eol}${eol}`;
  const rest = entries.slice(entries.length - kept).map((entry) => rebaseLinks(entry.text, LOG_PATH, LOG_PATH, moved)).join('');
  return {
    chars,
    keptEntries: kept,
    log: head + rest,
    months: [...months.entries()].map(([path, value]) => ({ path, ...value })),
  };
}

/** Текст файла месяца после дописывания: новый — с шапкой, прежний — с переводом строки перед дописанным. */
export function appendToMonth(existing: string | null, month: string, appended: string, eol: string): string {
  if (existing === null) return monthHeader(month, eol) + appended;
  return existing === '' || existing.endsWith('\n') ? existing + appended : existing + eol + appended;
}

export { eolOf };
