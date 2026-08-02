import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mergeGitignore, REQUIRED_GITIGNORE_ENTRIES } from './gitignore.js';
import { CREATE_COMMAND, VERSION } from './meta.js';
import type { StartingPoint } from './meta.js';
import {
  CHECKSUMS_PATH,
  contentChecksum,
  loadChecksums,
  MAESTRO_DIR,
  MANIFEST_PATH,
  buildManifest,
  tryLoadManifest,
  writeChecksums,
  writeManifest,
} from './manifest.js';
import type { ManagedEntry } from './manifest.js';
import { normalizeTarget, readPackageJson, templatesDir } from './paths.js';
import { renderTemplate } from './template.js';
import { LAZY_DIRS, TEMPLATE_FILES } from './inventory.js';

const execFileAsync = promisify(execFile);

const GITIGNORE_PATH = '.gitignore';

/** Служебный мусор ОС и сам Git не делают папку «занятой чужими файлами». */
const IGNORED_WHEN_EMPTY_CHECK: readonly string[] = ['.git', '.DS_Store'];

/** Шаблон .gitattributes: фиксирует LF для текстовых файлов проекта. */
const GITATTRIBUTES_PATH = '.gitattributes';
const GITATTRIBUTES_CONTENT = '* text=auto eol=lf\n*.md text eol=lf\n*.json text eol=lf\n*.yml text eol=lf\n*.yaml text eol=lf\n';

export interface InitOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  force?: boolean;
  git?: boolean;
  now?: Date;
}

export interface InitResult {
  ok: boolean;
  target: string;
  projectName: string;
  createdFiles: string[];
  preservedFiles: string[];
  mergedFiles: string[];
  warnings: string[];
  error?: string;
}

function failure(target: string, projectName: string, error: string): InitResult {
  return {
    ok: false,
    target,
    projectName,
    createdFiles: [],
    preservedFiles: [],
    mergedFiles: [],
    warnings: [],
    error,
  };
}

/** Дата для frontmatter в UTC: ГГГГ-ММ-ДД. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

async function isDirectoryEmpty(dir: string): Promise<boolean> {
  const entries = await readdir(dir);
  return entries.every((entry) => IGNORED_WHEN_EMPTY_CHECK.includes(entry));
}

async function readTemplate(relativePath: string): Promise<string> {
  return readFile(join(templatesDir(), 'project', relativePath), 'utf8');
}

/** Все файлы пишутся в UTF-8 без BOM и только с LF. */
async function writeTextFile(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content.replace(/\r\n/g, '\n'), 'utf8');
}

async function findSymlink(root: string, relativePath: string): Promise<string | null> {
  let current = root;
  for (const part of relativePath.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return null;
}

/** Проверяет все уже существующие компоненты абсолютного target до первого отсутствующего. */
async function findAncestorSymlink(target: string): Promise<string | null> {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  let current = root;
  const remainder = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean);
  for (const part of remainder) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return null;
}

/**
 * Готовит Git, не присваивая чужую работу.
 *
 * Правила:
 * - в уже существующем репозитории мы НЕ создаём commit: незакоммиченная работа
 *   пользователя не наша, и её нельзя фиксировать от его имени;
 * - в индекс попадают только пути, содержимое которых записали мы (ownedPaths),
 *   никогда git add -A;
 * - локальная идентичность настраивается только когда репозиторий создаём мы сами.
 */
async function initGitRepository(
  target: string,
  ownedPaths: readonly string[],
  warnings: string[],
): Promise<void> {
  try {
    const repositoryExisted = existsSync(join(target, '.git'));

    if (!repositoryExisted) {
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: target });

      // Служебная локальная идентичность нужна на чистой машине без global git config.
      // Глобальные настройки пользователя не меняются.
      const name = await execFileAsync('git', ['config', '--get', 'user.name'], { cwd: target }).catch(() => null);
      if (name === null || name.stdout.trim() === '') {
        await execFileAsync('git', ['config', 'user.name', 'Vibe Coding Maestro'], { cwd: target });
      }
      const email = await execFileAsync('git', ['config', '--get', 'user.email'], { cwd: target }).catch(() => null);
      if (email === null || email.stdout.trim() === '') {
        await execFileAsync('git', ['config', 'user.email', 'maestro@localhost'], { cwd: target });
      }
    }

    if (repositoryExisted) {
      warnings.push('Репозиторий Git уже существовал: index не изменён и commit не создан — добавьте файлы Maestro вручную.');
      return;
    }

    // Только наши пути в новом репозитории. Пакетами, чтобы не упереться в лимит длины командной строки.
    const toAdd = [...ownedPaths].sort();
    for (let i = 0; i < toAdd.length; i += 50) {
      await execFileAsync('git', ['add', '--', ...toAdd.slice(i, i + 50)], { cwd: target });
    }

    await execFileAsync('git', ['commit', '-m', 'Инициализация проекта Vibe Coding Maestro'], {
      cwd: target,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`Git-шаги пропущены: ${message}`);
  }
}

