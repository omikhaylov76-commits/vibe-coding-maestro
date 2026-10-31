import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

/**
 * Имя папки так, как оно записано на диске. На файловых системах без учёта
 * регистра (macOS, Windows) `cd myproject` даёт путь в другом регистре, чем имя
 * папки, и сравнение с manifest по набранной строке ошибалось бы. Symlink в пути
 * проверяется до этого вызова, поэтому realpath здесь меняет только регистр.
 */
export function onDiskBasename(absolute: string): string {
  try {
    return basename(realpathSync.native(absolute));
  } catch {
    return basename(absolute);
  }
}

interface PlatformPathDeps {
  isSymlink?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
}

/** Pure policy over an already absolute POSIX-style macOS path. */
export async function canonicalizeVerifiedMacVarAlias(
  absolute: string,
  platform: NodeJS.Platform,
  deps: PlatformPathDeps = {},
): Promise<string> {
  if (platform !== 'darwin' || (absolute !== '/var' && !absolute.startsWith('/var/'))) return absolute;

  const isSymlink = deps.isSymlink ?? (async (path: string) => (await lstat(path)).isSymbolicLink());
  const resolveRealpath = deps.realpath ?? realpath;
  try {
    if (!await isSymlink('/var')) return absolute;
    if (await resolveRealpath('/var') !== '/private/var') return absolute;
  } catch {
    return absolute;
  }
  const suffix = absolute.slice('/var'.length).replace(/^\/+/, '');
  return suffix === '' ? '/private/var' : `/private/var/${suffix}`;
}

/**
 * macOS exposes the platform-owned alias /var -> /private/var. Canonicalize only
 * that exact verified alias. Environment-selected TMPDIR/TEMP/TMP paths are not
 * trusted and never receive an exception from no-follow checks.
 */
export async function canonicalizeSystemTempPrefix(input: string): Promise<string> {
  const absolute = resolve(input);
  return canonicalizeVerifiedMacVarAlias(absolute, process.platform);
}
