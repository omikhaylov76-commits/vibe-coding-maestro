import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { quotePathArg, serviceInvocation, VERSION } from '../core/meta.js';
import { defaultArchiveName, packProject } from '../core/pack.js';
import type { PackHighlight } from '../core/pack.js';
import { resolveDesktopDirectory } from './desktop.js';
import { homedir } from 'node:os';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface PackRunOptions {
  path: string;
  json: boolean;
  tag: string;
  out?: string;
  allow?: string[];
  dryRun?: boolean;
}

/** `--out dist/` или `--out dist\` — папка: архив ложится в неё под именем по умолчанию, папка создаётся. */
function outPath(out: string, root: string, tag: string): string {
  if (!/[\\/]$/.test(out)) return resolve(out);
  return join(resolve(out.replace(/[\\/]+$/, '') || out), defaultArchiveName(root, tag));
}

/** Строка подсветки: путь, что найдено и где. */
const highlightLine = (item: PackHighlight): string => `${item.path} — ${item.reason}${item.line === undefined ? '' : ` (строка ${item.line})`}`;

/** Архив по умолчанию кладётся на Рабочий стол: его оттуда отправляют заказчику. Нет Рабочего стола — рядом с проектом. */
async function defaultOut(root: string, tag: string): Promise<string> {
  const name = defaultArchiveName(root, tag);
  try {
    const desktop = await resolveDesktopDirectory({ platform: process.platform, home: homedir() });
    if (existsSync(desktop)) return join(desktop, name);
  } catch {
    // без домашней папки — рядом с проектом
  }
  return join(dirname(resolve(root)), name);
}

export async function executePackCommand(options: PackRunOptions, io: CliIo): Promise<number> {
  const out = options.out === undefined ? await defaultOut(options.path, options.tag) : outPath(options.out, options.path, options.tag);
  const result = await packProject({ root: options.path, tag: options.tag, out, allow: options.allow ?? [], dryRun: options.dryRun === true });
  if (options.json) {
    io.out(JSON.stringify({ reportVersion: 1, ...result }, null, 2));
    return result.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!result.ok) {
    io.err('Vibe Coding Maestro pack: архив не создан.');
    for (const item of result.findings) io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    return EXIT_FAILED;
  }
  const highlights = result.highlights ?? [];
  if (result.dryRun === true) {
    const marks = new Map<string, string[]>();
    for (const item of highlights) marks.set(item.path, [...(marks.get(item.path) ?? []), `${item.reason}${item.line === undefined ? '' : ` (строка ${item.line})`}`]);
    io.out(result.untagged === true
      ? `Метки ${result.tag} ещё нет: показан состав последнего коммита (${(result.commit ?? '').slice(0, 7)}), ничего не записано; файлов — ${result.files}. Метку ставят на этот коммит — архив будет таким же; незакоммиченное в архив не попадёт.`
      : `Состав архива тега ${result.tag} (ничего не записано): файлов — ${result.files}.`);
    for (const path of result.entries ?? []) io.out(`  ${path}${marks.has(path) ? `  ← ${(marks.get(path) ?? []).join('; ')}` : ''}`);
    for (const note of result.notes ?? []) io.out(note);
    io.out(highlights.length === 0
      ? 'Подсвечивать нечего.'
      : `Подсвечено — ${highlights.length}: проверьте и уберите внутреннее до упаковки (правка, коммит, новый тег). Подсветка — предупреждение, упаковку она не запрещает.`);
    io.out(result.noAccess === true
      ? 'HANDOVER.md: доступов не было — в паспорте все разделы о доступах «не применимо», менять заказчику нечего.'
      : 'HANDOVER.md: первым делом заказчик меняет все пароли и ключи — в разделах паспорта о доступах есть записи. «Доступов не было» пишется, только если в каждом из них ровно «не применимо», без пояснений.');
    io.out(`Упаковать: ${serviceInvocation(VERSION)} pack --path ${quotePathArg(options.path)} --tag ${options.tag}${options.out === undefined ? '' : ` --out ${quotePathArg(options.out)}`} — только после «да» человека.`);
    return EXIT_OK;
  }
  io.out(result.reused === true
    ? `Архив тега ${result.tag} уже лежит здесь и совпадает побайтово: ${result.archive}`
    : `Архив тега ${result.tag} готов: ${result.archive}`);
  io.out(`Файлов: ${result.files}, размер: ${result.bytes} байт, sha256: ${result.sha256}`);
  io.out(`Не вошли: wiki/, maestro/, .claude/, protocols/, .maestro/, CLAUDE.md, AGENTS.md, .mcp.json. В корне архива — HANDOVER.md: ${result.noAccess === true ? 'доступов не было, менять заказчику нечего' : 'первым делом заказчик меняет все пароли и ключи'}.`);
  if (highlights.length > 0) {
    io.out(`Подсвечено — проверьте перед отправкой (предупреждение, не отказ):`);
    for (const item of highlights) io.out(`  ${highlightLine(item)}`);
  }
  for (const note of result.notes ?? []) io.out(note);
  if ((options.allow ?? []).length > 0) io.out(`Без проверки на секреты по решению человека: ${(options.allow ?? []).join(', ')}.`);
  io.out('Перед отправкой откройте архив и проверьте HANDOVER.md. Отправка заказчику — только после «да» человека.');
  return EXIT_OK;
}
