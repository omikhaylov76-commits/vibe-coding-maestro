import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'create-vibe-maestro';

/**
 * Находит корень установленного пакета, поднимаясь вверх от текущего модуля.
 * Работает одинаково из src (тесты через vitest) и из dist (собранный bin).
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // повреждённый package.json по пути наверх не должен ломать поиск
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Не удалось найти корень пакета ${PACKAGE_NAME}`);
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function schemasDir(): string {
  return join(packageRoot(), 'schemas');
}

export function readPackageJson(): { version: string; name: string } {
  const raw = readFileSync(join(packageRoot(), 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string; name?: string };
  return { version: parsed.version ?? '0.0.0', name: parsed.name ?? PACKAGE_NAME };
}

/** Абсолютный путь без завершающего разделителя. */
export function normalizeTarget(target: string): string {
  return resolve(target);
}
