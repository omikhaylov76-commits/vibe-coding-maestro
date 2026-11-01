import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { diffText } from '../text-diff.js';
import type { TextDiff } from '../text-diff.js';
import { analyzeUpgrade, STAGING_DIR } from './analyze.js';
import type { UpgradeAnalysis, UpgradePlan } from './analyze.js';

export { analyzeUpgrade, STAGING_DIR } from './analyze.js';
export type { UpgradeAnalysis, UpgradeBlocker, UpgradeChange, UpgradePlan, UpgradeStatus } from './analyze.js';
export { BASELINE_ID } from './baseline.js';

export interface UpgradeHooks {
  /**
   * Тестовый шов: вызывается перед публикацией очередного пути.
   * Позволяет доказать откат, не полагаясь на права доступа конкретной ОС.
   * В обычной работе не задаётся.
   */
  beforeCommit?: (path: string) => Promise<void>;
}

export interface UpgradeOptions {
  /** Запись выполняется только по явному apply; по умолчанию это dry-run. */
  apply?: boolean;
  hooks?: UpgradeHooks;
}

export interface UpgradeResult {
  ok: boolean;
  applied: boolean;
  analysis: UpgradeAnalysis;
  createdFiles: string[];
  updatedFiles: string[];
  removedFiles: string[];
  rolledBack: boolean;
  error?: string;
  /** Точное содержимое предложения — для показа правок. В отчёт `--json` не входит. */
  plan: UpgradePlan;
}

const result = (plan: UpgradePlan, patch: Partial<UpgradeResult> = {}): UpgradeResult => ({
  ok: plan.analysis.status !== 'blocked',
  applied: false,
  analysis: plan.analysis,
  createdFiles: [],
  updatedFiles: [],
  removedFiles: [],
  rolledBack: false,
  plan,
  ...patch,
});

export interface UpgradeFileDiff {
  path: string;
  action: 'create' | 'update' | 'remove';
  diff: TextDiff;
}

/**
 * Правки предложения по каждому файлу, кроме служебных manifest и checksums:
 * что добавится, что изменится строка за строкой, что удалится. Только чтение.
 */
export async function upgradeDiffs(plan: UpgradePlan): Promise<UpgradeFileDiff[]> {
  const diffs: UpgradeFileDiff[] = [];
  for (const write of plan.writes) {
    if (plan.analysis.metadata.includes(write.path)) continue;
    // Дописанный .gitignore хранится байтами (latin1); показывается как UTF-8, как его видит человек.
    const after = write.encoding === 'latin1' ? Buffer.from(write.content, 'latin1').toString('utf8') : write.content;
    const before = write.action === 'create' ? '' : await readFile(join(plan.root, write.path), 'utf8');
    diffs.push({ path: write.path, action: write.action, diff: diffText(before, write.action === 'remove' ? '' : after) });
  }
  return diffs;
}

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

/** Содержимое Maestro пишется с LF; дописанный файл проекта (`latin1`) — байт в байт. */
async function writeStaged(absolute: string, content: string, encoding?: 'latin1'): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true });
  if (encoding === 'latin1') await writeFile(absolute, Buffer.from(content, 'latin1'));
  else await writeFile(absolute, content.replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Безопасная эволюция канонического проекта предыдущей версии.
 *
 * Гарантии:
 * - без `apply` не записывается ни один байт;
 * - любое сомнение — блокировка целиком, а не частичное применение;
 * - всё содержимое готовится в staging до того, как затронут первый файл проекта;
 * - сбой публикации откатывает уже переименованные и удалённые пути из backup;
 * - файлы, которыми владеет проект, и Git-история не изменяются.
 */
export async function upgradeProject(rootInput: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const plan = await analyzeUpgrade(rootInput);
  if (plan.analysis.status !== 'upgradable' || options.apply !== true) return result(plan);

  const { root, writes } = plan;
  const staging = join(root, STAGING_DIR);
  const newDir = join(staging, 'new');
  const backupDir = join(staging, 'backup');

  const createdDirs: string[] = [];
  for (const write of writes) {
    if (write.action !== 'create') continue;
    for (const dir of missingDirs(root, write.path)) if (!createdDirs.includes(dir)) createdDirs.push(dir);
  }

  try {
    await mkdir(staging, { recursive: false });
    for (const write of writes) {
      if (write.action !== 'remove') await writeStaged(join(newDir, write.path), write.content, write.encoding);
      if (write.action !== 'create') {
        // Backup — точная копия байтов: откат возвращает обновлённый или удалённый файл таким, каким он был.
        await mkdir(dirname(join(backupDir, write.path)), { recursive: true });
        await copyFile(join(root, write.path), join(backupDir, write.path));
      }
    }
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });
    return result(plan, {
      ok: false,
      error: `Подготовка транзакции не удалась, проект не изменён: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  const committed: typeof writes = [];
  try {
    for (const write of writes) {
      if (options.hooks?.beforeCommit !== undefined) await options.hooks.beforeCommit(write.path);
      const target = join(root, write.path);
      if (write.action === 'remove') {
        await rm(target);
      } else {
        await mkdir(dirname(target), { recursive: true });
        await rename(join(newDir, write.path), target);
      }
      committed.push(write);
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const unrestored: string[] = [];
    for (const write of [...committed].reverse()) {
      const target = join(root, write.path);
      try {
        if (write.action === 'create') {
          await rm(target, { force: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await rename(join(backupDir, write.path), target);
        }
      } catch {
        unrestored.push(write.path);
      }
    }
    if (unrestored.length > 0) {
      // Откат не удался: backup — единственная копия прежних файлов, удалять его нельзя.
      return result(plan, {
        ok: false,
        rolledBack: false,
        error: `Применение прервано (${reason}), и откатить удалось не всё: ${unrestored.join(', ')}. Прежние версии файлов оставлены в ${STAGING_DIR}/backup/ — верните их вручную, затем удалите ${STAGING_DIR}.`,
      });
    }
    // Каталоги, созданные ради новых путей, удаляются только пустыми и только свои.
    for (const dir of [...createdDirs].reverse()) await rmdir(join(root, dir)).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    return result(plan, {
      ok: false,
      rolledBack: true,
      error: `Применение прервано и откачено: ${reason}`,
    });
  }

  const removedFiles = writes.filter((write) => write.action === 'remove').map((write) => write.path);
  // Папка, которую опустошило удаление (например, protocols/build/), уходит вместе с файлами.
  for (const dir of parentDirs(removedFiles)) await rmdir(join(root, dir)).catch(() => undefined);
  await rm(staging, { recursive: true, force: true });
  return result(plan, {
    ok: true,
    applied: true,
    createdFiles: writes.filter((write) => write.action === 'create').map((write) => write.path),
    updatedFiles: writes.filter((write) => write.action === 'update').map((write) => write.path),
    removedFiles,
  });
}