/**
 * Создаёт (или дополняет) структуру проекта.
 *
 * Главные гарантии:
 * - чужие файлы никогда не удаляются и не перезаписываются;
 * - managed-файл, изменённый пользователем, сохраняется даже с --force;
 * - повторный запуск на неизменённом проекте не меняет ни один байт.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const target = normalizeTarget(options.target);
  const force = options.force === true;
  const now = options.now ?? new Date();
  const touchedPaths = [...TEMPLATE_FILES, ...LAZY_DIRS.map((path) => `${path}/.gitkeep`), GITIGNORE_PATH, MANIFEST_PATH, CHECKSUMS_PATH];

  const ancestorSymlink = await findAncestorSymlink(target);
  if (ancestorSymlink !== null) {
    return failure(target, options.name ?? basename(target), `Целевой путь содержит symbolic link (symlink): ${ancestorSymlink}`);
  }

  if (existsSync(target)) {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink()) {
      return failure(target, options.name ?? basename(target), `Целевая папка является symbolic link (symlink): ${target}`);
    }
    const info = await stat(target);
    if (!info.isDirectory()) {
      return failure(
        target,
        options.name ?? basename(target),
        `Цель существует, но это файл, а не папка: ${target}`,
      );
    }
    for (const relativePath of touchedPaths) {
      if (await findSymlink(target, relativePath)) {
        return failure(target, options.name ?? basename(target), `Затрагиваемый путь содержит symbolic link (symlink): ${relativePath}`);
      }
    }
  }

  if (existsSync(join(target, MANIFEST_PATH))) {
    try {
      const { loadManifest } = await import('./manifest.js');
      await loadManifest(target);
    } catch (error) {
      return failure(target, options.name ?? basename(target), `Повреждён manifest; сначала запустите doctor: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const previousManifest = existsSync(target) ? await tryLoadManifest(target) : null;
  const isExistingProject = previousManifest !== null;

  if (existsSync(target) && !isExistingProject && !force && !(await isDirectoryEmpty(target))) {
    return failure(
      target,
      options.name ?? basename(target),
      `Папка не пуста: ${target}. Повторите с --force, если хотите добавить проект в неё.`,
    );
  }

  /**
   * Разделение имён:
   * - в манифесте проект опознаётся по имени папки (идентичность на диске);
   * - отображаемое название в документах берётся из --name, иначе из имени папки.
   */
  const folderName = basename(target);
  const displayName = options.name ?? folderName;

  // Параметры существующего проекта не переписываются: манифест должен остаться стабильным.
  const projectName = previousManifest?.project.name ?? folderName;
  const startingPoint = previousManifest?.project.startingPoint ?? options.startingPoint;
  const createdAt = previousManifest?.project.createdAt ?? now.toISOString();

  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];
  const mergedFiles: string[] = [];
  const warnings: string[] = [];

  const previousChecksums = (await loadChecksums(target))?.files ?? {};
  const nextChecksums: Record<string, string> = {};
  const managed: ManagedEntry[] = [];

  /**
   * Пути, содержимым которых владеет Maestro на этом запуске.
   * Только они попадают в git add: чужой WIP индексировать нельзя.
   */
  const ownedPaths: string[] = [];

  const checksumForContent = (relativePath: string, content: string): string =>
    contentChecksum(relativePath, content);

  const checksumForFile = async (relativePath: string, absolutePath: string): Promise<string> =>
    contentChecksum(relativePath, await readFile(absolutePath));

  await mkdir(join(target, MAESTRO_DIR), { recursive: true });

  const vars = { projectName: displayName, date: isoDate(now), startingPoint };

  /**
   * Записывает managed-файл, если его нет; сохраняет содержимое, если пользователь его изменил.
   *
   * Ключевое правило владения: контрольная сумма пишется ТОЛЬКО для содержимого,
   * которое записали мы сами. Чужое содержимое никогда не попадает в checksums —
   * иначе на следующем запуске оно выглядело бы как наш неизменённый файл
   * и было бы молча перезаписано при первой же смене шаблона.
   */
  async function materialize(relativePath: string, content: string): Promise<void> {
    managed.push({ path: relativePath, kind: 'managed' });
    const absolutePath = join(target, relativePath);
    const expected = checksumForContent(relativePath, content);

    if (!existsSync(absolutePath)) {
      await writeTextFile(absolutePath, content);
      createdFiles.push(relativePath);
      nextChecksums[relativePath] = expected;
      ownedPaths.push(relativePath);
      return;
    }

    const recorded = previousChecksums[relativePath];
    if (recorded === undefined) {
      // Путь существовал до нас и никогда не был нашим: он целиком пользовательский.
      // Ни записи, ни контрольной суммы — иначе мы «узаконим» чужой файл.
      preservedFiles.push(relativePath);
      return;
    }

    const actual = await checksumForFile(relativePath, absolutePath);
    if (actual === expected) {
      nextChecksums[relativePath] = expected;
      ownedPaths.push(relativePath);
      return;
    }

    if (recorded !== actual) {
      // Наш файл, изменённый пользователем: сохраняем правки и прежнюю сумму,
      // чтобы проверка целостности продолжала их видеть.
      preservedFiles.push(relativePath);
      nextChecksums[relativePath] = recorded;
      return;
    }

    // Файл не изменялся с прошлого запуска, но шаблон обновился — можно обновить.
    await writeTextFile(absolutePath, content);
    nextChecksums[relativePath] = expected;
    ownedPaths.push(relativePath);
  }

  for (const relativePath of TEMPLATE_FILES) {
    const source = relativePath === GITATTRIBUTES_PATH ? GITATTRIBUTES_CONTENT : await readTemplate(relativePath);
    await materialize(relativePath, relativePath === GITATTRIBUTES_PATH ? source : renderTemplate(source, vars));
  }

  for (const dir of LAZY_DIRS) {
    await mkdir(join(target, dir), { recursive: true });
    await materialize(`${dir}/.gitkeep`, '');
  }

  // .gitignore принадлежит пользователю: только дописываем недостающие строки.
  managed.push({ path: GITIGNORE_PATH, kind: 'merged' });
  const gitignoreAbsolute = join(target, GITIGNORE_PATH);
  const existingGitignore = existsSync(gitignoreAbsolute)
    ? await readFile(gitignoreAbsolute, 'utf8')
    : null;
  const merge = mergeGitignore(existingGitignore, REQUIRED_GITIGNORE_ENTRIES);
  if (merge.changed) {
    // merged user file keeps its original EOL style; managed files use LF.
    await mkdir(dirname(gitignoreAbsolute), { recursive: true });
    await writeFile(gitignoreAbsolute, merge.content, 'utf8');
    if (existingGitignore === null) createdFiles.push(GITIGNORE_PATH);
    else mergedFiles.push(GITIGNORE_PATH);
    // Строки дописали мы — этот путь можно индексировать.
    ownedPaths.push(GITIGNORE_PATH);
  }

  // Служебные файлы инструмента. Себя в контрольные суммы не включают — самоссылка невозможна.
  managed.push({ path: MANIFEST_PATH, kind: 'generated' });
  managed.push({ path: CHECKSUMS_PATH, kind: 'generated' });
  ownedPaths.push(MANIFEST_PATH, CHECKSUMS_PATH);

  const manifest = buildManifest({
    projectName,
    startingPoint,
    createdAt,
    productName: readPackageJson().name,
    productVersion: VERSION,
    createdBy: CREATE_COMMAND,
    managed,
  });

  await writeManifest(target, manifest);
  await writeChecksums(target, nextChecksums);

  if (options.git === true) {
    await initGitRepository(target, ownedPaths, warnings);
  }

  return {
    ok: true,
    target,
    projectName: displayName,
    createdFiles,
    preservedFiles,
    mergedFiles,
    warnings,
  };
}
