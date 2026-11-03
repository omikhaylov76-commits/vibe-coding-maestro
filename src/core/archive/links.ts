import { posix } from 'node:path';
import { isExternalLink, markdownLinks } from '../wiki-links.js';
import type { MarkdownLink } from '../wiki-links.js';

/**
 * Файл проекта, на который ведёт адрес из файла `from`, как его поняла бы файловая
 * система: другой регистр, другая форма Юникода, абсолютный адрес и обход через имя
 * папки doctor принимает. `undefined` — наружу проекта.
 */
export type LinkLocator = (from: string, decoded: string) => string | undefined;

/** Часть адреса: скобки ломают разбор ссылки, а `encodeURIComponent` их не кодирует. */
const percent = (char: string): string => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
const encodePart = (part: string): string => encodeURIComponent(part).replace(/[()]/g, percent);

/** Имя файла в адресе, который пишет archive: кириллица как есть, то, что сломало бы ссылку, — кодами. */
export const linkName = (name: string): string => name.replace(/[\s%()<>]/g, percent);

interface LocalLink {
  link: MarkdownLink;
  /** Адрес без якоря, как записан. */
  pathText: string;
  anchor: string;
  /** Путь от корня проекта. */
  target: string;
  directory: boolean;
}

/** Ссылки на файлы проекта: внешняя, ведущая наружу проекта или только якорь сюда не входят. */
function localLinks(text: string, from: string, locate?: LinkLocator): LocalLink[] {
  const fromDir = posix.dirname(from);
  const links: LocalLink[] = [];
  for (const link of markdownLinks(text)) {
    const hashAt = link.destination.indexOf('#');
    const rawPath = hashAt === -1 ? link.destination : link.destination.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : link.destination.slice(hashAt);
    const pathText = rawPath.trim();
    if (pathText === '' || isExternalLink(pathText)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(pathText); } catch { continue; }
    const plain = posix.normalize(posix.join(fromDir, decoded)).replace(/\/$/, '');
    const located = locate?.(from, decoded);
    if (located === undefined && (pathText.startsWith('/') || plain === '..' || plain.startsWith('../'))) continue;
    links.push({ link, pathText, anchor, target: located ?? plain, directory: decoded.endsWith('/') });
  }
  return links;
}

/** На какие файлы проекта ссылается текст файла `from`. */
export function linkTargets(text: string, from: string, locate?: LinkLocator): Set<string> {
  return new Set(localLinks(text, from, locate).map((link) => link.target));
}

/**
 * Переносит адреса относительных ссылок: текст `from` переезжает в `to`, а файлы
 * из `moved` (старый путь → новый, пути от корня проекта) — на новые места.
 *
 * Меняется только адрес ссылки, и только если он теперь должен быть другим;
 * весь остальной текст — байт в байт. Якорь `#…` и вид записи (`<…>`, `%`-кодировка)
 * сохраняются. Внешняя ссылка и ссылка наружу проекта не трогаются: их адрес от
 * переноса не зависит. `locate` находит файл так же, как doctor; без него адрес
 * понимается как строка.
 */
export function rebaseLinks(text: string, from: string, to: string, moved: ReadonlyMap<string, string> = new Map(), locate?: LinkLocator): string {
  const toDir = posix.dirname(to);
  const sameDir = posix.dirname(from) === toDir;
  let out = '';
  let cursor = 0;
  for (const { link, pathText, anchor, target, directory } of localLinks(text, from, locate)) {
    const finalTarget = moved.get(target) ?? target;
    if (sameDir && finalTarget === target) continue;
    let relative = posix.relative(toDir, finalTarget) || '.';
    if (directory) relative += '/';
    const written = pathText.includes('%') ? relative.split('/').map((part) => (part === '..' || part === '.' ? part : encodePart(part))).join('/') : relative;
    out += text.slice(cursor, link.start) + written + anchor;
    cursor = link.start + link.destination.length;
  }
  return out + text.slice(cursor);
}
