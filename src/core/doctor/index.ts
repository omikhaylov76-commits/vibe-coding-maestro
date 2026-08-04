import { basename, resolve } from 'node:path';
import { CHECKSUMS_PATH, isCanonicalManifest, loadChecksums, loadManifest, MANIFEST_PATH } from '../manifest.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { absolutePathHasSymlink, pathHasSymlink } from './fs-utils.js';
import { checkGit } from './git.js';
import { checkInbox } from './inbox.js';
import { checkInventory, checkManagedFiles } from './managed.js';
import { checkProtocols } from './protocols.js';
import { checkSources } from './sources.js';
import { checkWiki } from './wiki.js';
import { critical, error, findingsPass, sortFindings } from './types.js';
import type { DoctorFinding, DoctorOptions, DoctorReport } from './types.js';

export type { DoctorFinding, DoctorOptions, DoctorReport, FindingLevel } from './types.js';

const report = (root: string, findings: DoctorFinding[], strict = false): DoctorReport => {
  const sorted = sortFindings(findings);
  return { reportVersion: 1, ok: findingsPass(sorted, strict), root, findings: sorted };
};

export async function doctorProject(rootInput: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = await canonicalizeSystemTempPrefix(resolve(rootInput));
  const findings: DoctorFinding[] = [];
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

  let manifest;
  try {
    manifest = await loadManifest(root);
  } catch (cause) {
    findings.push(error('manifest-invalid', `Манифест отсутствует или повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, MANIFEST_PATH));
    return report(root, findings, options.strict);
  }

  if (!isCanonicalManifest(manifest) || manifest.project.name !== basename(root)) {
    findings.push(error('manifest-canonical-mismatch', 'Manifest не принадлежит этому canonical project.', MANIFEST_PATH));
  }

  const checksums = await loadChecksums(root);
  if (checksums === null) findings.push(error('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));

  checkInventory(manifest, findings);
  const { managedDocs } = await checkManagedFiles(root, manifest, checksums, findings);

  await checkProtocols(root, findings);
  await checkWiki(root, findings);
  await checkGit(root, managedDocs, findings);
  await checkInbox(root, findings);
  await checkSources(root, findings);

  return report(root, findings, options.strict);
}
