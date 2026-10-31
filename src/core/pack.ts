import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MANIFEST_PATH } from './manifest.js';
import { buildZip, ZipTooLargeError } from './zip.js';
import type { ZipEntry } from './zip.js';

const execFileAsync = promisify(execFile);

/**
 * Упаковка проекта для заказчика: архив тега сдачи без внутренней кухни Maestro
 * плюс `HANDOVER.md`. Один и тот же тег всегда даёт побайтово один и тот же архив:
 * всё берётся из тега (а не из рабочей папки), порядок и время записей фиксированы.
 */

export const PASSPORT_PATH = 'wiki/passport.md';
export const HANDOVER_PATH = 'HANDOVER.md';

/** Внутренние места Maestro и агентов: заказчику они не нужны и в архив не попадают. */
export const INTERNAL_PATHS: readonly string[] = ['wiki/', 'maestro/', '.claude/', 'protocols/', '.maestro/', 'CLAUDE.md', 'AGENTS.md'];

/** Разделы паспорта, без которых сдавать нельзя. */
export const PASSPORT_SECTIONS: readonly string[] = [
  'Репозиторий',
  'Где работает',
  'Домен и DNS',
  'Данные, базы, резервные копии',
  'Внешние сервисы и чей аккаунт',
  'Переменные окружения',
  'Расписания и фоновые задачи',
  'Как запустить, обновить, откатить',
];

export interface PackFinding {
  code: string;
  message: string;
  path?: string;
}

export interface PackOptions {
  root: string;
  tag: string;
  /** Полный путь архива. */
  out: string;
}

export interface PackResult {
  ok: boolean;
  findings: PackFinding[];
  tag: string;
  commit?: string;
  archive?: string;
  sha256?: string;
  files?: number;
  bytes?: number;
  /** Архив с этим содержимым уже лежал по этому пути. */
  reused?: boolean;
}

const finding = (code: string, message: string, path?: string): PackFinding =>
  ({ code, message, ...(path === undefined ? {} : { path }) });

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  return (await execFileAsync('git', args, { cwd: root, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 * 1024 })).stdout;
}

/** Разделы паспорта, которые не заполнены: нет раздела, пусто или осталось «пока нет». */
export function passportGaps(text: string): string[] {
  const sections = new Map<string, string>();
  const parts = text.replace(/\r\n/g, '\n').split(/^## +/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const title = (newline < 0 ? part : part.slice(0, newline)).trim();
    sections.set(title, newline < 0 ? '' : part.slice(newline + 1));
  }
  return PASSPORT_SECTIONS.filter((title) => {
    const body = sections.get(title);
    if (body === undefined) return true;
    if (/не применимо/i.test(body)) return false;
    return /пока нет/i.test(body) || body.trim() === '';
  });
}

interface TarEntry {
  path: string;
  mode: number;
  data: Buffer;
  symlink: boolean;
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Разбор tar из `git archive`: ustar с префиксом и pax-заголовками для длинных путей. */
export function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, end: number): string => {
      const raw = header.subarray(start, end);
      const zero = raw.indexOf(0);
      return raw.subarray(0, zero < 0 ? raw.length : zero).toString('utf8');
    };
    const size = Number.parseInt(field(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    const data = buffer.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    const prefix = field(345, 500);
    const name = field(0, 100);
    const path = pax.path ?? (prefix === '' ? name : `${prefix}/${name}`);
    const link = pax.linkpath ?? field(157, 257);
    pax = {};
    // Права зависят от tar.umask машины; в архиве остаётся только «исполняемый или нет».
    const mode = (Number.parseInt(field(100, 108).trim() || '0', 8) & 0o111) !== 0 ? 0o755 : 0o644;
    if (type === '5') continue;
    if (type === '2') entries.push({ path, mode: 0o120000 | 0o777, data: Buffer.from(link, 'utf8'), symlink: true });
    else if (type === '0' || type === '\0' || type === '7') entries.push({ path, mode: 0o100000 | mode, data: Buffer.from(data), symlink: false });
    else throw new Error(`Неподдерживаемая запись tar (${type}): ${path}`);
  }
  return entries;
}

const isInternal = (path: string): boolean =>
  INTERNAL_PATHS.some((internal) => (internal.endsWith('/') ? path.startsWith(internal) : path === internal));

/** Служебные папки агентов глубже корня: признак того, что в продукт попало чужое. */
const NESTED_INTERNAL = /(^|\/)(\.claude|\.maestro)\//;

