import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * macOS exposes its system temp root through /var -> /private/var.
 * Canonicalize only that trusted OS-provided prefix; user path components below
 * it remain lexical and are still checked for symlinks by init/doctor.
 */
export async function canonicalizeSystemTempPrefix(input: string): Promise<string> {
  const absolute = resolve(input);
  const temp = resolve(tmpdir());
  const suffix = relative(temp, absolute);
  if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))) {
    const canonicalTemp = await realpath(temp).catch(() => temp);
    return resolve(canonicalTemp, suffix);
  }
  return absolute;
}
