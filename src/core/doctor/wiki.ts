import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { markdownFiles, pathHasSymlink } from './fs-utils.js';
import { decodeUtf8, frontmatter } from './text.js';
import { critical, error } from './types.js';
import type { DoctorFinding } from './types.js';

export async function checkWiki(root: string, findings: DoctorFinding[]): Promise<void> {
  const wikiPath = 'wiki';
  const wiki = resolve(root, wikiPath);
  if (await pathHasSymlink(root, wikiPath)) {
    findings.push(critical('wiki-symlink', 'Wiki path не должен содержать symbolic link.', wikiPath));
    return;
  }
  const decoded = new Map<string, string>();
  for (const absolute of await markdownFiles(wiki)) {
    const path = relative(root, absolute).split(sep).join('/');
    try {
      const text = decodeUtf8(await readFile(absolute));
      if (text === null) { findings.push(error('wiki-invalid-utf8', 'Wiki Markdown должен быть корректным UTF-8.', path)); continue; }
      decoded.set(path, text);
      if (frontmatter(text) === null) findings.push(error('wiki-frontmatter-invalid', 'Wiki Markdown должен начинаться простым YAML frontmatter key: value.', path));
      for (const match of text.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+['"][^'"]*['"])?\)/g)) {
        const destination = (match[1] ?? match[2] ?? '').split('#')[0]?.trim();
        if (!destination || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(destination)) continue;
        let raw: string;
        try { raw = decodeURIComponent(destination); } catch { findings.push(error('wiki-link-broken', 'Ссылка содержит неверное URL-кодирование.', path)); continue; }
        const target = resolve(dirname(absolute), raw);
        if (target !== wiki && !target.startsWith(`${wiki}${sep}`)) findings.push(error('wiki-link-outside', `Локальная wiki-ссылка выходит за пределы wiki: ${destination}`, path));
        else if (!existsSync(target)) findings.push(error('wiki-link-broken', `Битая локальная wiki-ссылка: ${destination}`, path));
      }
    } catch (cause) { findings.push(error('text-unreadable', `Не удалось прочитать Markdown: ${cause instanceof Error ? cause.message : String(cause)}`, path)); }
  }
  const auditStatuses = new Set(['open', 'resolved']);
  for (const [path, text] of decoded) {
    if (!/^wiki\/audits\/[^/]+\.md$/.test(path)) continue;
    const meta = frontmatter(text);
    let malformed = !meta?.audit_id || !meta.status || !auditStatuses.has(meta.status);
    const starts = [...text.matchAll(/^## Finding ([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/gm)];
    if (starts.length === 0) malformed = true;
    const ids = new Set<string>();
    for (let index = 0; index < starts.length; index += 1) {
      const current = starts[index];
      const id = current?.[1] ?? '';
      const body = text.slice((current?.index ?? 0) + (current?.[0].length ?? 0), starts[index + 1]?.index ?? text.length);
      const fields = (name: string): string[] => [...body.matchAll(new RegExp(`^- ${name}:[ \\t]*(.*?)[ \\t]*$`, 'gm'))].map((match) => match[1]?.trim() ?? '');
      const severityValues = fields('severity'); const targetValues = fields('target'); const evidenceValues = fields('evidence'); const statusValues = fields('status'); const resolutionValues = fields('resolution');
      const severity = severityValues[0]; const status = statusValues[0];
      if (ids.has(id) || severityValues.length !== 1 || targetValues.length !== 1 || evidenceValues.length !== 1 || statusValues.length !== 1 || resolutionValues.length !== 1 || !['critical', 'high', 'medium', 'low'].includes(severity ?? '') || !targetValues[0] || !evidenceValues[0] || !auditStatuses.has(status ?? '') || !resolutionValues[0]) malformed = true;
      else if (meta?.status !== 'open' && status === 'open') malformed = true;
      else if ((severity === 'critical' || severity === 'high') && status === 'open') findings.push(error('audit-blocking-finding', `Открытая ${severity} находка ${id} блокирует doctor.`, path));
      ids.add(id);
    }
    if (/^## Finding /m.test(text) && starts.length === 0) malformed = true;
    if (malformed) findings.push(error('audit-malformed', 'Audit требует audit_id, допустимый status и валидные findings.', path));
  }
  const active = [...decoded.entries()].filter(([path, text]) => path.startsWith('wiki/progress/') && frontmatter(text)?.status === 'active').map(([path]) => path.slice('wiki/'.length));
  const hot = decoded.get('wiki/hot.md');
  if (hot !== undefined) {
    const declared = frontmatter(hot)?.active_progress;
    const expected = active.length === 0 ? 'none' : active.length === 1 ? active[0] : null;
    if (expected === null || declared !== expected) findings.push(error('hot-active-progress-mismatch', 'Contract: hot.md active_progress должен быть none либо путём единственного progress с status: active.', 'wiki/hot.md'));
  }
}
