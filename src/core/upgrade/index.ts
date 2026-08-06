import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { analyzeUpgrade, STAGING_DIR } from './analyze.js';
import type { UpgradeAnalysis, UpgradePlan } from './analyze.js';

export { analyzeUpgrade, STAGING_DIR } from './analyze.js';
export type { UpgradeAnalysis, UpgradeBlocker, UpgradeChange, UpgradeStatus } from './analyze.js';
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
  rolledBack: boolean;
  error?: string;
}

const result = (plan: UpgradePlan, patch: Partial<UpgradeResult> = {}): UpgradeResult => ({
  ok: plan.analysis.status !== 'blocked',
  applied: false,
  analysis: plan.analysis,
  createdFiles: [],
  updatedFiles: [],
  rolledBack: false,
  ...patch,
});

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

async function writeStaged(absolute: string, content: string): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content.replace(/\r\n/g, '\n'), 'utf8');
}

/**
 * Безопасная эволюция канонического проекта предыдущей версии.
 *
 * Гарантии:
 * - без `apply` не записывается ни один байт;
 * - любое сомнение — блокировка целиком, а не частичное применение;
 * - всё содержимое готовится в staging до того, как затронут первый файл проекта;
 * - сбой публикации откатывает уже переименованные пути из backup;
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
      await writeStaged(join(newDir, write.path), write.content);
      if (write.action === 'update') {
        await writeStaged(join(backupDir, write.path), await readFile(join(root, write.path), 'utf8'));
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
      await mkdir(dirname(target), { recursive: true });
      await rename(join(newDir, write.path), target);
      committed.push(write);
    }
  } catch (cause) {
    for (const write of [...committed].reverse()) {
      const target = join(root, write.path);
      if (write.action === 'update') await rename(join(backupDir, write.path), target).catch(() => undefined);
      else await rm(target, { force: true });
    }
    // Каталоги, созданные ради новых путей, удаляются только пустыми и только свои.
    for (const dir of [...createdDirs].reverse()) await rmdir(join(root, dir)).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    return result(plan, {
      ok: false,
      rolledBack: true,
      error: `Применение прервано и откачено: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }

  await rm(staging, { recursive: true, force: true });
  return result(plan, {
    ok: true,
    applied: true,
    createdFiles: writes.filter((write) => write.action === 'create').map((write) => write.path),
    updatedFiles: writes.filter((write) => write.action === 'update').map((write) => write.path),
  });
}
