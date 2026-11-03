import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { absolutePathHasSymlink, markdownFiles, pathHasSymlink } from '../doctor/fs-utils.js';
import { loadManifest, MANIFEST_PATH } from '../manifest.js';
import { CREATE_COMMAND, quotePathArg, serviceInvocation, VERSION } from '../meta.js';
import { readPackageJson } from '../paths.js';
import { planBodyDigest } from '../plan.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { applyTransaction, ARCHIVE_STAGING_DIR, STAGING_DIRS } from '../transaction.js';
import type { FileAction, FileOperation, TransactionHooks } from '../transaction.js';
import { compareVersions } from '../version.js';
import { HOT_PATH } from '../doctor/plans.js';
import { ACTIVE_PLAN_NONE, isWikiRelativePlanRef } from '../plan.js';
import { AUDIT_FILE_RE, AUDITS_ARCHIVE_DIR, selectAudits } from './audits.js';
import type { KeptAudit } from './audits.js';
import { projectDisk } from './disk.js';
import { countChars, formatChars, LOG_KEEP, LOG_LIMIT } from './limits.js';
import { rebaseLinks } from './links.js';
import { appendToMonth, LOG_DIR, LOG_PATH, parseLog, rotateLog } from './log.js';
import { eolOf, withoutBom } from './markdown.js';
import { appendToPlanArchive, cutSections, declaredPlan, digestLine, planArchivePath, planFiles, PLANS_ARCHIVE_DIR, resolveSections, sectionChars, writeDigest } from './plan.js';
import type { SectionChoice } from './plan.js';
import { blocker } from './types.js';
import type { ArchiveBlocker } from './types.js';

export type { ArchiveBlocker } from './types.js';

/**
 * Перенос старой памяти проекта в архив внутри проекта: ничего не удаляется,
 * текст переносится байт в байт, меняются только адреса ссылок.
 *
 * Без `apply` не записывается ни один байт; любое сомнение — отказ целиком.
 */

const execFileAsync = promisify(execFile);

export interface ArchiveLogReport {
  chars: number;
  limit: number;
  keep: number;
  movedEntries: number;
  keptEntries: number;
  months: { path: string; entries: number }[];
}

export interface ArchiveAuditsReport {
  moved: { from: string; to: string }[];
  /** Закрытые и открытые отчёты, которые остаются, с причиной. */
  kept: KeptAudit[];
}

export interface ArchiveSectionReport {
  heading: string;
  /** `moved` — переносится; `already` — от раздела осталась только строка «В архиве: …». */
  status: 'moved' | 'already';
  chars: number;
  nested: { heading: string; chars: number }[];
  warnings: string[];
}

export interface ArchiveReport {
  reportVersion: 1;
  ok: boolean;
  applied: boolean;
  rolledBack: boolean;
  /** Откат не удался: проект изменён частично. */
  partial: boolean;
  error?: string;
  root: string;
  blockers: ArchiveBlocker[];
  /** Журнал: `null` — переносить нечего. */
  log: ArchiveLogReport | null;
  /** Журнал больше порога, а переносить нечего: почему. */
  logNote: string | null;
  audits: ArchiveAuditsReport;
  /** План, из которого переносятся разделы; `null` — `--section` не задан. */
  plan: string | null;
  /** Куда переносятся разделы. */
  planArchive: string | null;
  sections: ArchiveSectionReport[];
  /** Планы, у которых записан новый отпечаток. */
  digests: { plan: string; before: string; after: string }[];
  /** Файлы, где изменились только адреса ссылок. */
  relinked: string[];
  /** Что запишется (или записано) в проекте. */
  writes: { path: string; action: FileAction }[];
}

export interface ArchiveOptions {
  /** Запись выполняется только по явному apply; по умолчанию это пробный запуск. */
  apply?: boolean;
  /** Начала заголовков закрытых правок активного плана. */
  sections?: readonly string[];
  /** Дата для строки об отпечатке; по умолчанию сегодня. */
  now?: Date;
  hooks?: TransactionHooks;
}

