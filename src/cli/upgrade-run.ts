import { SERVICE_COMMAND } from '../core/meta.js';
import { upgradeProject } from '../core/upgrade/index.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface UpgradeRunOptions {
  path: string;
  json: boolean;
  apply?: boolean;
}

/**
 * Без `--apply` команда только показывает предложение: это dry-run по умолчанию,
 * а запись требует отдельного человеческого намерения.
 */
export async function executeUpgradeCommand(options: UpgradeRunOptions, io: CliIo): Promise<number> {
  const result = await upgradeProject(options.path, { apply: options.apply === true });
  if (options.json) {
    io.out(JSON.stringify({
      reportVersion: 1,
      ok: result.ok,
      applied: result.applied,
      rolledBack: result.rolledBack,
      ...(result.error === undefined ? {} : { error: result.error }),
      analysis: result.analysis,
    }, null, 2));
    return result.ok ? EXIT_OK : EXIT_FAILED;
  }

  const { analysis } = result;
  if (analysis.status === 'blocked' || result.ok === false) {
    io.err(`Vibe Coding Maestro upgrade: обновление не выполнено (изменений на диске нет).`);
    if (result.error !== undefined) io.err(`- ${result.error}`);
    for (const item of analysis.blockers) io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    return EXIT_FAILED;
  }
  if (analysis.status === 'current') {
    io.out(`Проект уже соответствует канону версии ${analysis.toVersion}: обновлять нечего.`);
    return EXIT_OK;
  }

  const list = (title: string, paths: readonly string[]): void => {
    if (paths.length === 0) return;
    io.out(`${title}:`);
    for (const path of paths) io.out(`  ${path}`);
  };

  if (result.applied) {
    io.out(`Обновление применено: ${analysis.baselineId} → ${analysis.toVersion}.`);
    list('Добавлено', result.createdFiles);
    list('Обновлено', result.updatedFiles);
    list('Сохранено без изменений', analysis.preserves);
    io.out(`Проверьте полный diff и запустите: ${SERVICE_COMMAND} doctor --path ${options.path} --strict`);
    return EXIT_OK;
  }

  io.out(`Предложение обновления ${analysis.baselineId} → ${analysis.toVersion} (ни один байт не записан).`);
  list('Будет добавлено', analysis.creates.map((item) => item.path));
  list('Будет обновлено', analysis.updates.map((item) => item.path));
  list('Уже совпадает', analysis.unchanged);
  list('Останется без изменений', analysis.preserves);
  list('Служебные файлы', analysis.metadata);
  io.out(`Применить: ${SERVICE_COMMAND} upgrade --path ${options.path} --apply`);
  return EXIT_OK;
}
