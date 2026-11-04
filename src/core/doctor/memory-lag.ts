import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HANDOFF_COMMITS_LIMIT, HOT_BEHIND_COMMITS } from '../archive/limits.js';
import { withoutBom } from '../archive/markdown.js';
import { declaredPlan, mentionsSlice } from '../archive/plan.js';
import { MANIFEST_PATH } from '../manifest.js';
import { ACTIVE_PLAN_NONE, isWikiRelativePlanRef, PLAN_NULL } from '../plan.js';
import { gitAnswer, parsePorcelainV1Z } from './git.js';
import { HOT_PATH } from './plans.js';
import { frontmatter } from './text.js';
import { info } from './types.js';
import type { DoctorFinding } from './types.js';

const execFileAsync = promisify(execFile);

/** `glob`: передача — плоская папка, вложенные файлы передачами не считаются. */
const HANDOFFS = ':(glob)wiki/handoffs/*.md';
const CHECK_LOG = 'Если работа идёт не в этой сессии — сверь `git log` и запиши передачу.';

/** Коммит, добавивший файл: передача считается добавленной один раз, поправленная ссылка в ней счёт не сбрасывает. */
const lastAdded = (root: string, path: string): Promise<string | null> => gitAnswer(root, ['log', '-1', '--diff-filter=A', '--format=%H', '--', path]);

/** Передача ещё не закоммичена и свежее последнего коммита: на шаге передачи doctor идёт до коммита. */
async function handoffInProgress(root: string): Promise<boolean> {
  const committed = Number(await gitAnswer(root, ['log', '-1', '--format=%ct']));
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', HANDOFFS], { cwd: root, encoding: 'utf8' });
    for (const entry of parsePorcelainV1Z(stdout)) {
      if (entry.status !== '??' && !entry.status.includes('A')) continue;
      if ((await stat(join(root, entry.path))).mtimeMs >= committed * 1000) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Текущая порция активного плана; null — порции нет. */
function currentSlice(wiki: ReadonlyMap<string, string>): string | null {
  const declared = declaredPlan(wiki);
  if (declared === ACTIVE_PLAN_NONE || !isWikiRelativePlanRef(declared)) return null;
  const plan = wiki.get(`wiki/${declared}`);
  const slice = plan === undefined ? undefined : frontmatter(withoutBom(plan))?.current_slice;
  return slice === undefined || slice === PLAN_NULL || slice === '' ? null : slice;
}

/**
 * Отстала ли память от кода: только с доказательством из git. Опора — последняя
 * добавленная передача, а пока передач нет — коммит с manifest, чтобы история до
 * Maestro не считалась. Нет `.git`, нет опоры, мелкий клон, отказ git — молчит.
 * Только `info`: посреди обычной порции это тоже срабатывает, а пороги — гипотеза.
 */
export async function checkMemoryLag(root: string, wiki: ReadonlyMap<string, string>, findings: DoctorFinding[]): Promise<void> {
  if (!existsSync(join(root, '.git'))) return;
  // В мелком клоне самый ранний коммит «добавляет» всё сразу: опора была бы ложной.
  if (await gitAnswer(root, ['rev-parse', '--is-shallow-repository']) !== 'false') return;
  const handoff = await lastAdded(root, HANDOFFS);
  const anchor = handoff === '' ? await lastAdded(root, MANIFEST_PATH) : handoff;
  if (anchor === null || anchor === '') return;
  const answer = await gitAnswer(root, ['rev-list', '--count', `${anchor}..HEAD`, '--', '.', ':(exclude)wiki']);
  const commits = answer === null ? Number.NaN : Number(answer);
  if (!Number.isInteger(commits) || commits < HOT_BEHIND_COMMITS) return;
  if (await handoffInProgress(root)) return;

  const counted = handoff === '' ? `передач ещё не было, а коммитов кода с подключения Maestro: ${commits}` : `после последней передачи коммитов кода: ${commits}`;
  const slice = currentSlice(wiki);
  if (slice !== null && !mentionsSlice(wiki.get(HOT_PATH) ?? '', slice)) {
    findings.push(info('memory-hot-behind', `wiki/hot.md не называет текущую порцию ${slice}, ${counted}. ${CHECK_LOG}`, HOT_PATH));
  }
  if (commits >= HANDOFF_COMMITS_LIMIT) {
    findings.push(info('memory-handoff-behind', `Отстала передача: ${counted} при ориентире ${HANDOFF_COMMITS_LIMIT}. ${CHECK_LOG}`));
  }
}
