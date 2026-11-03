import { countChars, formatChars, HANDOFF_LIMIT, HOT_LIMIT, LOG_LIMIT, PLAN_LIMIT } from '../archive/limits.js';
import { quotePathArg, serviceInvocation, VERSION } from '../meta.js';
import { ACTIVE_PLAN_NONE, isCalendarDate, isWikiRelativePlanRef } from '../plan.js';
import { HOT_PATH } from './plans.js';
import { frontmatter } from './text.js';
import { info } from './types.js';
import type { DoctorFinding } from './types.js';

const LOG_FILE = 'wiki/log.md';
/** Передача — плоская папка, имя `ГГГГ-ММ-ДД-….md`; прочие имена не проверяются. */
const HANDOFF_RE = /^wiki\/handoffs\/(\d{4}-\d{2}-\d{2})-[^/]+\.md$/;

/** Передачи с самой поздней датой в имени: с них начнёт следующая сессия. */
function latestHandoffs(decoded: ReadonlyMap<string, string>): string[] {
  const dated = [...decoded.keys()].flatMap((path) => {
    const date = HANDOFF_RE.exec(path)?.[1];
    return date !== undefined && isCalendarDate(date) ? [{ path, date }] : [];
  });
  const latest = dated.reduce((max, item) => (item.date > max ? item.date : max), '');
  return dated.filter((item) => item.date === latest).map((item) => item.path).sort();
}

/**
 * Длина того, что читает начало сессии. Только `info`: пороги — гипотеза
 * (`archive/limits.ts`), и блокировать работу по гипотезе нельзя.
 */
export function checkMemory(rootInput: string, decoded: ReadonlyMap<string, string>, findings: DoctorFinding[]): void {
  const archive = `${serviceInvocation(VERSION)} archive --path ${quotePathArg(rootInput)}`;
  const over = (path: string, limit: number): number | null => {
    const text = decoded.get(path);
    if (text === undefined) return null;
    const chars = countChars(text);
    return chars > limit ? chars : null;
  };
  const size = (chars: number, limit: number): string => `${formatChars(chars)} знаков при ориентире ${formatChars(limit)}`;

  const hot = over(HOT_PATH, HOT_LIMIT);
  if (hot !== null) findings.push(info('memory-hot-long', `Горячий контекст длинный: ${size(hot, HOT_LIMIT)} (около 60 строк). При передаче перепишите его коротко, справочное вынесите в отдельные файлы.`, HOT_PATH));

  const hotText = decoded.get(HOT_PATH);
  const declared = (hotText === undefined ? null : frontmatter(hotText))?.active_plan ?? ACTIVE_PLAN_NONE;
  if (declared !== ACTIVE_PLAN_NONE && isWikiRelativePlanRef(declared)) {
    const path = `wiki/${declared}`;
    const plan = over(path, PLAN_LIMIT);
    if (plan !== null) findings.push(info('memory-plan-long', `Активный план длинный: ${size(plan, PLAN_LIMIT)}. Закрытые правки уберите в архив: \`${archive} --section "<начало заголовка>"\` (без --apply только показывает перенос).`, path));
  }

  const log = over(LOG_FILE, LOG_LIMIT);
  if (log !== null) findings.push(info('memory-log-long', `Журнал длинный: ${size(log, LOG_LIMIT)}. Старые записи уберите в архив: \`${archive}\` (без --apply только показывает перенос).`, LOG_FILE));

  for (const path of latestHandoffs(decoded)) {
    const handoff = over(path, HANDOFF_LIMIT);
    if (handoff !== null) findings.push(info('memory-handoff-long', `Последняя передача длинная: ${size(handoff, HANDOFF_LIMIT)}. Следующую пишите короче, подробности — ссылками; старые передачи — история, их не сокращают.`, path));
  }
}
