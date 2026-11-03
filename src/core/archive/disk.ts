import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { LinkLocator } from './links.js';

/**
 * Что о файлах проекта говорит файловая система. Строками сравнивать нельзя: на
 * macOS и Windows `Report.md` и `report.md` — один файл, и doctor спрашивает её же.
 */
export interface ProjectDisk {
  exists(path: string): boolean;
  locate: LinkLocator;
}

function identity(absolute: string): string | null {
  try {
    const stats = statSync(absolute, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

/** Номер файла верен не на любом диске, поэтому тот же файл — это ещё и то же имя с точностью до регистра и формы букв. */
const sameName = (left: string, right: string): boolean => basename(left).normalize('NFC').toLowerCase() === basename(right).normalize('NFC').toLowerCase();

/** `tracked` — файлы, которые адрес должен находить под их настоящим именем, как бы он ни был записан. */
export function projectDisk(root: string, tracked: readonly string[]): ProjectDisk {
  const known = new Map<string, string>();
  for (const path of tracked) {
    const id = identity(join(root, path));
    if (id !== null) known.set(id, path);
  }
  const located = new Map<string, string | undefined>();
  return {
    exists: (path) => existsSync(join(root, path)),
    locate: (from, decoded) => {
      const absolute = resolve(root, dirname(from), decoded);
      if (located.has(absolute)) return located.get(absolute);
      const id = identity(absolute);
      const inside = relative(root, absolute);
      const outside = inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside);
      const same = id === null ? undefined : known.get(id);
      const path = (same !== undefined && sameName(same, absolute) ? same : undefined) ?? (outside ? undefined : inside.split(sep).join('/'));
      located.set(absolute, path);
      return path;
    },
  };
}
