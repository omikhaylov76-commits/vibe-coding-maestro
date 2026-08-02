import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { CHECKSUMS_PATH, contentChecksum, isSafeProjectPath, loadChecksums, loadManifest, sha256 } from './manifest.js';
import { TRUSTED_MANAGED_INVENTORY } from './inventory.js';

const execFileAsync = promisify(execFile);
export type FindingLevel = 'error' | 'warning';
export interface DoctorFinding { level: FindingLevel; code: string; message: string; path?: string }
export interface DoctorReport { ok: boolean; root: string; findings: DoctorFinding[] }
const makeFinding = (level: FindingLevel, code: string, message: string, path?: string): DoctorFinding =>
  ({ level, code, message, ...(path === undefined ? {} : { path }) });
const error = (code: string, message: string, path?: string): DoctorFinding => makeFinding('error', code, message, path);
const warning = (code: string, message: string, path?: string): DoctorFinding => makeFinding('warning', code, message, path);

function decodeUtf8(buffer: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer); } catch { return null; }
}
function frontmatter(text: string): Record<string, string> | null {
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
async function markdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}
async function checkWiki(root: string, findings: DoctorFinding[]): Promise<void> {
  const wikiPath = 'wiki';
  const wiki = resolve(root, wikiPath);
  if (await pathHasSymlink(root, wikiPath)) {
    findings.push(error('wiki-symlink', 'Wiki path не должен содержать symbolic link.', wikiPath));
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
  const auditStatuses = new Set(['open', 'resolved', 'waived']);
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
      const fields = (name: string): string[] => [...body.matchAll(new RegExp(`^- ${name}:\\s*(.*?)\\s*$`, 'gm'))].map((match) => match[1]?.trim() ?? '');
      const severityValues = fields('severity'); const targetValues = fields('target'); const statusValues = fields('status'); const resolutionValues = fields('resolution');
      const severity = severityValues[0]; const status = statusValues[0];
      if (ids.has(id) || severityValues.length !== 1 || targetValues.length !== 1 || statusValues.length !== 1 || resolutionValues.length !== 1 || !['critical', 'high', 'medium', 'low'].includes(severity ?? '') || !targetValues[0] || !auditStatuses.has(status ?? '') || !resolutionValues[0]) malformed = true;
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
async function checkGit(root: string, managedDocs: Set<string>, findings: DoctorFinding[]): Promise<void> {
  if (!existsSync(join(root, '.git'))) return;
  try {
    const tracked = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    for (const path of tracked.stdout.split('\0').filter(Boolean).sort()) {
      const base = path.split('/').at(-1) ?? path;
      if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') findings.push(error('git-env-tracked', 'Секретный env-файл отслеживается Git.', path));
    }
    const status = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    for (const record of status.stdout.split('\0').filter(Boolean)) {
      const path = record.slice(3).split(' -> ').at(-1) ?? '';
      if (managedDocs.has(path)) findings.push(error('git-managed-dirty', 'Управляемый документ имеет незакоммиченные изменения.', path));
    }
  } catch (cause) { findings.push(error('git-check-failed', `Не удалось проверить Git: ${cause instanceof Error ? cause.message : String(cause)}`, '.git')); }
}
async function checkInbox(root: string, findings: DoctorFinding[]): Promise<void> {
  const inboxPath = 'maestro/inbox';
  const dir = join(root, inboxPath);
  if (await pathHasSymlink(root, inboxPath)) {
    findings.push(error('inbox-symlink', 'Inbox path не должен содержать symbolic link.', inboxPath));
    return;
  }
  if (!existsSync(dir)) return;
  const entries = (await readdir(dir)).filter((name) => name !== 'README.md' && name !== '.gitkeep');
  if (entries.length > 0) findings.push(warning('inbox-not-empty', 'Inbox содержит необработанные материалы.', 'maestro/inbox'));
}
async function absolutePathHasSymlink(absolutePath: string): Promise<boolean> {
  const absolute = resolve(absolutePath);
  const fsRoot = parse(absolute).root;
  let current = fsRoot;
  for (const part of absolute.slice(fsRoot.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw cause;
    }
  }
  return false;
}
async function pathHasSymlink(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw cause;
    }
  }
  return false;
}
async function sourceFiles(root: string, dir: string, findings: DoctorFinding[]): Promise<string[]> {
  const relativeDir = relative(root, dir).split(sep).join('/');
  if (await pathHasSymlink(root, relativeDir)) {
    findings.push(error('source-symlink', 'Sources path не должен содержать symbolic link.', relativeDir));
    return [];
  }
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) findings.push(error('source-symlink', 'Source не должен быть symbolic link.', path));
    else if (entry.isDirectory()) result.push(...await sourceFiles(root, absolute, findings));
    else if (entry.isFile() && entry.name !== '.gitkeep') result.push(path);
  }
  return result.sort();
}
async function checkSources(root: string, findings: DoctorFinding[]): Promise<void> {
  const sourcesPath = 'maestro/sources';
  if (await pathHasSymlink(root, sourcesPath)) {
    findings.push(error('source-symlink', 'Sources path не должен содержать symbolic link.', sourcesPath));
    return;
  }
  const metadataPath = '.maestro/source-hashes.json';
  const metadataAbsolute = join(root, metadataPath);
  if (await pathHasSymlink(root, metadataPath)) {
    findings.push(error('source-hashes-symlink', 'Metadata source hashes не должен содержать symbolic link.', metadataPath));
    return;
  }
  if (!existsSync(metadataAbsolute)) return;
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataAbsolute, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).join() !== 'files') throw new Error('ожидается объект { files }');
    const files = (parsed as { files?: unknown }).files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new Error('files должен быть объектом');
    const hashes = files as Record<string, unknown>;
    for (const [path, hash] of Object.entries(hashes)) {
      if (!isSafeProjectPath(path) || !path.startsWith('maestro/sources/') || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`неверная запись ${path}`);
    }
    const actualPaths = await sourceFiles(root, join(root, 'maestro/sources'), findings);
    const actualSet = new Set(actualPaths);
    for (const path of actualPaths) {
      if (!(path in hashes)) findings.push(error('source-hash-missing', 'Для source отсутствует versioned hash.', path));
      else if (sha256(await readFile(join(root, path))) !== hashes[path]) findings.push(error('source-hash-mismatch', 'Source не совпадает с versioned hash.', path));
    }
    for (const path of Object.keys(hashes).sort()) {
      if (!actualSet.has(path)) findings.push(error('source-hash-extra', 'Hash ссылается на отсутствующий source.', path));
    }
  } catch (cause) { findings.push(error('source-hashes-invalid', `Metadata source hashes повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, metadataPath)); }
}
export async function doctorProject(rootInput: string): Promise<DoctorReport> {
  const root = resolve(rootInput); const findings: DoctorFinding[] = [];
  if (await absolutePathHasSymlink(root)) {
    findings.push(error('project-root-symlink', 'Путь к корню проекта не должен содержать symbolic link.', root));
    return { ok: false, root, findings };
  }
  for (const metadataPath of ['.maestro/manifest.json', CHECKSUMS_PATH]) {
    if (await pathHasSymlink(root, metadataPath)) {
      findings.push(error('metadata-symlink', 'Системные metadata не должны содержать symbolic link.', metadataPath));
    }
  }
  if (findings.length > 0) return { ok: false, root, findings };
  let manifest;
  try { manifest = await loadManifest(root); } catch (cause) { findings.push(error('manifest-invalid', `Манифест отсутствует или повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, '.maestro/manifest.json')); return { ok: false, root, findings }; }
  const checksums = await loadChecksums(root);
  if (checksums === null) findings.push(error('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));
  const byPath = new Map(manifest.managed.map((entry) => [entry.path, entry.kind]));
  for (const [path, kind] of Object.entries(TRUSTED_MANAGED_INVENTORY)) if (byPath.get(path) !== kind) findings.push(error('manifest-inventory-mismatch', 'Обязательный системный путь отсутствует или имеет неверный kind.', path));
  const managedDocs = new Set<string>();
  for (const entry of manifest.managed) {
    if (entry.kind !== 'managed') continue;
    if (entry.path.endsWith('.md')) managedDocs.add(entry.path);
    if (await pathHasSymlink(root, entry.path)) {
      findings.push(error('managed-symlink', 'Управляемый путь не должен содержать symbolic link.', entry.path));
      continue;
    }
    const absolute = join(root, entry.path);
    if (!existsSync(absolute)) { findings.push(error('managed-missing', 'Управляемый файл отсутствует.', entry.path)); continue; }
    const expected = checksums?.files[entry.path];
    if (expected === undefined) { findings.push(error('managed-checksum-missing', 'Для управляемого файла отсутствует обязательная контрольная сумма.', entry.path)); continue; }
    try { if (contentChecksum(entry.path, await readFile(absolute)) !== expected) findings.push(error('managed-modified', 'Управляемый файл изменён относительно установленной версии.', entry.path)); }
    catch (cause) { findings.push(error('text-unreadable', `Не удалось прочитать файл: ${cause instanceof Error ? cause.message : String(cause)}`, entry.path)); }
  }
  await checkWiki(root, findings); await checkGit(root, managedDocs, findings); await checkInbox(root, findings); await checkSources(root, findings);
  return { ok: findings.every((item) => item.level !== 'error'), root, findings };
}
