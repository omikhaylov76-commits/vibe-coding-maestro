/**
 * Сравнение версий продукта по правилам SemVer 2.0 без сторонних зависимостей.
 *
 * Нужно только для того, чтобы сказать человеку, в какую сторону расходятся
 * проект и запущенный Maestro. Права на запись версия не даёт: upgrade
 * по-прежнему доказывает предшественника формой inventory и содержимым файлов.
 */

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(value: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(value);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Возвращает -1, 0 или 1, как обычный компаратор, либо null, если хотя бы одна
 * строка не является версией SemVer: такую пару нельзя честно упорядочить.
 */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const diff = Math.sign((a.core[i] as number) - (b.core[i] as number));
    if (diff !== 0) return diff;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    // Выпуск старше любой своей пред-версии: 0.3.0 > 0.3.0-beta.4.
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const diff = compareIdentifiers(x, y);
    if (diff !== 0) return diff;
  }
  return 0;
}
