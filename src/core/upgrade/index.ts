import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyTransaction } from '../transaction.js';
import type { TransactionHooks } from '../transaction.js';
import { diffText } from '../text-diff.js';
import type { TextDiff } from '../text-diff.js';
import { analyzeUpgrade, STAGING_DIR } from './analyze.js';
import type { UpgradeAnalysis, UpgradePlan } from './analyze.js';

export { analyzeUpgrade, STAGING_DIR } from './analyze.js';
export type { UpgradeAnalysis, UpgradeBlocker, UpgradeChange, UpgradePlan, UpgradeStatus } from './analyze.js';
export { BASELINE_ID } from './baseline.js';

/** Тестовый шов транзакции — см. `TransactionHooks`. */
export type UpgradeHooks = TransactionHooks;

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

/** Содержимое Maestro пишется с LF; дописанный файл проекта (`latin1`) — байт в байт. */
function stagedBytes(content: string, encoding?: 'latin1'): Buffer {
  return encoding === 'latin1' ? Buffer.from(content, 'latin1') : Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8');
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
  const outcome = await applyTransaction(
    root,
    STAGING_DIR,
    writes.map((write) => ({ path: write.path, action: write.action, ...(write.action === 'remove' ? {} : { bytes: stagedBytes(write.content, write.encoding) }) })),
    options.hooks,
  );
  if (!outcome.ok) {
    if (outcome.stage === 'prepare') {
      return result(plan, { ok: false, error: `Подготовка транзакции не удалась, проект не изменён: ${outcome.reason}` });
    }
    if (!outcome.rolledBack) {
      return result(plan, {
        ok: false,
        rolledBack: false,
        error: `Применение прервано (${outcome.reason}), и откатить удалось не всё: ${outcome.unrestored.join(', ')}. Прежние версии файлов оставлены в ${STAGING_DIR}/backup/ — верните их вручную, затем удалите ${STAGING_DIR}.`,
      });
    }
    return result(plan, { ok: false, rolledBack: true, error: `Применение прервано и откачено: ${outcome.reason}` });
  }
  return result(plan, {
    ok: true,
    applied: true,
    createdFiles: writes.filter((write) => write.action === 'create').map((write) => write.path),
    updatedFiles: writes.filter((write) => write.action === 'update').map((write) => write.path),
    removedFiles: writes.filter((write) => write.action === 'remove').map((write) => write.path),
  });
}
