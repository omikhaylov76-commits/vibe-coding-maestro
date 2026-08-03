import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

interface PlatformPathDeps {
  platform?: NodeJS.Platform;
  isSymlink?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
}

/**
 * macOS exposes the platform-owned alias /var -> /private/var. Canonicalize only
 * that exact verified alias. Environment-selected TMPDIR/TEMP/TMP paths are not
 * trusted and never receive an exception from no-follow checks.
 */
export async function canonicalizeSystemTempPrefix(input: string, deps: PlatformPathDeps = {}): Promise<string> {
  const absolute = resolve(input);
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin' || (absolute !== '/var' && !absolute.startsWith(`/var${sep}`))) return absolute;

  const isSymlink = deps.isSymlink ?? (async (path: string) => (await lstat(path)).isSymbolicLink());
  const resolveRealpath = deps.realpath ?? realpath;
  try {
    if (!await isSymlink('/var')) return absolute;
    if (await resolveRealpath('/var') !== '/private/var') return absolute;
  } catch {
    return absolute;
  }
  return resolve('/private/var', absolute.slice('/var'.length).replace(/^[/\\]+/, ''));
}
