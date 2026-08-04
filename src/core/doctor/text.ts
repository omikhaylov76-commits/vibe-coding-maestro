/** Чтение текста строго как UTF-8: неверная кодировка должна быть видимой ошибкой, а не «?». */
export function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    return null;
  }
}

/** Простой YAML frontmatter вида key: value. null означает «отсутствует или не разобран». */
export function frontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;
  const result: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const item = /^([a-z][a-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!item || !item[1] || !item[2]) return null;
    result[item[1]] = item[2];
  }
  return result;
}
