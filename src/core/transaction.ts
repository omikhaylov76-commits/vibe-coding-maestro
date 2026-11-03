import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Запись нескольких файлов проекта одной транзакцией: всё готовится в staging,
 * прежние байты — в backup, сбой публикации откатывает уже сделанное.
 *
 * Общая для `upgrade` и `archive`: содержимое приходит байтами, поэтому
 * переносы строк решает вызывающий (upgrade пишет Maestro с LF, archive
 * переносит текст проекта как есть).
 */

/** Папка транзакции `upgrade`; `archive` не работает, пока она есть, и наоборот. */
export const UPGRADE_STAGING_DIR = '.maestro/upgrade-staging';
/** Папка транзакции `archive`. */
export const ARCHIVE_STAGING_DIR = '.maestro/archive-staging';
export const STAGING_DIRS: readonly string[] = [UPGRADE_STAGING_DIR, ARCHIVE_STAGING_DIR];

export type FileAction = 'create' | 'update' | 'remove';

export interface FileOperation {
  path: string;
  action: FileAction;
  /** Новое содержимое; для `remove` не нужно. */
  bytes?: Buffer;
}

export interface TransactionHooks {
  /**
   * Тестовый шов: вызывается перед публикацией очередного пути.
   * Позволяет доказать откат, не полагаясь на права доступа конкретной ОС.
   * В обычной работе не задаётся.
   */
  beforeCommit?: (path: string) => Promise<void>;
}

export type TransactionOutcome =
  | { ok: true }
  | { ok: false; stage: 'prepare'; reason: string }
  | { ok: false; stage: 'commit'; rolledBack: true; reason: string }
  | { ok: false; stage: 'commit'; rolledBack: false; reason: string; unrestored: string[] };

/** Папки удалённых файлов, от глубоких к верхним: убираются, только если опустели. */
function parentDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/').slice(0, -1);
    for (let i = parts.length; i > 0; i -= 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b));
}

/** Каталоги, которых ещё нет: только их можно удалить при откате. */
function missingDirs(root: string, relativePath: string): string[] {
  const parts = relativePath.split('/').slice(0, -1);
  const created: string[] = [];
  let current = '';
  for (const part of parts) {
    current = current === '' ? part : `${current}/${part}`;
    if (!existsSync(join(root, current))) created.push(current);
  }
  return created;
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Гарантии:
 * - всё содержимое готовится в staging до того, как затронут первый файл проекта;
 * - staging создаётся без `recursive`: занятая папка (вторая транзакция) — отказ до записи;
 * - сбой публикации откатывает уже опубликованные и удалённые пути из backup;
 * - каталоги, созданные ради новых путей, при откате удаляются, только если пусты;
 * - папка, которую опустошило удаление, уходит вместе с файлами.
 */
export async function applyTransaction(
  root: string,
  stagingDir: string,
  operations: readonly FileOperation[],
  hooks: TransactionHooks = {},
): Promise<TransactionOutcome> {
  const staging = join(root, stagingDir);
  const newDir = join(staging, 'new');
  const backupDir = join(staging, 'backup');

  const createdDirs: string[] = [];
  for (const operation of operations) {
    if (operation.action !== 'create') continue;
    for (const dir of missingDirs(root, operation.path)) if (!createdDirs.includes(dir)) createdDirs.push(dir);
  }

  try {
    await mkdir(staging, { recursive: false });
  } catch (cause) {
    // Чужую staging-папку не трогаем: её занятость и есть причина отказа.
    return { ok: false, stage: 'prepare', reason: message(cause) };
  }
  try {
    for (const operation of operations) {
      if (operation.action !== 'remove') {
        const target = join(newDir, operation.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, operation.bytes ?? Buffer.alloc(0));
      }
      if (operation.action !== 'create') {
        // Backup — точная копия байтов: откат возвращает обновлённый или удалённый файл таким, каким он был.
        await mkdir(dirname(join(backupDir, operation.path)), { recursive: true });
        await copyFile(join(root, operation.path), join(backupDir, operation.path));
      }
    }
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, stage: 'prepare', reason: message(cause) };
  }

  const committed: FileOperation[] = [];
  try {
    for (const operation of operations) {
      if (hooks.beforeCommit !== undefined) await hooks.beforeCommit(operation.path);
      const target = join(root, operation.path);
      if (operation.action === 'remove') {
        await rm(target);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await rename(join(newDir, operation.path), target);
      }
      committed.push(operation);
    }
  } catch (cause) {
    const reason = message(cause);
    const unrestored: string[] = [];
    for (const operation of [...committed].reverse()) {
      const target = join(root, operation.path);
      try {
        if (operation.action === 'create') {
          await rm(target, { force: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await rename(join(backupDir, operation.path), target);
        }
      } catch {
        unrestored.push(operation.path);
      }
    }
    // Откат не удался: backup — единственная копия прежних файлов, удалять его нельзя.
    if (unrestored.length > 0) return { ok: false, stage: 'commit', rolledBack: false, reason, unrestored };
    for (const dir of [...createdDirs].reverse()) await rmdir(join(root, dir)).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    return { ok: false, stage: 'commit', rolledBack: true, reason };
  }

  const removed = operations.filter((operation) => operation.action === 'remove').map((operation) => operation.path);
  for (const dir of parentDirs(removed)) await rmdir(join(root, dir)).catch(() => undefined);
  await rm(staging, { recursive: true, force: true });
  return { ok: true };
}
