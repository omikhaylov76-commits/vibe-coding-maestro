import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHECKSUMS_PATH, CREATING_MARKER_PATH, isCanonicalManifest, loadChecksums, loadManifest, MANIFEST_PATH } from '../manifest.js';
import type { Manifest } from '../manifest.js';
import { CREATE_COMMAND, FIRST_NPM_VERSION, quotePathArg, serviceInvocation, VERSION } from '../meta.js';
import { readPackageJson } from '../paths.js';
import { canonicalizeSystemTempPrefix, onDiskBasename } from '../platform-paths.js';
import { compareVersions } from '../version.js';
import { absolutePathHasSymlink, pathHasSymlink } from './fs-utils.js';
import { checkProjectEntries } from './entries.js';
import { checkGit } from './git.js';
import { checkInbox } from './inbox.js';
import { checkInventory, checkManagedFiles } from './managed.js';
import { checkPlans } from './plans.js';
import { checkProtocols } from './protocols.js';
import { checkSources } from './sources.js';
import { checkWiki } from './wiki.js';
import { critical, error, findingsPass, info, sortFindings } from './types.js';
import type { DoctorFinding, DoctorOptions, DoctorReport } from './types.js';

export type { DoctorFinding, DoctorOptions, DoctorReport, FindingLevel } from './types.js';

const report = (root: string, findings: DoctorFinding[], strict = false): DoctorReport => {
  const sorted = sortFindings(findings);
  return { reportVersion: 1, ok: findingsPass(sorted, strict), root, findings: sorted };
};

/**
 * Проект и запущенный Maestro разных версий. Вердикт только объясняет, какой
 * командой проверить или обновить проект: права на запись версия не даёт.
 */
function versionFinding(rootInput: string, manifest: Manifest, canonical: boolean): DoctorFinding | null {
  const projectVersion = manifest.product.version;
  const order = compareVersions(projectVersion, VERSION);
  if (order === null || order === 0) return null;
  // Путь в подсказке — как его набрал человек: команду можно скопировать из того же места.
  const path = quotePathArg(rootInput);
  const published = (compareVersions(projectVersion, FIRST_NPM_VERSION) ?? -1) >= 0;
  // Команда в обратных кавычках: точка в конце предложения не приклеивается к пути (`--path .` ≠ `--path ..`).
  const checkSame = published
    ? `\`${serviceInvocation(projectVersion)} doctor --path ${path}\``
    : `версия ${projectVersion} не публиковалась в npm, поэтому проверить проект его же версией нельзя`;
  const upgrade = `\`${serviceInvocation(VERSION)} upgrade --path ${path}\``;
  if (canonical) {
    return order < 0
      ? info('project-version-older', `Проект создан Vibe Coding Maestro ${projectVersion}; состав файлов совпадает с ${VERSION}. Перевести проект на ${VERSION}: ${upgrade} (без --apply только показывает изменения).`, MANIFEST_PATH)
      : info('project-version-newer', `Проект обновлён более новой версией ${projectVersion}, а проверяет ${VERSION}. Точная проверка: ${checkSame}.`, MANIFEST_PATH);
  }
  return order < 0
    ? error('project-outdated', `Проект создан Vibe Coding Maestro ${projectVersion}, а запущена ${VERSION}: у этих версий разный состав файлов. Проверить проект его версией: ${checkSame}. Обновить проект до ${VERSION}: ${upgrade} (без --apply только показывает изменения).`, MANIFEST_PATH)
    : error('project-newer', `Проект создан более новой версией ${projectVersion}, а запущена ${VERSION}. Проверьте проект его версией: ${checkSame}.`, MANIFEST_PATH);
}

