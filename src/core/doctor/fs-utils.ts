import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';

/** Проверяет каждый существующий компонент абсолютного пути на symlink. */
export async function absolutePathHasSymlink(absolutePath: string): Promise<boolean> {
  const absolute = resolve(absolutePath);
  const fsRoot = parse(absolute).root;
  let current = fsRoot;
  for (const part of absolute.slice(fsRoot.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw cause;
    }
  }
  return false;
}

/** Проверяет относительный путь внутри проекта покомпонентно; отсутствующий путь не symlink. */
export async function pathHasSymlink(root: string, relativePath: string): Promise<boolean> {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw cause;
    }
  }
  return false;
}

/** Рекурсивный список *.md, отсортированный, для стабильного порядка находок. */
export async function markdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out.sort();
}
