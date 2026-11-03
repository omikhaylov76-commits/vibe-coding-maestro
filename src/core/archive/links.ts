import { posix } from 'node:path';
import { isExternalLink, markdownLinks } from '../wiki-links.js';

/**
 * Переносит адреса относительных ссылок: текст `from` переезжает в `to`, а файлы
 * из `moved` (старый путь → новый, пути от корня проекта) — на новые места.
 *
 * Меняется только адрес ссылки, и только если он теперь должен быть другим;
 * весь остальной текст — байт в байт. Якорь `#…` и вид записи (`<…>`, `%`-кодировка)
 * сохраняются. Ссылка наружу проекта, абсолютная или внешняя не трогается: её
 * адрес от переноса не зависит или doctor её и так не примет.
 */
export function rebaseLinks(text: string, from: string, to: string, moved: ReadonlyMap<string, string> = new Map()): string {
  const fromDir = posix.dirname(from);
  const toDir = posix.dirname(to);
  let out = '';
  let cursor = 0;
  for (const link of markdownLinks(text)) {
    const hashAt = link.destination.indexOf('#');
    const rawPath = hashAt === -1 ? link.destination : link.destination.slice(0, hashAt);
    const anchor = hashAt === -1 ? '' : link.destination.slice(hashAt);
    const pathText = rawPath.trim();
    if (pathText === '' || isExternalLink(pathText) || pathText.startsWith('/')) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(pathText); } catch { continue; }
    const directory = decoded.endsWith('/');
    const target = posix.normalize(posix.join(fromDir, decoded)).replace(/\/$/, '');
    if (target === '..' || target.startsWith('../')) continue;
    const finalTarget = moved.get(target) ?? target;
    if (fromDir === toDir && finalTarget === target) continue;
    let relative = posix.relative(toDir, finalTarget) || '.';
    if (directory) relative += '/';
    const written = pathText.includes('%') ? relative.split('/').map((part) => (part === '..' || part === '.' ? part : encodeURIComponent(part))).join('/') : relative;
    out += text.slice(cursor, link.start) + written + anchor;
    cursor = link.start + link.destination.length;
  }
  return out + text.slice(cursor);
}