const SECRET_NAMES: readonly { label: string; test: (base: string) => boolean }[] = [
  { label: 'файл .env', test: (base) => (base === '.env' || base.startsWith('.env.')) && !/^\.env\.(example|sample|template)$/.test(base) },
  { label: 'закрытый ключ SSH', test: (base) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base) },
  { label: 'хранилище ключей', test: (base) => /\.(p12|pfx|jks|keystore)$/i.test(base) },
  { label: 'файл паролей', test: (base) => base === '.netrc' || base === '.pgpass' },
];

const SECRET_CONTENT: readonly { label: string; pattern: RegExp }[] = [
  { label: 'закрытый ключ', pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { label: 'ключ AWS', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'токен GitHub', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { label: 'ключ Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'ключ OpenAI', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { label: 'токен Slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { label: 'ключ Stripe', pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { label: 'ключ Google', pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { label: 'токен npm', pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'токен в .npmrc', pattern: /_authToken\s*=\s*(?!\$\{)\S+/ },
];

const MAX_SCAN_BYTES = 5 * 1024 * 1024;

/** Секреты по имени файла и по содержимому. Значение секрета в находку не попадает. */
export function findSecrets(path: string, data: Buffer): PackFinding[] {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const named = SECRET_NAMES.find((rule) => rule.test(base));
  if (named !== undefined) return [finding('pack-secret', `Похоже на секрет (${named.label}): такой файл заказчику не отдают.`, path)];
  if (data.length > MAX_SCAN_BYTES || data.subarray(0, 8000).includes(0)) return [];
  const lines = data.toString('utf8').split('\n');
  const found: PackFinding[] = [];
  lines.forEach((line, index) => {
    const rule = SECRET_CONTENT.find((item) => item.pattern.test(line));
    if (rule !== undefined) found.push(finding('pack-secret', `Строка ${index + 1} похожа на секрет (${rule.label}).`, path));
  });
  return found;
}

/** Текст `HANDOVER.md`: обязательный шаг «смените все пароли и ключи» и паспорт из тега. */
export function handoverText(input: { projectName: string; tag: string; commit: string; passport: string }): string {
  const passport = input.passport.replace(/\r\n/g, '\n');
  const firstSection = passport.search(/^## /m);
  const body = (firstSection < 0 ? passport : passport.slice(firstSection)).replace(/^## /gm, '### ').trimEnd();
  return [
    `# Передача проекта ${input.projectName}`,
    '',
    `Версия: тег \`${input.tag}\`, коммит \`${input.commit}\`.`,
    '',
    '## Первым делом: смените все пароли и ключи',
    '',
    'Пока проект делали, пароли и ключи знали исполнители. Сразу после передачи смените их все: ключи API, пароли от хостинга, баз данных, домена, почты и внешних сервисов. Новые значения задайте там, где они задаются (раздел «Переменные окружения» ниже), и проверьте, что проект работает.',
    '',
    '## Паспорт проекта',
    '',
    body,
    '',
  ].join('\n');
}

/** Имя файла архива по умолчанию: папка проекта и тег. */
export function defaultArchiveName(root: string, tag: string): string {
  const safe = (value: string): string => value.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${safe(resolve(root).split(/[\\/]/).pop() ?? 'project') || 'project'}-${safe(tag) || 'tag'}.zip`;
}

export async function packProject(options: PackOptions): Promise<PackResult> {
  const root = resolve(options.root);
  const { tag } = options;
  const fail = (...findings: PackFinding[]): PackResult => ({ ok: false, findings, tag });

  if (!existsSync(root)) return fail(finding('pack-path-missing', `Папка не найдена: ${root}. Проверьте путь; путь с пробелами возьмите в кавычки.`));
  if (!existsSync(join(root, MANIFEST_PATH))) return fail(finding('pack-not-project', 'Это не проект Vibe Coding Maestro: нет `.maestro/manifest.json`.', MANIFEST_PATH));

  let prefix: string;
  try {
    prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    return fail(finding('pack-no-git', 'У проекта нет Git-истории: упаковывается только тег сдачи.'));
  }
  if (prefix !== '') return fail(finding('pack-not-git-root', 'Проект должен быть корнем своего Git-репозитория.'));

  let commit: string;
  try {
    commit = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`])).trim();
  } catch {
    const tags = (await git(root, ['tag', '--list']).catch(() => '')).split('\n').filter((line) => line !== '');
    const known = tags.length === 0 ? 'В проекте пока нет ни одного тега.' : `Есть теги: ${tags.slice(-10).join(', ')}.`;
    return fail(finding('pack-tag-missing', `Тег «${tag}» не найден. ${known} Тег сдачи ставится по протоколу завершения, после «да» человека.`));
  }

  let passport: string;
  try {
    passport = await git(root, ['show', `${commit}:${PASSPORT_PATH}`]);
  } catch {
    return fail(finding('pack-passport-missing', `В теге «${tag}» нет паспорта \`${PASSPORT_PATH}\`. Заполните паспорт, закоммитьте и поставьте новый тег.`, PASSPORT_PATH));
  }
  const gaps = passportGaps(passport);
  if (gaps.length > 0) {
    return fail(finding('pack-passport-incomplete', `Паспорт в теге «${tag}» не заполнен: ${gaps.map((title) => `«${title}»`).join(', ')}. В каждом разделе нужна запись или «не применимо». Заполните, закоммитьте и поставьте новый тег.`, PASSPORT_PATH));
  }

  let projectName = tag;
  try {
    const manifest = JSON.parse(await git(root, ['show', `${commit}:${MANIFEST_PATH}`])) as { project?: { name?: unknown } };
    if (typeof manifest.project?.name === 'string' && manifest.project.name !== '') projectName = manifest.project.name;
  } catch {
    // Имя — только заголовок HANDOVER.md; без manifest в теге остаётся имя тега.
  }

  const time = Number.parseInt((await git(root, ['log', '-1', '--format=%ct', commit])).trim(), 10);
  const entries = parseTar(await gitBuffer(root, ['archive', '--format=tar', commit]));

  const findings: PackFinding[] = [];
  const kept = entries.filter((entry) => !isInternal(entry.path));
  for (const entry of kept) {
    if (NESTED_INTERNAL.test(entry.path)) {
      findings.push(finding('pack-internal-path', 'Служебная папка агента внутри продукта: заказчику её не отдают.', entry.path));
      continue;
    }
    if (entry.path === HANDOVER_PATH) {
      findings.push(finding('pack-handover-collision', `В корне проекта уже есть ${HANDOVER_PATH}; упаковка пишет этот файл сама. Переименуйте свой и поставьте новый тег.`, entry.path));
      continue;
    }
    if (!entry.symlink) findings.push(...findSecrets(entry.path, entry.data));
  }
  const handover = Buffer.from(handoverText({ projectName, tag, commit, passport }), 'utf8');
  findings.push(...findSecrets(HANDOVER_PATH, handover).map((item) => ({ ...item, message: `${item.message} Секрет в паспорте: в паспорт пишут только имена.` })));
  if (findings.length > 0) {
    findings.push(finding('pack-refused', `Архив не создан. Уберите это из тега (или пометьте \`export-ignore\` в своём \`.gitattributes\`), закоммитьте, поставьте новый тег и повторите.`));
    return { ok: false, findings, tag, commit };
  }

  const zipEntries: ZipEntry[] = [
    ...kept.map((entry) => ({ path: entry.path, data: entry.data, mode: entry.mode })),
    { path: HANDOVER_PATH, data: handover, mode: 0o100644 },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let zip: Buffer;
  try {
    zip = buildZip(zipEntries, time);
  } catch (cause) {
    if (cause instanceof ZipTooLargeError) return { ok: false, findings: [finding('pack-too-large', cause.message)], tag, commit };
    throw cause;
  }
  const sha256 = createHash('sha256').update(zip).digest('hex');
  const out = resolve(options.out);
  const summary = { tag, commit, archive: out, sha256, files: zipEntries.length, bytes: zip.length };

  if (existsSync(out)) {
    const existing = await readFile(out);
    if (existing.equals(zip)) return { ok: true, findings: [], reused: true, ...summary };
    return { ok: false, findings: [finding('pack-out-exists', `Файл уже есть и отличается от нового архива: ${out}. Удалите его или укажите другой --out.`, out)], tag, commit };
  }
  await mkdir(dirname(out), { recursive: true });
  const temporary = `${out}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, zip);
    await rename(temporary, out);
  } catch (cause) {
    await rm(temporary, { force: true });
    return { ok: false, findings: [finding('pack-write-failed', `Не удалось записать архив: ${cause instanceof Error ? cause.message : String(cause)}`, out)], tag, commit };
  }
  return { ok: true, findings: [], reused: false, ...summary };
}
