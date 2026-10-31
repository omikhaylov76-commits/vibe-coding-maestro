import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describeFsError } from './fs-errors.js';
import { mergeGitignore, REQUIRED_GITIGNORE_ENTRIES } from './gitignore.js';
import { CREATE_COMMAND, quotePathArg, serviceInvocation, VERSION } from './meta.js';
import type { StartingPoint } from './meta.js';
import {
  CHECKSUMS_PATH,
  CREATING_MARKER_PATH,
  normalizeEol,
  contentChecksum,
  loadChecksums,
  MAESTRO_DIR,
  MANIFEST_PATH,
  buildManifest,
  isCanonicalManifest,
  loadManifest,
  writeChecksums,
  writeManifest,
} from './manifest.js';
import { DEPTHS } from './manifest.js';
import type { ManagedEntry, Manifest, ProjectDepth } from './manifest.js';
import { normalizeTarget, readPackageJson, templatesDir } from './paths.js';
import { renderTemplate } from './template.js';
import { recoverTemplateVars, templateUses } from './template-recover.js';
import { canonicalOwnershipInventory, CONTENT_OWNED_FILES, lazyDirsForDepth, TEMPLATE_FILES } from './inventory.js';
import { canonicalizeSystemTempPrefix, onDiskBasename } from './platform-paths.js';
import { compareVersions } from './version.js';

const execFileAsync = promisify(execFile);

const GITIGNORE_PATH = '.gitignore';

/** Служебный мусор ОС и сам Git не делают папку «занятой чужими файлами». */
const IGNORED_WHEN_EMPTY_CHECK: readonly string[] = ['.git', '.DS_Store'];

/** Шаблон .gitattributes: фиксирует LF для текстовых файлов проекта. */
const GITATTRIBUTES_PATH = '.gitattributes';
export const GITATTRIBUTES_CONTENT = '* text=auto eol=lf\n*.md text eol=lf\n*.json text eol=lf\n*.yml text eol=lf\n*.yaml text eol=lf\n';

export interface InitOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  git?: boolean;
  now?: Date;
  depth?: ProjectDepth;
  /** Параметры, которые человек указал явно: для готового проекта о них стоит сказать, а не молчать. */
  requested?: { depth?: ProjectDepth; startingPoint?: StartingPoint };
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

/**
 * Manifest описывает ожидаемый канон, но сам по себе не доказывает, что этот
 * канон действительно установлен в target. До повторного init каждый путь из
 * trusted inventory уже должен существовать как обычный файл. Иначе copied
 * manifest смог бы превратить чужую неполную папку в "canonical project".
 */
