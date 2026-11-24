import { AUDITS_ARCHIVE_DIR } from '../core/archive/audits.js';
import { formatChars } from '../core/archive/limits.js';
import { archiveProject } from '../core/archive/index.js';
import { plainTitle } from '../core/archive/plan.js';
import type { ArchiveReport } from '../core/archive/index.js';
import type { TransactionHooks } from '../core/transaction.js';
import { quotePathArg, serviceInvocation, VERSION } from '../core/meta.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface ArchiveRunOptions {
  path: string;
  json: boolean;
  apply?: boolean;
  sections?: string[];
  /** Тестовый шов: см. `TransactionHooks`. */
  hooks?: TransactionHooks;
}

const DIGEST_SHOWN = 12;
/** Сколько правок плана показать: у живых планов их десятки. */
const EDITS_SHOWN = 10;
const EDIT_TITLE_CHARS = 80;

/** Без `--section`: какие правки плана можно перенести. Только подсказка: сама команда их не трогает. */
function describePlanEdits(report: ArchiveReport, path: string, io: CliIo): void {
  const edits = report.planEdits;
  if (edits === null || edits.sections.length === 0) return;
  const total = edits.sections.reduce((sum, item) => sum + item.chars, 0);
  io.out(`- Правки плана ${edits.plan}, которые можно перенести в архив: ${formatChars(edits.sections.length)}, вместе ${formatChars(total)} знаков. Сама команда их не трогает — называйте по одной через --section:`);
  const shown = [...edits.sections].sort((left, right) => right.chars - left.chars).slice(0, EDITS_SHOWN);
  for (const item of shown) {
    const title = [...item.heading].length > EDIT_TITLE_CHARS ? `${[...item.heading].slice(0, EDIT_TITLE_CHARS).join('')}…` : item.heading;
    const note = item.open ? ' — есть незакрытое, переносить рано' : item.currentSlice ? ' — упоминает текущую порцию, проверьте' : '';
    io.out(`  - «${title}»: ${formatChars(item.chars)} знаков${note}.`);
  }
  if (edits.sections.length > shown.length) {
    const rest = total - shown.reduce((sum, item) => sum + item.chars, 0);
    io.out(`  - и ещё ${formatChars(edits.sections.length - shown.length)} поменьше, вместе ${formatChars(rest)} знаков.`);
  }
  io.out(`  Переносите только правки, все порции которых закрыты: ${serviceInvocation(VERSION)} archive --path ${quotePathArg(path)} --section "начало заголовка". Отпечаток плана перезапишется сам.`);
  if (!edits.intact) io.out('  Сейчас перенос остановит archive-plan-changed: текст плана изменился после утверждения. Сначала покажите изменения человеку и запишите новый отпечаток.');
}

function describe(report: ArchiveReport, path: string, io: CliIo): void {
  const { log, audits } = report;
  if (log !== null) {
    const months = log.months.map((month) => `${month.path} (${month.entries})`).join(', ');
    io.out(`- Журнал wiki/log.md: ${formatChars(log.chars)} знаков при пороге ${formatChars(log.limit)} — записей в архив: ${log.movedEntries} → ${months}; в wiki/log.md остаются последние ${log.keptEntries} (до ${formatChars(log.keep)} знаков).`);
  }
  if (audits.moved.length > 0) io.out(`- Закрытые отчёты проверок: ${audits.moved.length} → ${AUDITS_ARCHIVE_DIR}/.`);
  for (const section of report.sections) {
    if (section.status === 'already') { io.out(`- Раздел «${section.heading}» уже в архиве.`); continue; }
    io.out(`- Раздел плана «${section.heading}»: ${formatChars(section.chars)} знаков → ${report.planArchive}; в плане остаются заголовок и строка со ссылкой.`);
    for (const nested of section.nested) io.out(`  - внутри «${nested.heading}»: ${formatChars(nested.chars)} знаков.`);
    for (const warning of section.warnings) io.out(`  - Проверьте: ${warning}`);
  }
  if (report.logNote !== null) io.out(`- ${report.logNote}`);
  for (const digest of report.digests) io.out(`- Отпечаток ${digest.plan}: ${digest.before.slice(0, DIGEST_SHOWN)}… → ${digest.after.slice(0, DIGEST_SHOWN)}…; оба записаны в архиве плана.`);
  if (report.relinked.length > 0) io.out(`- Адреса ссылок поправлены в файлах: ${report.relinked.length}.`);
  for (const item of audits.kept) io.out(`- Остаётся ${item.path}: ${item.reason}`);
  describePlanEdits(report, path, io);
}

/**
 * Без `--apply` команда только показывает, что перенесёт: ни байта не пишет.
 * Перенос — внутри проекта, ничего не удаляется.
 */
export async function executeArchiveCommand(options: ArchiveRunOptions, io: CliIo): Promise<number> {
  const report = await archiveProject(options.path, {
    apply: options.apply === true,
    ...(options.sections === undefined ? {} : { sections: options.sections }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!report.ok) {
    io.err(report.partial ? 'Vibe Coding Maestro archive: перенос прерван, и откатить удалось не всё: проект изменён частично.' : 'Vibe Coding Maestro archive: перенос не выполнен (изменений на диске нет).');
    if (report.error !== undefined) io.err(`- ${report.error}`);
    for (const item of report.blockers) io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    return EXIT_FAILED;
  }
  if (report.writes.length === 0) {
    const reasons = [report.logNote === null ? 'журнал не больше порога' : null, report.audits.kept.length === 0 ? 'закрытых отчётов нет' : null].filter((reason) => reason !== null);
    io.out(`Переносить в архив нечего${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}.`);
    describe(report, options.path, io);
    return EXIT_OK;
  }
  if (report.applied) {
    io.out('Vibe Coding Maestro archive: перенесено в архив.');
    describe(report, options.path, io);
    io.out('Ничего не удалено: перенесённый текст — в файлах архива. Проект в git — закоммитьте изменения.');
    return EXIT_OK;
  }
  io.out('Vibe Coding Maestro archive: будет перенесено в архив (пробный запуск, ни байта не записано).');
  describe(report, options.path, io);
  const named = (options.sections ?? []).map((section) => ` --section "${plainTitle(section)}"`).join('');
  io.out(`Перенести: ${serviceInvocation(VERSION)} archive --path ${quotePathArg(options.path)}${named} --apply`);
  return EXIT_OK;
}
