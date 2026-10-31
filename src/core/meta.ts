import { readPackageJson } from './paths.js';

export const PRODUCT_NAME = 'Vibe Coding Maestro';
export const CREATE_COMMAND = 'create-vibe-maestro';
export const SERVICE_COMMAND = 'vibe-maestro';

/**
 * Готовая к копированию команда служебного CLI. Пакет и bin называются по-разному,
 * поэтому `npx` нужен `--package`: голого `vibe-maestro` нет в PATH, и агент,
 * который сам допишет к нему npx, скачает пакет с именем bin, а не этот.
 * `version` фиксирует точную версию там, где важно повторить ту же проверку.
 */
export function serviceInvocation(version = 'latest'): string {
  return `npx --package ${CREATE_COMMAND}@${version} ${SERVICE_COMMAND}`;
}

/** Путь для подсказки: с пробелом — в кавычках, чтобы команду можно было скопировать целиком. */
export function quotePathArg(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}
export const MANIFEST_SCHEMA_VERSION = 2;

export const VERSION: string = readPackageJson().version;

/** Допустимые исходные состояния идеи (третий вопрос интерактивного меню). */
export const STARTING_POINTS = ['idea', 'materials', 'spec', 'code'] as const;
export type StartingPoint = (typeof STARTING_POINTS)[number];

export function isStartingPoint(value: string): value is StartingPoint {
  return (STARTING_POINTS as readonly string[]).includes(value);
}
