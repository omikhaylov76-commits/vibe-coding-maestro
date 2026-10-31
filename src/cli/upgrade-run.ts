import { quotePathArg, serviceInvocation, VERSION } from '../core/meta.js';
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
    io.out(`Обновление применено: ${analysis.fromVersion ?? analysis.baselineId} → ${analysis.toVersion}.`);
    list('Добавлено', result.createdFiles);
    list('Обновлено', result.updatedFiles);
    list('Передано проекту (дальше файл ваш, Maestro его не проверяет и не перезаписывает)', analysis.handedOver);
    const keptAsIs = analysis.handedOver.filter((path) => !result.updatedFiles.includes(path));
    if (keptAsIs.length > 0) io.out(`Вы меняли эти файлы, поэтому они переданы как есть: ${keptAsIs.join(', ')}. Если в них осталась команда Maestro старой версии, обновите её — актуальная лежит в .claude/rules/maestro.md (doctor напомнит).`);
    list('Сохранено без изменений', analysis.preserves);
    // До коммита doctor честно покажет git-managed-dirty: сначала diff и коммит, потом проверка.
    io.out('Добавьте в Git все изменения, включая новые файлы (git add -A), просмотрите их (git diff --cached) и закоммитьте: до коммита doctor покажет git-managed-dirty и git-managed-untracked.');
    // Та же версия, что применила обновление: doctor проверяет ровно её канон.
    io.out(`Затем проверьте: ${serviceInvocation(VERSION)} doctor --path ${quotePathArg(options.path)} --strict`);
    return EXIT_OK;
  }

  io.out(`Предложение обновления ${analysis.fromVersion ?? analysis.baselineId} → ${analysis.toVersion} (ни один байт не записан).`);
  list('Будет добавлено', analysis.creates.map((item) => item.path));
  list('Будет обновлено', analysis.updates.map((item) => item.path));
  list('Перейдёт к проекту (дальше файл ваш, Maestro его не проверяет и не перезаписывает)', analysis.handedOver);
  list('Уже совпадает', analysis.unchanged);
  list('Останется без изменений', analysis.preserves);
  list('Служебные файлы', analysis.metadata);
  // Применять обязана та же версия, что показала это предложение, а не новая @latest.
  io.out(`Применить: ${serviceInvocation(VERSION)} upgrade --path ${quotePathArg(options.path)} --apply`);
  return EXIT_OK;
}
