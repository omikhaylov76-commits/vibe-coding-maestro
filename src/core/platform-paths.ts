import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

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
