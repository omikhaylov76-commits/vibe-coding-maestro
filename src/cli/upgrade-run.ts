import { quotePathArg, serviceInvocation, VERSION } from '../core/meta.js';
import { formatHunk } from '../core/text-diff.js';
import type { TextDiff } from '../core/text-diff.js';
import { upgradeDiffs, upgradeProject } from '../core/upgrade/index.js';
import type { UpgradeFileDiff } from '../core/upgrade/index.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface UpgradeRunOptions {
  path: string;
  json: boolean;
  apply?: boolean;
  diff?: boolean;
}

/** Сколько строк добавится и уберётся: «строк: +12 -5». */
function lineCounts({ added, removed }: TextDiff): string {
  const parts = [...(added > 0 ? [`+${added}`] : []), ...(removed > 0 ? [`-${removed}`] : [])];
  return parts.length === 0 ? '' : ` (строк: ${parts.join(' ')})`;
}

const DIFF_TITLES: Record<UpgradeFileDiff['action'], string> = {
  create: 'Будет добавлено',
  update: 'Будет обновлено',
  remove: 'Будет удалено',
};

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
    list('Удалено (файлы Maestro, которых больше нет в составе; прежний текст — в истории Git)', result.removedFiles);
    list('Передано проекту (дальше файл ваш, Maestro его не проверяет и не перезаписывает)', analysis.handedOver);
    const keptAsIs = analysis.handedOver.filter((path) => !result.updatedFiles.includes(path));
    if (keptAsIs.length > 0) io.out(`Вы меняли эти файлы, поэтому они переданы как есть: ${keptAsIs.join(', ')}. Если в них осталась команда Maestro старой версии, обновите её — актуальная лежит в .claude/rules/maestro.md (doctor напомнит).`);
    list('Сохранено без изменений', analysis.preserves);
    for (const note of analysis.notes) io.out(`Важно: ${note}`);
    // До коммита doctor честно покажет git-managed-dirty: сначала diff и коммит, потом проверка.
    io.out('Добавьте в Git все изменения, включая новые и удалённые файлы (git add -A), просмотрите их (git diff --cached) и закоммитьте: до коммита doctor покажет git-managed-dirty и git-managed-untracked.');
    // Та же версия, что применила обновление: doctor проверяет ровно её канон.
    io.out(`Затем проверьте: ${serviceInvocation(VERSION)} doctor --path ${quotePathArg(options.path)} --strict`);
    return EXIT_OK;
  }

  const diffs = await upgradeDiffs(result.plan);
  const counted = new Map(diffs.map((item) => [item.path, lineCounts(item.diff)]));
  const apply = `Применить: ${serviceInvocation(VERSION)} upgrade --path ${quotePathArg(options.path)} --apply`;

  if (options.diff === true) {
    io.out(`Предложение обновления ${analysis.fromVersion ?? analysis.baselineId} → ${analysis.toVersion} (ни один байт не записан). Правки построчно: «+» — строка добавится, «-» — уберётся.`);
    for (const item of diffs) {
      io.out('');
      io.out(`=== ${DIFF_TITLES[item.action]}: ${item.path}${counted.get(item.path) ?? ''}`);
      for (const hunk of item.diff.hunks) for (const line of formatHunk(hunk)) io.out(line);
    }
    io.out('');
    list('Перейдёт к проекту (дальше файл ваш, Maestro его не проверяет и не перезаписывает)', analysis.handedOver);
    list('Служебные файлы (пересчитываются)', analysis.metadata);
    for (const note of analysis.notes) io.out(`Важно: ${note}`);
    io.out(apply);
    return EXIT_OK;
  }

  io.out(`Предложение обновления ${analysis.fromVersion ?? analysis.baselineId} → ${analysis.toVersion} (ни один байт не записан).`);
  list('Будет добавлено', analysis.creates.map((item) => `${item.path}${counted.get(item.path) ?? ''}`));
  list('Будет обновлено', analysis.updates.map((item) => item.appends === undefined
    ? `${item.path}${counted.get(item.path) ?? ''}`
    : `${item.path} — допишет строки: ${item.appends.join(', ')}`));
  list('Будет удалено (файлы Maestro без ваших правок, которых больше нет в составе)', analysis.removes.map((path) => `${path}${counted.get(path) ?? ''}`));
  list('Перейдёт к проекту (дальше файл ваш, Maestro его не проверяет и не перезаписывает)', analysis.handedOver);
  list('Уже совпадает', analysis.unchanged);
  list('Останется без изменений', analysis.preserves);
  list('Служебные файлы', analysis.metadata);
  for (const note of analysis.notes) io.out(`Важно: ${note}`);
  io.out(`Сами правки построчно: ${serviceInvocation(VERSION)} upgrade --path ${quotePathArg(options.path)} --diff (полный показ — сотни строк).`);
  // Применять обязана та же версия, что показала это предложение, а не новая @latest.
  io.out(apply);
  return EXIT_OK;
}
