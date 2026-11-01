import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { GITIGNORE_BLOCK_HEADER, REQUIRED_GITIGNORE_ENTRIES } from './gitignore.js';
import { GITATTRIBUTES_CONTENT } from './init.js';
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

/** Внутренние места Maestro и агентов в корне: заказчику они не нужны и в архив не попадают. */
export const INTERNAL_PATHS: readonly string[] = ['wiki/', 'maestro/', '.claude/', 'protocols/', '.maestro/', 'CLAUDE.md', 'AGENTS.md', '.mcp.json'];

/** Разделы паспорта о доступах: если все они «не применимо», менять заказчику нечего. */
export const ACCESS_SECTIONS: readonly string[] = [
  'Где работает',
  'Домен и DNS',
  'Данные, базы, резервные копии',
  'Внешние сервисы и чей аккаунт',
  'Переменные окружения',
];

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
  /** Путь архива; если это папка — архив ложится в неё под именем по умолчанию. */
  out: string;
  /** Файлы, которые человек посмотрел и признал не секретом: их содержимое не проверяется. */
  allow?: readonly string[];
  /** Только состав и подсветка: архив не собирается и не пишется. */
  dryRun?: boolean;
  /** Домашняя папка для подсветки путей; по умолчанию — текущего пользователя. */
  home?: string;
}

/** Подсвеченное в составе: проверить перед отправкой. Предупреждение, а не отказ. */
export interface PackHighlight {
  path: string;
  reason: string;
  /** Строка, где найдено, если подсвечено содержимое. */
  line?: number;
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
  /** Что не вошло или не проверено, но не мешает упаковке: подмодули, слишком большие файлы. */
  notes?: string[];
  /** Подсвеченное в составе; поля нет, если подсвечивать нечего. */
  highlights?: PackHighlight[];
  /** Показ состава без записи (`--dry-run`). */
  dryRun?: true;
  /** Пути архива по порядку — только при показе состава. */
  entries?: string[];
  /** Показ состава без метки: её ещё нет, показан последний коммит (HEAD). */
  untagged?: true;
  /** В паспорте все разделы о доступах — «не применимо»: `HANDOVER.md` пишет «доступов не было». */
  noAccess?: true;
}

const finding = (code: string, message: string, path?: string): PackFinding =>
  ({ code, message, ...(path === undefined ? {} : { path }) });

/** Настройки машины, которые иначе меняли бы байты архива или вывод git. */
const GIT_PINNED = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'log.showSignature=false', '-c', 'core.quotepath=off'];

async function git(root: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', [...GIT_PINNED, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  return (await execFileAsync('git', [...GIT_PINNED, ...args], { cwd: root, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 * 1024 })).stdout;
}

/** Строка-заготовка шаблона: «- Пока нет» или «- Адрес: пока нет». Обычный текст со словами «пока нет» — запись. */
const PLACEHOLDER_LINE = /^\s*[-*]\s*(?:[^:\n]*:\s*)?пока нет\.?\s*$/i;

/** Запись «не применимо»: «- Не применимо» или «- Адрес: не применимо». */
const NOT_APPLICABLE_LINE = /^\s*(?:[-*]\s*)?(?:[^:\n]*:\s*)?не применимо\.?\s*$/i;

/** Пояснение шаблона в разделе «Переменные окружения»: это не запись. */
const ENV_SECTION_HINT = 'Только имена и где задаются (`.env`, панель хостинга), значения — никогда.';

function passportSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = text.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split(/^## +/m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const title = (newline < 0 ? part : part.slice(0, newline)).trim();
    sections.set(title, newline < 0 ? '' : part.slice(newline + 1));
  }
  return sections;
}

/**
 * Доступов не было: каждый раздел о доступах есть и в нём только «не применимо».
 * Любая другая запись — сомнение, и `HANDOVER.md` просит сменить пароли и ключи.
 */
