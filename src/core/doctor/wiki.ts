import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseAudit } from '../audits.js';
import { isExternalLink, linkPath, markdownLinks } from '../wiki-links.js';
import { markdownFiles, pathHasSymlink } from './fs-utils.js';
import { decodeUtf8, frontmatter, hasFrontmatterBlock } from './text.js';
import { critical, error } from './types.js';
import type { DoctorFinding } from './types.js';

/** Возвращает прочитанные wiki-документы, чтобы соседние проверки не читали дерево повторно. */
/** Frontmatter обязателен там, где его читают проверки; в остальной wiki он по желанию. */
function requiresFrontmatter(path: string): boolean {
  return path === 'wiki/hot.md' || /^wiki\/(plans|audits|progress)\//.test(path);
}

export async function checkWiki(root: string, findings: DoctorFinding[]): Promise<Map<string, string>> {
  const wikiPath = 'wiki';
  const wiki = resolve(root, wikiPath);
  const projectRoot = resolve(root);
  if (await pathHasSymlink(root, wikiPath)) {
    findings.push(critical('wiki-symlink', 'Wiki path не должен содержать symbolic link.', wikiPath));
    return new Map();
  }
  const decoded = new Map<string, string>();
  for (const absolute of await markdownFiles(wiki)) {
    const path = relative(root, absolute).split(sep).join('/');
    try {
      const text = decodeUtf8(await readFile(absolute));
      if (text === null) { findings.push(error('wiki-invalid-utf8', 'Wiki Markdown должен быть корректным UTF-8.', path)); continue; }
      decoded.set(path, text);
      if (frontmatter(text) === null && (requiresFrontmatter(path) || hasFrontmatterBlock(text))) {
        findings.push(error('wiki-frontmatter-invalid', requiresFrontmatter(path)
          ? 'Этот файл wiki должен начинаться frontmatter: строки key: value между ---.'
          : 'Frontmatter не разобран: допустимы строки key: value, комментарии # и списки «- item» под ключом.', path));
      }
      for (const link of markdownLinks(text)) {
        const destination = linkPath(link.destination);
        if (!destination || isExternalLink(destination)) continue;
        let raw: string;
        try { raw = decodeURIComponent(destination); } catch { findings.push(error('wiki-link-broken', 'Ссылка содержит неверное URL-кодирование.', path)); continue; }
        const target = resolve(dirname(absolute), raw);
        // Ссылка на код или протоколы проекта законна; наружу проекта — нет.
        if (target !== projectRoot && !target.startsWith(`${projectRoot}${sep}`)) findings.push(error('wiki-link-outside', `Локальная wiki-ссылка выходит за пределы проекта: ${destination}`, path));
        else if (!existsSync(target)) findings.push(error('wiki-link-broken', `Битая локальная wiki-ссылка: ${destination}`, path));
      }
    } catch (cause) { findings.push(error('text-unreadable', `Не удалось прочитать Markdown: ${cause instanceof Error ? cause.message : String(cause)}`, path)); }
  }
  for (const [path, text] of decoded) {
    if (!/^wiki\/audits\/(?:archive\/)?[^/]+\.md$/.test(path)) continue;
    const { malformed, blocking } = parseAudit(text);
    for (const { id, severity } of blocking) findings.push(error('audit-blocking-finding', `Открытая ${severity} находка ${id} блокирует doctor.`, path));
    if (malformed) findings.push(error('audit-malformed', 'Audit требует audit_id, допустимый status и валидные findings.', path));
  }
  const active = [...decoded.entries()].filter(([path, text]) => path.startsWith('wiki/progress/') && frontmatter(text)?.status === 'active').map(([path]) => path.slice('wiki/'.length));
  const hot = decoded.get('wiki/hot.md');
  if (hot !== undefined) {
    const declared = frontmatter(hot)?.active_progress;
    const expected = active.length === 0 ? 'none' : active.length === 1 ? active[0] : null;
    if (expected === null || declared !== expected) {
      const hint = expected === null ? ` Сейчас status: active у нескольких записей: ${active.join(', ')}.` : ` Ожидается active_progress: ${expected} (путь от wiki/, без «wiki/»).`;
      findings.push(error('hot-active-progress-mismatch', `Contract: hot.md active_progress должен быть none либо путём единственного progress с status: active.${hint}`, 'wiki/hot.md'));
    }
  }
  return decoded;
}
