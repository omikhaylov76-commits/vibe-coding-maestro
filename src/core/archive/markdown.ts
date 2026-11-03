/** Строка текста со смещением; `code` — строка блока кода, вместе с его ограждениями. */
export interface MarkdownLine {
  line: string;
  offset: number;
  code: boolean;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Строки с пометкой блоков кода: закрывает блок то же ограждение, не короче открывшего. */
export function markdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let open: string | null = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const fence = FENCE_RE.exec(line.replace(/\r?\n$/, ''));
    const marker = fence?.[1] ?? '';
    const rest = fence?.[2] ?? '';
    if (open === null) {
      const opens = fence !== null && !(marker.startsWith('`') && rest.includes('`'));
      if (opens) open = marker;
      lines.push({ line, offset, code: opens });
    } else {
      if (fence !== null && marker[0] === open[0] && marker.length >= open.length && rest.trim() === '') open = null;
      lines.push({ line, offset, code: true });
    }
    offset += line.length;
  }
  return lines;
}

export const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** Разборы (frontmatter, отпечаток) работают с текстом без BOM, как его читает doctor; записывается текст с BOM. */
export const withoutBom = (text: string): string => text.replace(/^\uFEFF/, '');
