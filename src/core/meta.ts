import { readPackageJson } from './paths.js';

export const PRODUCT_NAME = 'Vibe Coding Maestro';
export const CREATE_COMMAND = 'create-vibe-maestro';
export const SERVICE_COMMAND = 'vibe-maestro';
export const MANIFEST_SCHEMA_VERSION = 2;

export const VERSION: string = readPackageJson().version;

/** Допустимые исходные состояния идеи (третий вопрос интерактивного меню). */
export const STARTING_POINTS = ['idea', 'materials', 'spec', 'code'] as const;
export type StartingPoint = (typeof STARTING_POINTS)[number];

export function isStartingPoint(value: string): value is StartingPoint {
  return (STARTING_POINTS as readonly string[]).includes(value);
}
