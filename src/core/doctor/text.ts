/** Чтение текста строго как UTF-8: неверная кодировка должна быть видимой ошибкой, а не «?». */
export function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    return null;
  }
}

/** YAML-строка в кавычках — та же строка: агенты часто пишут "2026-10-31" и 'active'. */
function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? '') : value;
}

/** Есть ли у текста блок frontmatter между строками `---` в самом начале. */
export function hasFrontmatterBlock(text: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text);
}

/**
 * Простой YAML frontmatter: строки `key: value`. Допускаются пустые строки,
 * комментарии `# …` и блочный список под ключом без значения (`key:` и строки
 * `  - item`): он читается как `[item, item]`, то есть так же, как flow-список.
 * null означает «отсутствует или не разобран».
 */
export function frontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const result: Record<string, string> = {};
  let listKey: string | null = null;
  let listItems: string[] = [];
  const closeList = (): void => {
    if (listKey !== null) result[listKey] = `[${listItems.join(', ')}]`;
    listKey = null;
    listItems = [];
  };
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const listItem = /^\s+-\s+(.*?)\s*$/.exec(line);
    if (listItem) {
      if (listKey === null || !listItem[1]) return null;
      listItems.push(unquote(listItem[1]));
      continue;
    }
    closeList();
    const item = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!item || !item[1]) return null;
    if (!item[2]) { listKey = item[1]; continue; }
    result[item[1]] = unquote(item[2].replace(/\s+#.*$/, ''));
  }
  closeList();
  return result;
}