async function hasCompleteCanonicalTree(root: string, manifest: Manifest): Promise<boolean> {
  for (const entry of manifest.inventory) {
    try {
      if (!(await lstat(join(root, entry.path))).isFile()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
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
 * Подстановки существующего проекта (отображаемое имя, дата создания) по его же
 * неизменённым managed-файлам. Версия та же, что у пакета (create не работает с
 * проектами других версий), поэтому источник — текущие шаблоны. Файл, изменённый
 * пользователем, не используется: восстановление по нему было бы угадыванием.
 */
async function recoverProjectVars(
  target: string,
  startingPoint: StartingPoint,
  checksums: Readonly<Record<string, string>>,
): Promise<{ projectName?: string; date?: string }> {
  const found: { projectName?: string; date?: string } = {};
  for (const relativePath of TEMPLATE_FILES) {
    if (relativePath === GITATTRIBUTES_PATH || checksums[relativePath] === undefined) continue;
    // Шаблоны пакета на Windows могут прийти с CRLF, а файлы проекта всегда пишутся с LF.
    const source = normalizeEol(await readTemplate(relativePath));
    const uses = templateUses(source);
    if ((!uses.projectName || found.projectName !== undefined) && (!uses.date || found.date !== undefined)) continue;
    let actual: string;
    try {
      actual = await readFile(join(target, relativePath), 'utf8');
    } catch {
      continue;
    }
    if (contentChecksum(relativePath, actual) !== checksums[relativePath]) continue;
    const vars = recoverTemplateVars(source, actual, startingPoint, VERSION);
    if (vars === null) continue;
    found.projectName ??= vars.projectName;
    found.date ??= vars.date;
  }
  return found;
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
  writtenPaths: readonly string[],
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
      // Добавлять нечего — и подсказывать нечего.
      if (writtenPaths.length > 0) {
        const shown = writtenPaths.slice(0, 5).map((path) => quotePathArg(path)).join(' ');
        warnings.push(`Репозиторий Git уже существовал: index не изменён и commit не создан. Добавьте записанные файлы сами: git add ${shown}${writtenPaths.length > 5 ? ' …' : ''}`);
      }
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
 * - managed-файл, изменённый пользователем, сохраняется при повторном запуске;
 * - повторный запуск на неизменённом проекте не меняет ни один байт.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const target = await canonicalizeSystemTempPrefix(normalizeTarget(options.target));
  const progress: WriteProgress = { freshFolder: false, started: false };
  try {
    return await initProjectAt(target, options, progress);
  } catch (cause) {
    const reason = describeFsError(cause, target);
    let leftovers = '';
    if (progress.started && progress.freshFolder) {
      leftovers = ` В папке могли остаться частично записанные файлы Maestro. До запуска она была пустой, поэтому её можно удалить целиком и повторить команду: ${target}`;
    } else if (progress.started && progress.existingProject) {
      leftovers = ' Часть файлов Maestro могла обновиться без manifest и контрольных сумм: проверьте проект командой doctor и git status.';
    } else if (progress.started) {
      leftovers = ' В папке могли остаться частично записанные файлы Maestro: проверьте git status, прежде чем удалять что-либо.';
    }
    return failure(target, options.name ?? basename(target), `${reason}${leftovers}`);
  }
}

/** Что успело произойти до сбоя: от этого зависит совет пользователю. */
interface WriteProgress {
  /** Папки не было или в ней не было ничего, даже `.git`: удалить её целиком безопасно. */
  freshFolder: boolean;
  existingProject?: boolean;
  started: boolean;
}

async function initProjectAt(target: string, options: InitOptions, progress: WriteProgress): Promise<InitResult> {
  const now = options.now ?? new Date();
  if (options.depth !== undefined && !DEPTHS.includes(options.depth)) {
    return failure(target, options.name ?? basename(target), `Неизвестная глубина проекта: ${String(options.depth)}`);
  }
  // Preflight проверяет максимальный canonical inventory: фактическая глубина
  // существующего проекта читается позже, а symlink нельзя пропустить до чтения metadata.
  const touchedPaths = [...TEMPLATE_FILES, ...CONTENT_OWNED_FILES, ...lazyDirsForDepth('advanced').map((path) => `${path}/.gitkeep`), GITIGNORE_PATH, MANIFEST_PATH, CHECKSUMS_PATH];

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

  if (existsSync(join(target, CREATING_MARKER_PATH))) {
    return failure(
      target,
      options.name ?? basename(target),
      `Прошлый запуск create в этой папке был прерван: осталась метка ${CREATING_MARKER_PATH}, файлы Maestro могут быть неполными. Если папка была новой — удалите её целиком и запустите create заново; если в ней есть ваши файлы — сначала проверьте git status.`,
    );
  }

  let previousManifest = null;
  if (existsSync(join(target, MANIFEST_PATH))) {
    try {
      previousManifest = await loadManifest(target);
    } catch (error) {
      return failure(target, options.name ?? basename(target), `Повреждён manifest; сначала запустите doctor: ${error instanceof Error ? error.message : String(error)}`);
    }
    const ours = previousManifest.product.name === readPackageJson().name && previousManifest.product.createdBy === CREATE_COMMAND;
    const projectVersion = previousManifest.product.version;
    if (ours && projectVersion !== VERSION) {
      // Create не меняет версию проекта ни вверх, ни вниз: для этого есть upgrade с проверкой каждого файла.
      const newer = (compareVersions(projectVersion, VERSION) ?? -1) > 0;
      return failure(
        target,
        options.name ?? basename(target),
        newer
          ? `Это проект Vibe Coding Maestro более новой версии ${projectVersion}, а create — версии ${VERSION}. Create не меняет версию проекта; проверка: \`${serviceInvocation(projectVersion)} doctor --path ${quotePathArg(target)}\`.`
          : `Это проект Vibe Coding Maestro версии ${projectVersion}, а create — версии ${VERSION}. Create не обновляет проекты; используйте \`${serviceInvocation(VERSION)} upgrade --path ${quotePathArg(target)}\` (без --apply только показывает изменения).`,
      );
    }
    // Личность проекта — project.id: клон или переименованная папка остаются тем же проектом.
    if (
      !isCanonicalManifest(previousManifest)
      || !(await hasCompleteCanonicalTree(target, previousManifest))
    ) {
      return failure(
        target,
        options.name ?? basename(target),
        `Папка не является каноническим проектом Vibe Coding Maestro: ${target}. Core не преобразует foreign или неполные проекты; используйте новую пустую папку.`,
      );
    }
  }

  const isExistingProject = previousManifest !== null;
  if (existsSync(target) && !isExistingProject && !(await isDirectoryEmpty(target))) {
    return failure(
      target,
      options.name ?? basename(target),
      `Папка не пуста и не является каноническим проектом Vibe Coding Maestro: ${target}. Core не изменяет существующие проекты; создайте новую пустую папку.`,
    );
  }

  /**
   * Разделение имён:
   * - в манифесте проект опознаётся по имени папки (идентичность на диске);
   * - отображаемое название в документах берётся из --name, иначе из имени папки.
   */
  // Unicode приводится к NFC: одно и то же имя, набранное на macOS и на Linux, совпадает.
  const folderName = onDiskBasename(target).normalize('NFC');
  const displayName = (options.name ?? folderName).normalize('NFC');

  // Параметры существующего проекта не переписываются: манифест должен остаться стабильным.
  const projectName = previousManifest?.project.name ?? folderName;
  const startingPoint = previousManifest?.project.startingPoint ?? options.startingPoint;
  const createdAt = previousManifest?.project.createdAt ?? now.toISOString();
  const projectId = previousManifest?.project.id;
  const depth = previousManifest?.project.depth ?? options.depth ?? 'standard';
  const lazyDirs = lazyDirsForDepth(depth);

  const createdFiles: string[] = [];
  const preservedFiles: string[] = [];
  const mergedFiles: string[] = [];
  const warnings: string[] = [];
  if (isExistingProject && options.requested?.depth !== undefined && options.requested.depth !== depth) {
    warnings.push(`У проекта глубина ${depth}; --depth ${options.requested.depth} не применён: create не меняет параметры готового проекта.`);
  }
  if (isExistingProject && options.requested?.startingPoint !== undefined && options.requested.startingPoint !== startingPoint) {
    warnings.push(`У проекта исходная точка ${startingPoint}; --start ${options.requested.startingPoint} не применён: create не меняет параметры готового проекта.`);
  }

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

  progress.freshFolder = !isExistingProject && (!existsSync(target) || (await readdir(target)).every((entry) => entry === '.DS_Store'));
  progress.existingProject = isExistingProject;
  progress.started = true;
  await mkdir(join(target, MAESTRO_DIR), { recursive: true });
  // Метка ставится до первой записи и снимается после последней: прерванный create виден.
  if (!isExistingProject) await writeFile(join(target, CREATING_MARKER_PATH), `${now.toISOString()}\n`, 'utf8');

  // Повторный запуск не переписывает подстановки: имя и дату берём из неизменённых файлов проекта.
  const recovered = isExistingProject ? await recoverProjectVars(target, startingPoint, previousChecksums) : {};
  const vars = {
    projectName: options.name === undefined ? recovered.projectName ?? displayName : displayName,
    date: recovered.date ?? isoDate(now),
    startingPoint,
  };

  /**
   * Записывает managed-файл, если его нет; сохраняет содержимое, если пользователь его изменил.
   *
   * Ключевое правило владения: контрольная сумма пишется ТОЛЬКО для содержимого,
   * которое записали мы сами. Чужое содержимое никогда не попадает в checksums —
   * иначе на следующем запуске оно выглядело бы как наш неизменённый файл
   * и было бы молча перезаписано при первой же смене шаблона.
   */
  async function materialize(relativePath: string, content: string): Promise<void> {
    const absolutePath = join(target, relativePath);
    const expected = checksumForContent(relativePath, content);

    if (!existsSync(absolutePath)) {
      managed.push({ path: relativePath, kind: 'managed' });
      await writeTextFile(absolutePath, content);
      createdFiles.push(relativePath);
      nextChecksums[relativePath] = expected;
      ownedPaths.push(relativePath);
      return;
    }

    const recorded = previousChecksums[relativePath];
    if (recorded === undefined) {
      // Legacy-поле `managed` не имеет project-owned. `generated` — честное
      // совместимое представление: файл присутствует в inventory, но checksum
      // и право перезаписи Maestro ему не приписываются.
      managed.push({ path: relativePath, kind: 'generated' });
      preservedFiles.push(relativePath);
      return;
    }

    managed.push({ path: relativePath, kind: 'managed' });
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

  for (const relativePath of CONTENT_OWNED_FILES) {
    managed.push({ path: relativePath, kind: 'generated' });
    const absolutePath = join(target, relativePath);
    if (!existsSync(absolutePath)) {
      const source = await readTemplate(relativePath);
      await writeTextFile(absolutePath, renderTemplate(source, vars));
      createdFiles.push(relativePath);
      ownedPaths.push(relativePath);
    } else {
      preservedFiles.push(relativePath);
    }
  }

  for (const dir of lazyDirs) {
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
    projectId,
    depth,
    inventory: Object.entries(canonicalOwnershipInventory(depth)).map(([path, ownership]) => ({ path, ownership })),
  });

  await writeManifest(target, manifest);
  await writeChecksums(target, nextChecksums);

  if (options.git === true) {
    await initGitRepository(target, ownedPaths, warnings, [...createdFiles, ...mergedFiles]);
  }
  // Метка снимается последней: убитый на любом шаге, включая Git, create остаётся виден.
  if (!isExistingProject) await rm(join(target, CREATING_MARKER_PATH), { force: true });

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
