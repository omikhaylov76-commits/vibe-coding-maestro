import { readdir } from 'node:fs/promises';

/**
 * README проекта — не в составе, который проверяет doctor: create и upgrade кладут его,
 * только если в корне нет никакого README, а удалить его можно. В составе он стал бы
 * обязательным, а на Linux рядом с `readme.md` появился бы второй файл.
 */
export const README_PATH = 'README.md';

/** README, README.md, readme.md, README.rst, Readme.txt и т. п. — любое имя «readme» с расширением или без. */
export function isReadmeName(name: string): boolean {
  return /^readme(\..*)?$/i.test(name);
}

export async function hasAnyReadme(root: string): Promise<boolean> {
  try {
    return (await readdir(root)).some(isReadmeName);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}
