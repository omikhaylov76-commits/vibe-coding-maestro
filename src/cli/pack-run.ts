import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultArchiveName, packProject } from '../core/pack.js';
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
}

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
  const out = options.out === undefined ? await defaultOut(options.path, options.tag) : resolve(options.out);
  const result = await packProject({ root: options.path, tag: options.tag, out, allow: options.allow ?? [] });
  if (options.json) {
    io.out(JSON.stringify({ reportVersion: 1, ...result }, null, 2));
    return result.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!result.ok) {
    io.err('Vibe Coding Maestro pack: архив не создан.');
    for (const item of result.findings) io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    return EXIT_FAILED;
  }
  io.out(result.reused === true
    ? `Архив тега ${result.tag} уже лежит здесь и совпадает побайтово: ${result.archive}`
    : `Архив тега ${result.tag} готов: ${result.archive}`);
  io.out(`Файлов: ${result.files}, размер: ${result.bytes} байт, sha256: ${result.sha256}`);
  io.out('Не вошли: wiki/, maestro/, .claude/, protocols/, .maestro/, CLAUDE.md, AGENTS.md, .mcp.json. В корне архива — HANDOVER.md: первым делом заказчик меняет все пароли и ключи.');
  for (const note of result.notes ?? []) io.out(note);
  if ((options.allow ?? []).length > 0) io.out(`Без проверки на секреты по решению человека: ${(options.allow ?? []).join(', ')}.`);
  io.out('Перед отправкой откройте архив и проверьте HANDOVER.md. Отправка заказчику — только после «да» человека.');
  return EXIT_OK;
}
