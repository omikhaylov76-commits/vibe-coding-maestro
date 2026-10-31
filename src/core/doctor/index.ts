import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { CHECKSUMS_PATH, isCanonicalManifest, loadChecksums, loadManifest, MANIFEST_PATH } from '../manifest.js';
import type { Manifest } from '../manifest.js';
import { CREATE_COMMAND, quotePathArg, serviceInvocation, VERSION } from '../meta.js';
import { readPackageJson } from '../paths.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { compareVersions } from '../version.js';
import { absolutePathHasSymlink, pathHasSymlink } from './fs-utils.js';
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
  const checkSame = `${serviceInvocation(projectVersion)} doctor --path ${path}`;
  const upgrade = `${serviceInvocation(VERSION)} upgrade --path ${path}`;
  if (canonical) {
    return order < 0
      ? info('project-version-older', `Проект создан Vibe Coding Maestro ${projectVersion}; состав файлов совпадает с ${VERSION}. Перевести проект на ${VERSION}: ${upgrade} (без --apply только показывает изменения).`, MANIFEST_PATH)
      : info('project-version-newer', `Проект обновлён более новой версией ${projectVersion}, а проверяет ${VERSION}. Точная проверка: ${checkSame}`, MANIFEST_PATH);
  }
  return order < 0
    ? error('project-outdated', `Проект создан Vibe Coding Maestro ${projectVersion}, а запущена ${VERSION}: у этих версий разный состав файлов. Проверить проект его версией: ${checkSame}. Обновить проект до ${VERSION}: ${upgrade} (без --apply только показывает изменения).`, MANIFEST_PATH)
    : error('project-newer', `Проект создан более новой версией ${projectVersion}, а запущена ${VERSION}. Проверьте проект его версией: ${checkSame}`, MANIFEST_PATH);
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
    // Канон другой версии этой версией не проверить: остальные находки были бы шумом.
    findings.push(version);
    return report(root, findings, options.strict);
  }
  if (version !== null) findings.push(version);

  if (!canonical) {
    findings.push(error('manifest-canonical-mismatch', `Manifest не совпадает с каноном Vibe Coding Maestro ${VERSION}.`, MANIFEST_PATH));
  } else if (manifest.project.name !== basename(root)) {
    findings.push(error(
      'manifest-canonical-mismatch',
      `Manifest принадлежит другой папке: проект называется «${manifest.project.name}», а папка — «${basename(root)}». Если папку переименовали или склонировали под другим именем, верните ей имя «${manifest.project.name}».`,
      MANIFEST_PATH,
    ));
  }

  const checksums = await loadChecksums(root);
  if (checksums === null) findings.push(error('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));

  checkInventory(manifest, findings);
  const { managedDocs } = await checkManagedFiles(root, manifest, checksums, findings);

  await checkProtocols(root, findings);
  checkPlans(root, await checkWiki(root, findings), findings);
  await checkGit(root, managedDocs, findings);
  await checkInbox(root, findings);
  await checkSources(root, findings);

  return report(root, findings, options.strict);
}
