import { analyzeSources, DEFAULT_OUTPUT_PATH, writeSourceInventory } from '../core/sources/index.js';
import type { SourceInventoryReport, SourceRecord, WriteResult } from '../core/sources/index.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface SourcesRunOptions {
  path: string;
  json: boolean;
  sources: readonly string[];
  write?: boolean;
  replace?: boolean;
  output?: string;
  /** Часы вводятся снаружи, чтобы артефакт был воспроизводим в тестах. */
  now?: () => string;
}

function describe(record: SourceRecord): string {
  if (record.duplicateOf !== null) return `- ${record.id}: тот же каталог, что и ${record.duplicateOf}`;
  if (!record.readable) return `- ${record.id}: ${record.type} — не прочитан`;
  const git = record.git?.isRepo === true
    ? `git ${record.git.branch ?? 'HEAD'}@${record.git.head?.slice(0, 7) ?? '—'}${record.git.dirty === true ? ' (грязный)' : ''}`
    : 'без git';
  const ecosystems = record.ecosystems.length > 0 ? record.ecosystems.map((item) => item.id).join(', ') : 'экосистема неизвестна';
  const detected = record.capabilities.filter((item) => item.state === 'DETECTED').map((item) => item.id);
  return `- ${record.id} (${record.origin.descriptor}): ${ecosystems}; ${git}; способности: ${detected.length > 0 ? detected.join(', ') : 'UNKNOWN'}`;
}

/**
 * Инвентаризация существующих исходников.
 *
 * По умолчанию команда только читает: ни источник, ни проект не изменяются.
 * Запись снимка включается явным `--write` и остаётся отдельным решением человека.
 */
export async function executeSourcesCommand(options: SourcesRunOptions, io: CliIo): Promise<number> {
  const report: SourceInventoryReport = await analyzeSources({ projectPath: options.path, sources: options.sources });

  let write: WriteResult | null = null;
  if (options.write === true) {
    write = await writeSourceInventory(report, {
      projectPath: options.path,
      generatedAt: (options.now ?? (() => new Date().toISOString()))(),
      ...(options.output === undefined ? {} : { output: options.output }),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    });
  }
  const ok = report.ok && (write === null || write.ok);

  if (options.json) {
    io.out(JSON.stringify({ ...report, write }, null, 2));
    return ok ? EXIT_OK : EXIT_FAILED;
  }

  const line = (text: string): void => { if (ok) io.out(text); else io.err(text); };
  io.out(`Инвентаризация источников: ${report.sources.length}; ownership ${report.ownership}.`);
  for (const record of report.sources) io.out(describe(record));

  const matrix = report.integration;
  if (matrix.sources.length > 0) {
    io.out(`Матрица интеграции: общие экосистемы ${matrix.commonEcosystems.join(', ') || 'нет'}; коллизий ${matrix.collisions.length}; швов ${matrix.seams.length}.`);
    io.out(`Рекомендация (${matrix.recommendation.kind}): ${matrix.recommendation.action}, уверенность ${matrix.recommendation.confidence}. Решение принимает человек.`);
  }
  for (const item of [...report.findings, ...(write?.findings ?? [])]) {
    line(`${item.level === 'error' ? '!' : '-'} ${item.code}${item.source ? ` (${item.source})` : ''}: ${item.message}`);
  }

  if (write === null) {
    io.out(`Ничего не записано: снимок существует только в этом выводе. Для сохранения добавьте --write (по умолчанию ${DEFAULT_OUTPUT_PATH}).`);
  } else if (write.ok) {
    io.out(`Записано: ${write.path}${write.replaced ? ' (замена прежнего снимка)' : ''}.`);
  } else {
    line('Запись не выполнена: проект и источники остались без изменений.');
  }
  return ok ? EXIT_OK : EXIT_FAILED;
}
