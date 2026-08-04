import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type ProjectInputMode = 'create' | 'check';

interface DesktopOptions {
  platform: NodeJS.Platform;
  home: string;
  readXdgConfig?: () => Promise<string>;
}

interface ProjectInputOptions extends DesktopOptions {
  mode: ProjectInputMode;
  cwd: string;
}

export interface ResolvedProjectInput {
  target: string;
  name: string;
  usedDesktopDefault: boolean;
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function classifyProjectInput(raw: string): 'name' | 'path' {
  const value = stripOuterQuotes(raw);
  if (value === '.' || value === '..' || value.startsWith('~')) return 'path';
  if (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || /^\\\\/.test(value)) return 'path';
  return 'name';
}

async function defaultXdgConfig(home: string): Promise<string> {
  const configHome = process.env.XDG_CONFIG_HOME || posix.join(home, '.config');
  return readFile(posix.join(configHome, 'user-dirs.dirs'), 'utf8');
}

export async function resolveDesktopDirectory(options: DesktopOptions): Promise<string> {
  const home = options.home.trim();
  if (!home) throw new Error('Не удалось определить домашнюю папку. Укажите полный путь проекта.');
  const paths = options.platform === 'win32' ? win32 : posix;
  if (options.platform !== 'linux') return paths.join(home, 'Desktop');

  try {
    const config = await (options.readXdgConfig ?? (() => defaultXdgConfig(home)))();
    const match = /^XDG_DESKTOP_DIR=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*$/m.exec(config);
    const raw = match?.[1] ?? match?.[2] ?? match?.[3];
    if (raw) {
      const expanded = raw.replace(/^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, home);
      if (expanded === home || expanded.startsWith(`${home}/`)) return posix.resolve(expanded);
    }
  } catch {
    // A missing or malformed XDG config uses the documented HOME/Desktop fallback.
  }
  return posix.join(home, 'Desktop');
}

export async function resolveProjectInput(raw: string, options: ProjectInputOptions): Promise<ResolvedProjectInput> {
  const value = stripOuterQuotes(raw);
  if (!value) throw new Error('Введите название проекта или путь.');
  const paths = options.platform === 'win32' ? win32 : posix;

  if (options.mode === 'create' && classifyProjectInput(value) === 'name') {
    const desktop = await resolveDesktopDirectory(options);
    return { target: paths.join(desktop, value), name: value, usedDesktopDefault: true };
  }

  const expanded = value === '~' ? options.home : value.startsWith('~/') || value.startsWith('~\\')
    ? paths.join(options.home, value.slice(2))
    : value;
  const target = paths.resolve(options.cwd, expanded);
  return { target, name: paths.basename(target), usedDesktopDefault: false };
}

export function runtimeDesktopOptions(mode: ProjectInputMode): ProjectInputOptions {
  return { mode, platform: process.platform, home: homedir(), cwd: process.cwd() };
}