export function passportHasNoAccess(text: string): boolean {
  const sections = passportSections(text);
  return ACCESS_SECTIONS.every((title) => {
    const lines = (sections.get(title) ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== ENV_SECTION_HINT);
    return lines.length > 0 && lines.every((line) => NOT_APPLICABLE_LINE.test(line));
  });
}

/** Разделы паспорта, которые не заполнены: нет раздела, нет записи или осталась заготовка «пока нет». */
export function passportGaps(text: string): string[] {
  const sections = passportSections(text);
  return PASSPORT_SECTIONS.filter((title) => {
    const body = sections.get(title);
    if (body === undefined) return true;
    const lines = body.split('\n').filter((line) => line.trim() !== '');
    return lines.length === 0 || lines.some((line) => PLACEHOLDER_LINE.test(line));
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
    if (!Number.isFinite(size) || size < 0) throw new Error('Не удалось прочитать размер записи в выводе git archive.');
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

/** Файлы и папки агентов, оставшиеся после исключения корневых: признак того, что в продукт попало чужое. */
const AGENT_PATH = /(^|\/)(\.claude|\.maestro|\.cursor)\/|(^|\/)(CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.mcp\.json|\.cursorrules|\.windsurfrules)$/;

const SECRET_NAMES: readonly { label: string; test: (base: string) => boolean }[] = [
  { label: 'файл .env', test: (base) => (base === '.env' || base.startsWith('.env.') || base === '.envrc') && !/^\.env\.(example|sample|template)$/.test(base) },
  { label: 'закрытый ключ SSH', test: (base) => /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base) },
  { label: 'хранилище ключей', test: (base) => /\.(p12|pfx|jks|keystore|key)$/i.test(base) },
  { label: 'файл паролей', test: (base) => base === '.netrc' || base === '.pgpass' },
  { label: 'файл секретов', test: (base) => /^(secrets?\.(ya?ml|json|toml)|credentials.*\.json|service[-_]?account.*\.json)$/i.test(base) },
  { label: 'файл базы данных', test: (base) => /\.(sqlite3?|db)$/i.test(base) },
];

/** Заготовки вместо настоящего значения: такие строки секретом не считаются. */
const PLACEHOLDER_VALUE = /^(?:[$<{%]|your|example|changeme|change-me|placeholder|dummy|test|xxx|\*\*\*)|example|xxxxx/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/** JWT с ролью service_role (Supabase и похожие) — секрет; публичный anon-ключ — нет. */
function hasServiceRoleJwt(line: string): boolean {
  for (const match of line.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    try {
      if (Buffer.from(match[1] as string, 'base64url').toString('utf8').includes('"service_role"')) return true;
    } catch {
      // не JWT
    }
  }
  return false;
}

function hasDatabasePassword(line: string): boolean {
  for (const match of line.matchAll(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@\/"'`]*:([^\s@\/"'`]+)@([^\s:\/"'`?]+)/gi)) {
    const password = match[1] as string;
    const host = (match[2] as string).toLowerCase();
    if (LOCAL_HOSTS.has(host) || PLACEHOLDER_VALUE.test(password) || ['password', 'pass', 'postgres', 'root', 'secret'].includes(password.toLowerCase())) continue;
    return true;
  }
  return false;
}

const SECRET_CONTENT: readonly { label: string; test: (line: string) => boolean }[] = [
  // Ключ, а не код, который проверяет заголовок: за заголовком идёт перевод строки (в том числе `\n` в JSON) или сам ключ.
  { label: 'закрытый ключ', test: (line) => /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:\\(?:r\\)?n|\s*$|[A-Za-z0-9+/])/.test(line) },
  { label: 'ключ AWS', test: (line) => [...line.matchAll(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g)].some((match) => !match[0].endsWith('EXAMPLE')) },
  { label: 'секретный ключ AWS', test: (line) => [...line.matchAll(/aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi)].some((match) => !(match[1] as string).includes('EXAMPLE')) },
  { label: 'токен GitHub', test: (line) => /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/.test(line) },
  { label: 'ключ Anthropic', test: (line) => /\bsk-ant-[A-Za-z0-9_-]{20,}/.test(line) },
  { label: 'ключ OpenAI', test: (line) => /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(line) },
  { label: 'токен Telegram-бота', test: (line) => /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/.test(line) },
  { label: 'токен Slack', test: (line) => /\bxox[abposr]-[A-Za-z0-9-]{10,}/.test(line) },
  { label: 'ключ Stripe', test: (line) => /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/.test(line) },
  { label: 'токен Supabase', test: (line) => /\bsbp_[a-f0-9]{40}\b/.test(line) || hasServiceRoleJwt(line) },
  { label: 'токен npm', test: (line) => /\bnpm_[A-Za-z0-9]{36}\b/.test(line) },
  { label: 'токен в .npmrc', test: (line) => /_authToken\s*=\s*(?!\$\{)\S+/.test(line) },
  { label: 'пароль в адресе базы данных', test: hasDatabasePassword },
  {
    label: 'пароль или ключ в коде',
    test: (line) => [...line.matchAll(/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gi)]
      // Браузерные ключи Google (Firebase, Карты) публичны по замыслу; JWT разбирает правило Supabase.
      .some((match) => !PLACEHOLDER_VALUE.test(match[1] as string) && !/^(?:AIza|eyJ)/.test(match[1] as string)),
  },
];

const MAX_SCAN_BYTES = 50 * 1024 * 1024;

/** Текст файла для проверки: UTF-8 или UTF-16 по метке; двоичный — null. */
function scanText(data: Buffer): string | null {
  if (data[0] === 0xff && data[1] === 0xfe) return data.subarray(2).toString('utf16le');
  if (data[0] === 0xfe && data[1] === 0xff) return Buffer.from(data.subarray(2)).swap16().toString('utf16le');
  if (data.subarray(0, 8000).includes(0)) return null;
  return data.toString('utf8');
}

/** Секреты по имени файла. */
export function secretName(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_NAMES.find((rule) => rule.test(base))?.label ?? null;
}

/** Секреты по имени файла и по содержимому. Значение секрета в находку не попадает. */
export function findSecrets(path: string, data: Buffer): PackFinding[] {
  const named = secretName(path);
  if (named !== null) return [finding('pack-secret', `Похоже на секрет (${named}): такой файл заказчику не отдают.`, path)];
  if (data.length > MAX_SCAN_BYTES) return [];
  const text = scanText(data);
  if (text === null) return [];
  const found: PackFinding[] = [];
  text.split('\n').forEach((line, index) => {
    const rule = SECRET_CONTENT.find((item) => item.test(line));
    if (rule !== undefined) found.push(finding('pack-secret', `Строка ${index + 1} похожа на секрет (${rule.label}).`, path));
  });
  return found;
}

/**
 * Корневые файлы, которые пишет Maestro: подсвечиваются с пометкой «оставьте».
 * Строки самого Maestro не разбираются; свои строки проекта в `.gitignore` — как обычно.
 */
const MAESTRO_ROOT_FILES = new Map<string, { reason: string; ownLines: ReadonlySet<string> }>([
  ['.gitattributes', { reason: 'служебный файл Maestro — оставьте: его проверяет doctor, заказчику он не мешает', ownLines: new Set(GITATTRIBUTES_CONTENT.split('\n')) }],
  ['.gitignore', { reason: 'служебный файл — оставьте: он не пускает в git секреты и лишнее', ownLines: new Set([GITIGNORE_BLOCK_HEADER, ...REQUIRED_GITIGNORE_ENTRIES]) }],
]);

/** Служебные файлы разработки: заказчику обычно не нужны. */
const SERVICE_FILE = /(^|\/)(?:\.gitignore|\.gitattributes|\.DS_Store)$|(^|\/)(?:\.vscode|\.idea|\.github)\/|\.log$/;

/** Подсветка содержимого по строкам: первое совпадение каждого вида на файл. */
function contentHighlights(text: string, home: string, root: string): { reason: string; line: number }[] {
  const variants = (path: string): string[] => (path === '' ? [] : [...new Set([path, path.split('/').join('\\')])]);
  const roots = variants(root.replace(/\\/g, '/').replace(/\/+$/, ''));
  const homes = variants(home.replace(/\\/g, '/').replace(/\/+$/, ''));
  const rules: { reason: string; test: (line: string) => boolean }[] = [
    { reason: 'путь папки проекта', test: (line) => roots.some((path) => line.includes(path)) },
    {
      reason: 'путь домашней папки',
      test: (line) => homes.some((path) => line.includes(path)) || /(?:^|[^\w.-])(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/.test(line),
    },
    { reason: 'временная папка', test: (line) => /(?:^|[^\w.-])(?:\/tmp\/|\/private\/var\/)/.test(line) },
    { reason: 'имя Maestro', test: (line) => /Vibe Coding Maestro|vibe-maestro/i.test(line) },
    // Адрес в интернете (`https://…/wiki/…`) — не внутренняя папка проекта: адреса вырезаются до проверки.
    { reason: 'внутренняя папка', test: (line) => /(?<![\w.-])(?:wiki|maestro|protocols)\/|(?<![\w-])\.claude\//.test(line.replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, '')) },
    // «план 0002», «по плану 0002»; год («план 2026 года») — не номер плана.
    { reason: 'номер плана', test: (line) => /\bPLAN-\d{4}\b|(?<!\p{L})план(?:а|е|у|ы|ом)?\s+(?!(?:19|20)\d\d(?!\d))\d{4}(?!\d)/iu.test(line) },
  ];
  const found = new Map<string, number>();
  text.split('\n').forEach((line, index) => {
    for (const rule of rules) {
      if (!found.has(rule.reason) && rule.test(line)) found.set(rule.reason, index + 1);
    }
  });
  // Путь проекта лежит внутри домашней или временной папки: одну и ту же строку называем точнее.
  for (const wider of ['путь домашней папки', 'временная папка']) {
    if (found.has(wider) && found.get(wider) === found.get('путь папки проекта')) found.delete(wider);
  }
  return rules.flatMap((rule) => (found.has(rule.reason) ? [{ reason: rule.reason, line: found.get(rule.reason) as number }] : []));
}

/**
 * Что подсветить в файле архива: служебный файл, личные и временные пути, имена Maestro,
 * внутренние папки, номера планов. Это повод посмотреть, а не отказ: упаковка не запрещается.
 */
export function packHighlights(path: string, data: Buffer, context: { home: string; root: string }): PackHighlight[] {
  // Корневые файлы, которые кладёт Maestro: о них стоит знать, но убирать их не нужно — они безвредны.
  const maestro = MAESTRO_ROOT_FILES.get(path);
  const highlights: PackHighlight[] = [];
  if (maestro !== undefined) highlights.push({ path, reason: maestro.reason });
  else if (SERVICE_FILE.test(path)) highlights.push({ path, reason: 'служебный файл' });
  if (data.length > MAX_SCAN_BYTES) return highlights;
  const text = scanText(data);
  if (text === null) return highlights;
  // Строки самого Maestro заменяются пустыми: номера остальных строк не сдвигаются.
  const own = maestro === undefined ? text : text.split('\n').map((line) => (maestro.ownLines.has(line.trim()) ? '' : line)).join('\n');
  for (const item of contentHighlights(own, context.home, context.root)) highlights.push({ path, ...item });
  return highlights;
}

/** Ссылка, ведущая за пределы проекта или по абсолютному пути: в архиве она указала бы на чужое. */
function symlinkEscapes(path: string, target: string): boolean {
  if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) return true;
  return posix.normalize(posix.join(posix.dirname(path), target)).startsWith('../');
}

/**
 * Текст `HANDOVER.md`: паспорт из тега и шаг «смените все пароли и ключи». Шаг заменяется
 * на «доступов не было», только если в паспорте все разделы о доступах — «не применимо».
 */
export function handoverText(input: { projectName: string; tag: string; commit: string; passport: string }): string {
  const passport = input.passport.replace(/\r\n/g, '\n');
  const firstSection = passport.search(/^## /m);
  const body = (firstSection < 0 ? passport : passport.slice(firstSection)).replace(/^## /gm, '### ').trimEnd();
  const access = passportHasNoAccess(passport)
    ? ['## Доступы', '', 'Доступов не было, менять нечего: в паспорте все разделы о хостинге, домене, данных, внешних сервисах и переменных окружения — «не применимо».']
    : ['## Первым делом: смените все пароли и ключи', '', 'Пока проект делали, пароли и ключи знали исполнители. Сразу после передачи смените их все: ключи API, пароли от хостинга, баз данных, домена, почты и внешних сервисов. Новые значения задайте там, где они задаются (раздел «Переменные окружения» ниже), и проверьте, что проект работает.'];
  return [
    `# Передача проекта ${input.projectName}`,
    '',
    `Версия: тег \`${input.tag}\`, коммит \`${input.commit}\`.`,
    '',
    ...access,
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

  /** Коммит метки; без метки показ состава берёт последний коммит (HEAD), а упаковка отказывает. */
  const revision = async (ref: string): Promise<string | null> =>
    (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim() || null;
  const tagged = await revision(`refs/tags/${tag}`);
  // Состав смотрят до метки: агент убирает внутреннее, и метку ставят один раз, на чистый коммит.
  const head = tagged === null && options.dryRun === true ? await revision('HEAD') : null;
  const commit = tagged ?? head;
  const untagged = tagged === null;
  if (commit === null) {
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

  const time = Number.parseInt((await git(root, ['show', '-s', '--format=%ct', commit])).trim(), 10);
  if (!Number.isFinite(time)) return fail(finding('pack-commit-time', `Не удалось прочитать время коммита тега «${tag}».`));
  const entries = parseTar(await gitBuffer(root, ['archive', '--format=tar', commit]));
  const notes: string[] = [];
  const submodules = (await git(root, ['ls-tree', '-r', '-z', commit])).split('\0')
    .filter((line) => line.split(' ')[1] === 'commit')
    .map((line) => line.slice(line.indexOf('\t') + 1));
  if (submodules.length > 0) notes.push(`Подмодули Git в архив не входят: ${submodules.join(', ')}.`);

  const allowed = new Set(options.allow ?? []);
  const findings: PackFinding[] = [];
  const kept = entries.filter((entry) => !isInternal(entry.path));
  for (const entry of kept) {
    if (AGENT_PATH.test(entry.path)) {
      findings.push(finding('pack-internal-path', 'Файл или папка агента внутри продукта: заказчику их не отдают.', entry.path));
      continue;
    }
    if (entry.path === HANDOVER_PATH) {
      findings.push(finding('pack-handover-collision', `В корне проекта уже есть ${HANDOVER_PATH}; упаковка пишет этот файл сама. Переименуйте свой и поставьте новый тег.`, entry.path));
      continue;
    }
    if (entry.symlink) {
      if (symlinkEscapes(entry.path, entry.data.toString('utf8'))) findings.push(finding('pack-symlink-outside', 'Ссылка ведёт за пределы проекта: в архиве она укажет на чужие файлы.', entry.path));
      else if (!allowed.has(entry.path) && secretName(entry.path) !== null) findings.push(finding('pack-secret', `Похоже на секрет (${secretName(entry.path)}): такой файл заказчику не отдают.`, entry.path));
      continue;
    }
    if (allowed.has(entry.path)) continue;
    if (entry.data.length > MAX_SCAN_BYTES) notes.push(`Не проверен на секреты (больше 50 МБ): ${entry.path}.`);
    findings.push(...findSecrets(entry.path, entry.data));
  }
  const handover = Buffer.from(handoverText({ projectName, tag, commit, passport }), 'utf8');
  findings.push(...findSecrets(HANDOVER_PATH, handover).map((item) => ({ ...item, message: `${item.message} Секрет в паспорте: в паспорт пишут только имена.` })));
  const packed = new Set(kept.map((entry) => entry.path));
  for (const path of allowed) if (!packed.has(path)) notes.push(`--allow ${path}: такого файла в теге нет, флаг ничего не меняет.`);
  if (findings.length > 0) {
    const allowHint = findings.some((item) => item.code === 'pack-secret' && item.path !== HANDOVER_PATH)
      ? ' Если человек посмотрел файл и это не секрет (например, тестовый пример), повторите с `--allow <путь>` — только после его «да».'
      : '';
    findings.push(finding('pack-refused', `Архив не создан. Уберите это из тега (или пометьте \`export-ignore\` в своём \`.gitattributes\`), закоммитьте, поставьте новый тег и повторите.${allowHint}`));
    return { ok: false, findings, tag, commit };
  }

  const zipEntries: ZipEntry[] = [
    ...kept.map((entry) => ({ path: entry.path, data: entry.data, mode: entry.mode })),
    { path: HANDOVER_PATH, data: handover, mode: 0o100644 },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const context = { home: options.home ?? homedir(), root };
  const highlights = [
    ...kept.flatMap((entry) => (entry.symlink ? (SERVICE_FILE.test(entry.path) ? [{ path: entry.path, reason: 'служебный файл' }] : []) : packHighlights(entry.path, entry.data, context))),
    ...packHighlights(HANDOVER_PATH, handover, context),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const extra = {
    ...(highlights.length > 0 ? { highlights } : {}),
    ...(passportHasNoAccess(passport) ? { noAccess: true as const } : {}),
  };
  if (options.dryRun === true) {
    return {
      ok: true, findings: [], tag, commit, dryRun: true, ...(untagged ? { untagged: true as const } : {}), files: zipEntries.length,
      entries: zipEntries.map((entry) => entry.path), ...(notes.length > 0 ? { notes } : {}), ...extra,
    };
  }

  let zip: Buffer;
  try {
    zip = buildZip(zipEntries, time);
  } catch (cause) {
    if (cause instanceof ZipTooLargeError) return { ok: false, findings: [finding('pack-too-large', cause.message)], tag, commit };
    throw cause;
  }
  const sha256 = createHash('sha256').update(zip).digest('hex');
  let out = resolve(options.out);
  const failWrite = (cause: unknown): PackResult => ({ ok: false, findings: [finding('pack-write-failed', `Не удалось записать архив: ${cause instanceof Error ? cause.message : String(cause)}`, out)], tag, commit });
  try {
    if (existsSync(out) && (await stat(out)).isDirectory()) out = join(out, defaultArchiveName(root, tag));
    const summary = { tag, commit, archive: out, sha256, files: zipEntries.length, bytes: zip.length, ...(notes.length > 0 ? { notes } : {}), ...extra };
    if (existsSync(out)) {
      if ((await stat(out)).isFile() && (await readFile(out)).equals(zip)) return { ok: true, findings: [], reused: true, ...summary };
      return { ok: false, findings: [finding('pack-out-exists', `По этому пути уже есть другой файл: ${out}. Удалите его или укажите другой --out.`, out)], tag, commit };
    }
    await mkdir(dirname(out), { recursive: true });
    const temporary = `${out}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, zip);
      await rename(temporary, out);
    } catch (cause) {
      await rm(temporary, { force: true });
      return failWrite(cause);
    }
    return { ok: true, findings: [], reused: false, ...summary };
  } catch (cause) {
    return failWrite(cause);
  }
}
