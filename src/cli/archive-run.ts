import { formatChars } from '../core/archive/limits.js';
import { archiveProject } from '../core/archive/index.js';
import type { ArchiveReport } from '../core/archive/index.js';
import { quotePathArg, serviceInvocation, VERSION } from '../core/meta.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface ArchiveRunOptions {
  path: string;
  json: boolean;
  apply?: boolean;
}

function describe(report: ArchiveReport, io: CliIo): void {
  const { log } = report;
  if (log !== null) {
    const months = log.months.map((month) => `${month.path} (${month.entries})`).join(', ');
    io.out(`- Журнал wiki/log.md: ${formatChars(log.chars)} знаков при пороге ${formatChars(log.limit)} — записей в архив: ${log.movedEntries} → ${months}; в wiki/log.md остаются последние ${log.keptEntries} (до ${formatChars(log.keep)} знаков).`);
  }
}

/**
 * Без `--apply` команда только показывает, что перенесёт: ни байта не пишет.
 * Перенос — внутри проекта, ничего не удаляется.
 */
export async function executeArchiveCommand(options: ArchiveRunOptions, io: CliIo): Promise<number> {
  const report = await archiveProject(options.path, { apply: options.apply === true });
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!report.ok) {
    io.err('Vibe Coding Maestro archive: перенос не выполнен (изменений на диске нет).');
    if (report.error !== undefined) io.err(`- ${report.error}`);
    for (const item of report.blockers) io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    return EXIT_FAILED;
  }
  if (report.writes.length === 0) {
    io.out('Переносить в архив нечего: журнал не больше порога.');
    return EXIT_OK;
  }
  if (report.applied) {
    io.out('Vibe Coding Maestro archive: перенесено в архив.');
    describe(report, io);
    io.out('Ничего не удалено: перенесённый текст — в файлах архива, прежний вид — в истории git. Закоммитьте изменения.');
    return EXIT_OK;
  }
  io.out('Vibe Coding Maestro archive: будет перенесено в архив (пробный запуск, ни байта не записано).');
  describe(report, io);
  io.out(`Перенести: ${serviceInvocation(VERSION)} archive --path ${quotePathArg(options.path)} --apply`);
  return EXIT_OK;
}