/** Строгий UTF-8 с сохранением BOM: перенос — байт в байт. */
function decodeExact(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** Все документы wiki как на диске; папку-ссылку и файл-ссылку обходит, как doctor. */
async function readWiki(root: string, blockers: ArchiveBlocker[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const absolute of await markdownFiles(join(root, 'wiki'))) {
    const path = relative(root, absolute).split(sep).join('/');
    try {
      const text = decodeExact(await readFile(absolute));
      if (text === null) blockers.push(blocker('archive-invalid-utf8', 'Файл должен быть корректным UTF-8: archive переносит текст байт в байт и правит адреса ссылок.', path));
      else files.set(path, text);
    } catch (cause) {
      blockers.push(blocker('archive-unreadable', `Файл не прочитать: ${cause instanceof Error ? cause.message : String(cause)}`, path));
    }
  }
  return files;
}

/** Путь, который git игнорирует, не попадёт в копию в облаке. Вне репозитория проверки нет; репозиторий может быть и выше проекта. */
async function ignoredByGit(root: string, path: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '-q', '--', path], { cwd: root });
    return true;
  } catch {
    // Код 1 — не игнорируется; 128 и прочее — не репозиторий или git недоступен: не мешаем переносу.
    return false;
  }
}

function report(root: string, patch: Partial<ArchiveReport>): ArchiveReport {
  const blockers = patch.blockers ?? [];
  return {
    reportVersion: 1, ok: blockers.length === 0, applied: false, rolledBack: false, partial: false, root, blockers,
    log: null, logNote: null, audits: { moved: [], kept: [] }, plan: null, planArchive: null, sections: [], digests: [], relinked: [], writes: [], ...patch,
  };
}

const ARCHIVE_DIRS: readonly string[] = [LOG_DIR, AUDITS_ARCHIVE_DIR, PLANS_ARCHIVE_DIR];
/** Пути, с которыми работает archive: если один из них symbolic link, запись или чтение ушли бы не туда. */
const MEMORY_PATHS: readonly string[] = [HOT_PATH, LOG_PATH, 'wiki/audits', 'wiki/plans', ...ARCHIVE_DIRS, ARCHIVE_STAGING_DIR];

async function preconditions(root: string, rootInput: string): Promise<ArchiveBlocker[]> {
  if (!existsSync(root)) return [blocker('archive-path-missing', `Папка не найдена: ${root}. Проверьте путь; путь с пробелами возьмите в кавычки.`)];
  if (!statSync(root).isDirectory()) return [blocker('archive-path-not-directory', `Это файл, а не папка проекта: ${root}.`)];
  if (await absolutePathHasSymlink(root)) return [blocker('archive-symlink', 'Путь к корню проекта не должен содержать symbolic link.', root)];
  if (!existsSync(join(root, MANIFEST_PATH))) return [blocker('archive-not-project', `В папке нет ${MANIFEST_PATH}: это не проект Vibe Coding Maestro или указана не та папка.`, MANIFEST_PATH)];
  let manifest;
  try {
    manifest = await loadManifest(root);
  } catch (cause) {
    return [blocker('archive-manifest-invalid', `Манифест повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, MANIFEST_PATH)];
  }
  if (manifest.product.name !== readPackageJson().name || manifest.product.createdBy !== CREATE_COMMAND) {
    return [blocker('archive-not-project', 'Манифест создан не Vibe Coding Maestro: archive переносит только память проекта Maestro.', MANIFEST_PATH)];
  }
  const projectVersion = manifest.product.version;
  if (projectVersion !== VERSION) {
    const path = quotePathArg(rootInput);
    const older = (compareVersions(projectVersion, VERSION) ?? -1) < 0;
    return [blocker('archive-version-mismatch', older
      ? `Проект на версии ${projectVersion}, а archive — ${VERSION}: правила памяти у версий разные. Сначала обновите проект: \`${serviceInvocation(VERSION)} upgrade --path ${path}\` (без --apply только показывает изменения).`
      : `Проект на версии ${projectVersion}, а archive — ${VERSION}. Запустите archive версии проекта: \`${serviceInvocation(projectVersion)} archive --path ${path}\`.`, MANIFEST_PATH)];
  }
  const found: ArchiveBlocker[] = [];
  for (const staging of STAGING_DIRS) {
    if (existsSync(join(root, staging))) {
      found.push(blocker('archive-staging-present', 'Каталог транзакции уже существует: прошлый запуск upgrade или archive был прерван. В его подпапке backup/ лежат прежние версии файлов. Сверьте проект (git status, git diff), верните нужное из backup/ и только потом удалите каталог.', staging));
    }
  }
  if (await pathHasSymlink(root, 'wiki')) {
    found.push(blocker('archive-symlink', 'Путь wiki не должен содержать symbolic link.', 'wiki'));
    return found;
  }
  for (const path of MEMORY_PATHS) {
    if (await pathHasSymlink(root, path)) found.push(blocker('archive-symlink', 'Путь памяти проекта содержит symbolic link: archive с такими путями не работает.', path));
  }
  for (const path of ARCHIVE_DIRS) {
    if (existsSync(join(root, path)) && !statSync(join(root, path)).isDirectory()) found.push(blocker('archive-not-directory', 'На этом месте должна быть папка архива, а лежит файл: переименуйте файл и запустите снова.', path));
  }
  return found;
}

