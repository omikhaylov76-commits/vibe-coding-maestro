import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { absolutePathHasSymlink, pathHasSymlink } from '../doctor/fs-utils.js';
import { loadManifest, MANIFEST_PATH } from '../manifest.js';
import { CREATE_COMMAND, quotePathArg, serviceInvocation, VERSION } from '../meta.js';
import { readPackageJson } from '../paths.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { applyTransaction, ARCHIVE_STAGING_DIR, STAGING_DIRS } from '../transaction.js';
import type { FileAction, FileOperation, TransactionHooks } from '../transaction.js';
import { compareVersions } from '../version.js';
import { LOG_KEEP, LOG_LIMIT } from './limits.js';
import { appendToMonth, eolOf, LOG_PATH, rotateLog } from './log.js';

/**
 * Перенос старой памяти проекта в архив внутри проекта: ничего не удаляется,
 * текст переносится байт в байт, меняются только адреса ссылок.
 *
 * Без `apply` не записывается ни один байт; любое сомнение — отказ целиком.
 */

const execFileAsync = promisify(execFile);

export interface ArchiveBlocker {
  code: string;
  message: string;
  path?: string;
}

export interface ArchiveLogReport {
  chars: number;
  limit: number;
  keep: number;
  movedEntries: number;
  keptEntries: number;
  months: { path: string; entries: number }[];
}

export interface ArchiveReport {
  reportVersion: 1;
  ok: boolean;
  applied: boolean;
  rolledBack: boolean;
  error?: string;
  root: string;
  blockers: ArchiveBlocker[];
  /** Журнал: `null` — переносить нечего. */
  log: ArchiveLogReport | null;
  /** Что запишется (или записано) в проекте. */
  writes: { path: string; action: FileAction }[];
}

export interface ArchiveOptions {
  /** Запись выполняется только по явному apply; по умолчанию это пробный запуск. */
  apply?: boolean;
  hooks?: TransactionHooks;
}

const blocker = (code: string, message: string, path?: string): ArchiveBlocker => ({ code, message, ...(path === undefined ? {} : { path }) });

/** Строгий UTF-8 с сохранением BOM: перенос — байт в байт. */
function decodeExact(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function readText(root: string, path: string): Promise<string | null | undefined> {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return undefined;
  return decodeExact(await readFile(absolute));
}

/** Путь, который git игнорирует, не попадёт в копию в облаке. Проект без git — проверки нет. */
async function ignoredByGit(root: string, path: string): Promise<boolean> {
  if (!existsSync(join(root, '.git'))) return false;
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
  return { reportVersion: 1, ok: blockers.length === 0, applied: false, rolledBack: false, root, blockers, log: null, writes: [], ...patch };
}

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
  if (await pathHasSymlink(root, 'wiki')) found.push(blocker('archive-symlink', 'Путь wiki не должен содержать symbolic link.', 'wiki'));
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
  const contents = new Map<string, { action: FileAction; text: string }>();

  const logText = await readText(root, LOG_PATH);
  let log: ArchiveLogReport | null = null;
  if (logText === null) blockers.push(blocker('archive-invalid-utf8', 'Файл должен быть корректным UTF-8: archive переносит текст байт в байт.', LOG_PATH));
  else if (logText !== undefined) {
    const rotation = rotateLog(logText);
    if (rotation !== null) {
      const eol = eolOf(logText);
      contents.set(LOG_PATH, { action: 'update', text: rotation.log });
      for (const month of rotation.months) {
        const existing = await readText(root, month.path);
        if (existing === null) { blockers.push(blocker('archive-invalid-utf8', 'Файл должен быть корректным UTF-8: archive дописывает в него записи.', month.path)); continue; }
        contents.set(month.path, {
          action: existing === undefined ? 'create' : 'update',
          text: appendToMonth(existing ?? null, month.path.slice(-10, -3), month.appended, eol),
        });
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
  }

  const writes = [...contents.entries()].map(([path, value]) => ({ path, action: value.action })).sort((a, b) => a.path.localeCompare(b.path));
  for (const write of writes) {
    if (await pathHasSymlink(root, write.path)) blockers.push(blocker('archive-symlink', 'Путь переноса содержит symbolic link: запись ушла бы за пределы проекта.', write.path));
    else if (write.action === 'create' && await ignoredByGit(root, write.path)) {
      blockers.push(blocker('archive-destination-ignored', 'Git игнорирует этот путь (.gitignore): перенесённое не попадёт в копию в облаке, а ссылки на свежем клоне станут битыми. Уберите правило из .gitignore и запустите снова.', write.path));
    }
  }
  if (blockers.length > 0) return report(root, { blockers, log });
  if (options.apply !== true || writes.length === 0) return report(root, { log, writes });

  const operations: FileOperation[] = writes.map((write) => ({ path: write.path, action: write.action, bytes: Buffer.from(contents.get(write.path)!.text, 'utf8') }));
  const outcome = await applyTransaction(root, ARCHIVE_STAGING_DIR, operations, options.hooks);
  if (outcome.ok) return report(root, { applied: true, log, writes });
  if (outcome.stage === 'prepare') return report(root, { ok: false, log, writes, error: `Подготовка переноса не удалась, проект не изменён: ${outcome.reason}` });
  if (!outcome.rolledBack) {
    return report(root, {
      ok: false,
      log,
      writes,
      error: `Перенос прерван (${outcome.reason}), и откатить удалось не всё: ${outcome.unrestored.join(', ')}. Прежние версии файлов оставлены в ${ARCHIVE_STAGING_DIR}/backup/ — верните их вручную, затем удалите ${ARCHIVE_STAGING_DIR}.`,
    });
  }
  return report(root, { ok: false, rolledBack: true, log, writes, error: `Перенос прерван и откачен: ${outcome.reason}` });
}
