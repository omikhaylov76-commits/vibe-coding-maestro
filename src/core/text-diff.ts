/**
 * Построчное сравнение двух текстов без зависимостей: что убрать, что добавить.
 *
 * Общие начало и конец отрезаются сразу, середина сравнивается по наибольшей
 * общей подпоследовательности строк. Файлы Maestro — сотни строк, поэтому
 * квадратная таблица на одну середину дешёвая; слишком большая середина
 * показывается целиком как «убрать всё старое, добавить всё новое».
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

export interface DiffHunk {
  /** Первая строка куска в прежнем и новом тексте, с единицы (как в unified diff). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface TextDiff {
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

/** Больше клеток таблица не строится: такой файл не правка, а замена. */
const MAX_TABLE_CELLS = 4_000_000;

/** Строки текста; перевод строки в конце не даёт лишней пустой строки. CRLF считается LF. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Полная последовательность строк: общие, убранные и добавленные, по порядку. */
export function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;

  const a = before.slice(prefix, before.length - suffix);
  const b = after.slice(prefix, after.length - suffix);
  const lines: DiffLine[] = before.slice(0, prefix).map((text) => ({ kind: 'same', text }));

  if ((a.length + 1) * (b.length + 1) > MAX_TABLE_CELLS) {
    lines.push(...a.map((text) => ({ kind: 'remove' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text })));
  } else {
    // table[i * width + j] — длина общей подпоследовательности хвостов a[i..] и b[j..].
    const width = b.length + 1;
    const table = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        lines.push({ kind: 'same', text: a[i] as string });
        i += 1;
        j += 1;
      } else if (j === b.length || (i < a.length && (table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number))) {
        // При равенстве сначала убранное: так читается привычнее («было — стало»).
        lines.push({ kind: 'remove', text: a[i] as string });
        i += 1;
      } else {
        lines.push({ kind: 'add', text: b[j] as string });
        j += 1;
      }
    }
  }

  lines.push(...before.slice(before.length - suffix).map((text) => ({ kind: 'same' as const, text })));
  return lines;
}

/** Куски правок с `context` общими строками вокруг; далёкие правки — отдельными кусками. */
export function diffText(before: string, after: string, context = 3): TextDiff {
  const lines = diffLines(splitLines(before), splitLines(after));
  const added = lines.filter((line) => line.kind === 'add').length;
  const removed = lines.filter((line) => line.kind === 'remove').length;
  const changed = lines.flatMap((line, index) => (line.kind === 'same' ? [] : [index]));

  const hunks: DiffHunk[] = [];
  let start = 0;
  while (start < changed.length) {
    let end = start;
    // Правки, между которыми не больше 2 × context общих строк, идут одним куском.
    while (end + 1 < changed.length && (changed[end + 1] as number) - (changed[end] as number) <= 2 * context + 1) end += 1;
    const from = Math.max(0, (changed[start] as number) - context);
    const to = Math.min(lines.length, (changed[end] as number) + context + 1);

    let oldStart = 1;
    let newStart = 1;
    for (const line of lines.slice(0, from)) {
      if (line.kind !== 'add') oldStart += 1;
      if (line.kind !== 'remove') newStart += 1;
    }
    const slice = lines.slice(from, to);
    const oldLines = slice.filter((line) => line.kind !== 'add').length;
    const newLines = slice.filter((line) => line.kind !== 'remove').length;
    // Как в unified diff: у пустой стороны номер — строка перед куском.
    hunks.push({ oldStart: oldLines === 0 ? oldStart - 1 : oldStart, oldLines, newStart: newLines === 0 ? newStart - 1 : newStart, newLines, lines: slice });
    start = end + 1;
  }
  return { added, removed, hunks };
}

/** Кусок в привычном виде unified diff: заголовок `@@ … @@` и строки с « », «-», «+». */
export function formatHunk(hunk: DiffHunk): string[] {
  const mark = { same: ' ', add: '+', remove: '-' } as const;
  return [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines.map((line) => `${mark[line.kind]}${line.text}`),
  ];
}