/**
 * Предложение переноса и, по `apply`, сам перенос одной транзакцией.
 *
 * Гарантии:
 * - без `apply` не записывается ни один байт;
 * - перенесённый текст — байт в байт, кроме адресов относительных ссылок;
 * - ничего не удаляется из проекта: старое переезжает в архивные файлы;
 * - сбой посреди записи откатывает всё уже записанное.
 */
export async function archiveProject(rootInput: string, options: ArchiveOptions = {}): Promise<ArchiveReport> {
  const root = await canonicalizeSystemTempPrefix(resolve(rootInput));
  const before = await preconditions(root, rootInput);
  if (before.length > 0) return report(root, { blockers: before });

  const blockers: ArchiveBlocker[] = [];
  const files = await readWiki(root, blockers);
  if (blockers.length > 0) return report(root, { blockers });

  const wanted = options.sections ?? [];
  const declared = declaredPlan(files);
  if (wanted.length > 0 && declared !== ACTIVE_PLAN_NONE && isWikiRelativePlanRef(declared) && await pathHasSymlink(root, `wiki/${declared}`)) {
    return report(root, { blockers: [blocker('archive-symlink', 'Активный план — symbolic link: archive с такими путями не работает.', `wiki/${declared}`)] });
  }

  const plans = planFiles(files);
  // Отпечаток сверяется здесь один раз, до всех правок: после переноса сверять уже нечего.
  const resolution = wanted.length > 0 ? resolveSections(files, plans, wanted) : { plan: null, chosen: [] as SectionChoice[], blockers: [] };
  blockers.push(...resolution.blockers);
  const sectionPlan = resolution.plan;
  const sections = sectionPlan === null ? [] : resolution.chosen.map((choice): ArchiveSectionReport => ({
    heading: choice.heading.title,
    status: choice.already ? 'already' : 'moved',
    chars: sectionChars(sectionPlan.text, choice.heading),
    nested: choice.nested.map((heading) => ({ heading: heading.title, chars: sectionChars(sectionPlan.text, heading) })),
    warnings: choice.warnings,
  }));

  const disk = projectDisk(root, [...files.keys()].filter((path) => AUDIT_FILE_RE.test(path)));
  const { moved, kept } = selectAudits(files, plans, disk);
  const audits: ArchiveAuditsReport = { moved: [...moved].map(([from, to]) => ({ from, to })), kept };

  // Адреса считаются от конечных мест всех файлов сразу: сначала все правят ссылки, потом переносы.
  const next = new Map<string, string>();
  for (const [path, text] of files) next.set(path, rebaseLinks(text, path, path, moved, disk.locate));
  for (const [from, to] of moved) {
    next.delete(from);
    next.set(to, rebaseLinks(files.get(from)!, from, to, moved, disk.locate));
  }

  const touched = new Set<string>();
  /** Файлы, куда приходит перенесённый текст: они обязаны быть в git. */
  const destinations = new Set<string>(moved.values());
  let log: ArchiveLogReport | null = null;
  const logText = files.get(LOG_PATH);
  const rotation = logText === undefined ? null : rotateLog(logText, moved, disk.locate);
  if (rotation !== null) {
    const eol = eolOf(logText!);
    next.set(LOG_PATH, rotation.log);
    touched.add(LOG_PATH);
    for (const month of rotation.months) {
      next.set(month.path, appendToMonth(next.get(month.path) ?? null, month.path.slice(-10, -3), month.appended, eol));
      touched.add(month.path);
      destinations.add(month.path);
    }
    log = {
      chars: rotation.chars,
      limit: LOG_LIMIT,
      keep: LOG_KEEP,
      movedEntries: rotation.months.reduce((sum, month) => sum + month.entries, 0),
      keptEntries: rotation.keptEntries,
      months: rotation.months.map(({ path, entries }) => ({ path, entries })),
    };
  }
  let logNote: string | null = null;
  if (logText !== undefined && rotation === null && countChars(logText) > LOG_LIMIT) {
    const size = `${formatChars(countChars(logText))} знаков при пороге ${formatChars(LOG_LIMIT)}`;
    logNote = parseLog(logText).entries.length === 0
      ? `Журнал wiki/log.md: ${size}, но нет записей с датой в начале заголовка («## ГГГГ-ММ-ДД — …»): переносить нечего.`
      : `Журнал wiki/log.md: ${size}, но все записи с датой входят в последние ${formatChars(LOG_KEEP)} знаков или запись одна: переносить нечего, сократите шапку или длинную запись.`;
  }

  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const digests: ArchiveReport['digests'] = [];
  for (const plan of plans) {
    const eol = eolOf(plan.text);
    const archivePath = planArchivePath(plan.path);
    const cut = plan === sectionPlan ? cutSections(plan.text, resolution.chosen, archivePath, eol) : null;
    let text = rebaseLinks(cut?.remaining ?? plan.text, plan.path, plan.path, moved, disk.locate);
    if (text === plan.text) continue;
    const blocks = (cut?.sections ?? []).map((section) => rebaseLinks(section, plan.path, archivePath, moved, disk.locate));
    if (plan.digest !== null && (plan.guarded || cut !== null)) {
      const after = planBodyDigest(withoutBom(text));
      if (after !== plan.digest) {
        text = writeDigest(text, after);
        digests.push({ plan: plan.path, before: plan.digest, after });
        blocks.push(digestLine(date, plan.digest, after, eol));
      }
    }
    next.set(plan.path, text);
    if (cut !== null) touched.add(plan.path);
    if (blocks.length > 0) {
      next.set(archivePath, appendToPlanArchive(next.get(archivePath) ?? null, plan, blocks, eol));
      touched.add(archivePath);
      destinations.add(archivePath);
    }
  }

  const contents = new Map<string, { action: FileAction; text: string }>();
  for (const [path, text] of next) {
    const before = files.get(path);
    if (before === undefined) contents.set(path, { action: 'create', text });
    else if (before !== text) contents.set(path, { action: 'update', text });
  }
  for (const from of moved.keys()) contents.set(from, { action: 'remove', text: '' });

  const writes = [...contents.entries()].map(([path, value]) => ({ path, action: value.action })).sort((a, b) => a.path.localeCompare(b.path));
  for (const write of writes) {
    if (await pathHasSymlink(root, write.path)) blockers.push(blocker('archive-symlink', 'Путь переноса содержит symbolic link: запись ушла бы за пределы проекта.', write.path));
    else if (write.action === 'create' && disk.exists(write.path)) {
      blockers.push(blocker('archive-destination-exists', 'На этом месте уже есть файл: его имя отличается только регистром или формой букв. archive его не перезаписывает: приведите имена к одному виду и запустите снова.', write.path));
    } else if (destinations.has(write.path) && await ignoredByGit(root, write.path)) {
      blockers.push(blocker('archive-destination-ignored', 'Git игнорирует этот путь (.gitignore): перенесённое не попадёт в копию в облаке, а ссылки на свежем клоне станут битыми. Уберите правило из .gitignore и запустите снова.', write.path));
    }
  }
  const relinked = writes.filter((write) => write.action === 'update' && !touched.has(write.path)).map((write) => write.path);
  const details = { log, logNote, audits, plan: sectionPlan?.path ?? null, planArchive: sectionPlan === null ? null : planArchivePath(sectionPlan.path), sections, digests, relinked };
  if (blockers.length > 0) return report(root, { blockers, ...details });
  if (options.apply !== true || writes.length === 0) return report(root, { ...details, writes });

  const operations: FileOperation[] = writes.map((write) => (write.action === 'remove'
    ? { path: write.path, action: write.action }
    : { path: write.path, action: write.action, bytes: Buffer.from(contents.get(write.path)!.text, 'utf8') }));
  const outcome = await applyTransaction(root, ARCHIVE_STAGING_DIR, operations, options.hooks);
  if (outcome.ok) return report(root, { applied: true, ...details, writes });
  if (outcome.stage === 'prepare') return report(root, { ok: false, ...details, writes, error: `Подготовка переноса не удалась, проект не изменён: ${outcome.reason}` });
  if (!outcome.rolledBack) {
    return report(root, {
      ok: false,
      partial: true,
      ...details,
      writes,
      error: `Перенос прерван (${outcome.reason}), и откатить удалось не всё: ${outcome.unrestored.join(', ')}. Прежние версии файлов оставлены в ${ARCHIVE_STAGING_DIR}/backup/ — верните их вручную, затем удалите ${ARCHIVE_STAGING_DIR}.`,
    });
  }
  return report(root, { ok: false, rolledBack: true, ...details, writes, error: `Перенос прерван и откачен: ${outcome.reason}` });
}