export async function doctorProject(rootInput: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = await canonicalizeSystemTempPrefix(resolve(rootInput));
  const findings: DoctorFinding[] = [];
  if (!existsSync(root)) {
    findings.push(error('project-path-missing', `Папка не найдена: ${root}. Проверьте путь; путь с пробелами возьмите в кавычки.`));
    return report(root, findings, options.strict);
  }
  if (!statSync(root).isDirectory()) {
    findings.push(error('project-path-not-directory', `Это файл, а не папка проекта: ${root}.`));
    return report(root, findings, options.strict);
  }
  if (await absolutePathHasSymlink(root)) {
    findings.push(critical('project-root-symlink', 'Путь к корню проекта не должен содержать symbolic link.', root));
    return report(root, findings, options.strict);
  }
  for (const metadataPath of [MANIFEST_PATH, CHECKSUMS_PATH]) {
    if (await pathHasSymlink(root, metadataPath)) {
      findings.push(critical('metadata-symlink', 'Системные metadata не должны содержать symbolic link.', metadataPath));
    }
  }
  if (findings.length > 0) return report(root, findings, options.strict);

  if (existsSync(join(root, CREATING_MARKER_PATH))) {
    findings.push(error('create-interrupted', `Создание проекта было прервано: осталась метка ${CREATING_MARKER_PATH}. Файлы могут быть неполными. Если папка новая — удалите её целиком и запустите create заново; если в ней есть ваши файлы — проверьте git status, прежде чем удалять что-либо.`, CREATING_MARKER_PATH));
    return report(root, findings, options.strict);
  }
  if (!existsSync(join(root, MANIFEST_PATH))) {
    findings.push(error('manifest-missing', `В папке нет ${MANIFEST_PATH}: это не проект Vibe Coding Maestro или указана не та папка. Новый проект создаётся командой npx ${CREATE_COMMAND}@latest.`, MANIFEST_PATH));
    return report(root, findings, options.strict);
  }

  let manifest;
  try {
    manifest = await loadManifest(root);
  } catch (cause) {
    findings.push(error('manifest-invalid', `Манифест повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, MANIFEST_PATH));
    return report(root, findings, options.strict);
  }

  const ours = manifest.product.name === readPackageJson().name && manifest.product.createdBy === CREATE_COMMAND;
  const canonical = isCanonicalManifest(manifest);
  const version = ours ? versionFinding(rootInput, manifest, canonical) : null;
  if (version !== null && version.level === 'error') {
    // Канон другой версии этой версией не сверить: inventory, протоколы и wiki дали бы шум.
    // Проверки, которые опираются только на данные самого проекта, остаются в силе.
    findings.push(version);
    const checksums = await loadChecksums(root);
    if (checksums === null) findings.push(error('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));
    const { managedDocs, managedFiles } = await checkManagedFiles(root, manifest, checksums, findings);
    await checkGit(root, managedDocs, findings, managedFiles);
    await checkInbox(root, findings);
    await checkSources(root, findings);
    return report(root, findings, options.strict);
  }
  if (version !== null) findings.push(version);

  if (!canonical) {
    findings.push(error('manifest-canonical-mismatch', `Manifest не совпадает с каноном Vibe Coding Maestro ${VERSION}.`, MANIFEST_PATH));
  } else if (manifest.project.name.normalize('NFC') !== onDiskBasename(root).normalize('NFC')) {
    // Личность проекта — project.id; имя папки при клонировании и переименовании законно меняется.
    findings.push(info(
      'project-folder-renamed',
      `Папка называется «${onDiskBasename(root)}», а в manifest записано имя «${manifest.project.name}». Это нормально для клона или переименованной папки: проект опознаётся по project.id.`,
      MANIFEST_PATH,
    ));
  }

  const checksums = await loadChecksums(root);
  if (checksums === null) findings.push(error('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));

  checkInventory(manifest, findings);
  const { managedDocs, managedFiles } = await checkManagedFiles(root, manifest, checksums, findings);

  await checkProtocols(root, findings);
  checkPlans(root, await checkWiki(root, findings), findings);
  await checkGit(root, managedDocs, findings, managedFiles);
  await checkInbox(root, findings);
  await checkSources(root, findings);
  await checkProjectEntries(root, manifest.product.version, findings);

  return report(root, findings, options.strict);
}
