/**
 * Локальные ссылки Markdown — ровно те, что проверяет doctor (`wiki-link-broken`).
 *
 * Один поиск для doctor и archive: если archive правил бы ссылки иначе, чем их
 * видит doctor, после переноса появились бы битые. Поэтому ищем так же грубо,
 * как doctor: по всему тексту, включая блоки кода, виды `(путь)` и `(<путь>)`,
 * с необязательным заголовком ссылки.
 */
const LINK_RE = /\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)/g;

export interface MarkdownLink {
  /** Адрес как записан, без `<>`: путь, `#якорь` и всё прочее. */
  destination: string;
  /** Смещение адреса в тексте. */
  start: number;
  /** Адрес записан в угловых скобках. */
  angle: boolean;
}

export function markdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const angle = match[1] !== undefined;
    const destination = (match[1] ?? match[2] ?? '');
    const start = (match.index ?? 0) + match[0].indexOf('](') + 2 + (angle ? 1 : 0);
    links.push({ destination, start, angle });
  }
  return links;
}

/** Путь ссылки без якоря; пустой — ссылка только на якорь. */
export function linkPath(destination: string): string {
  return destination.split('#')[0]?.trim() ?? '';
}

/** Внешний адрес (`https:`, `mailto:`, `//host`) файлом проекта не является. */
export function isExternalLink(path: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path);
}
