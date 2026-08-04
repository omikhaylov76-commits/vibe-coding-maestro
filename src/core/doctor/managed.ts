import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHECKSUMS_PATH, contentChecksum, MANIFEST_PATH } from '../manifest.js';
import type { Checksums, Manifest } from '../manifest.js';
import { canonicalManagedKind, canonicalOwnershipInventory } from '../inventory.js';
import { pathHasSymlink } from './fs-utils.js';
import { critical, error } from './types.js';
import type { DoctorFinding } from './types.js';

/** Результат проверки managed-файлов: набор managed *.md нужен потом проверке Git. */
export interface ManagedCheckResult {
  managedDocs: Set<string>;
}

export function checkInventory(manifest: Manifest, findings: DoctorFinding[]): void {
  const expectedInventory = canonicalOwnershipInventory(manifest.project.depth);
  const byPath = new Map(manifest.managed.map((entry) => [entry.path, entry.kind]));
  for (const [path, ownership] of Object.entries(expectedInventory)) {
    const expectedKind = canonicalManagedKind(path, ownership);
    if (byPath.get(path) !== expectedKind) findings.push(error('manifest-inventory-mismatch', 'Обязательный системный путь отсутствует или имеет неверный kind.', path));
  }
  const ownershipByPath = new Map(manifest.inventory.map((entry) => [entry.path, entry.ownership]));
  for (const [path, ownership] of Object.entries(canonicalOwnershipInventory(manifest.project.depth))) {
    if (ownershipByPath.get(path) !== ownership) findings.push(error('manifest-ownership-mismatch', 'Canonical inventory отсутствует или имеет неверное ownership.', path));
  }
  for (const entry of manifest.managed) {
    if (!(entry.path in expectedInventory)) findings.push(error('manifest-inventory-extra', 'Manifest содержит путь вне canonical inventory.', entry.path));
  }
  for (const entry of manifest.inventory) {
    if (!(entry.path in expectedInventory)) findings.push(error('manifest-inventory-extra', 'Canonical inventory содержит лишний путь.', entry.path));
  }
}

export async function checkManagedFiles(
  root: string,
  manifest: Manifest,
  checksums: Checksums | null,
  findings: DoctorFinding[],
): Promise<ManagedCheckResult> {
  const managedDocs = new Set<string>();
  for (const entry of manifest.managed) {
    // Структурные инварианты (symlink, наличие файла) действуют и для
    // content-owned документов: проект владеет их содержимым, но не правом
    // подменить файл symlink или удалить его из inventory-дерева.
    // Собственные metadata имеют отдельные диагностики и здесь пропускаются.
    if (entry.path === MANIFEST_PATH || entry.path === CHECKSUMS_PATH) continue;
    if (await pathHasSymlink(root, entry.path)) {
      findings.push(critical('managed-symlink', 'Управляемый путь не должен содержать symbolic link.', entry.path));
      continue;
    }
    if (entry.kind === 'merged') continue;
    const absolute = join(root, entry.path);
    if (!existsSync(absolute)) { findings.push(error('managed-missing', 'Управляемый файл отсутствует.', entry.path)); continue; }

    // Дальше — проверка целостности по checksum, которая применима только к
    // файлам, чьим содержимым владеет Maestro.
    if (entry.kind !== 'managed') continue;
    if (entry.path.endsWith('.md')) managedDocs.add(entry.path);
    const expected = checksums?.files[entry.path];
    if (expected === undefined) { findings.push(error('managed-checksum-missing', 'Для управляемого файла отсутствует обязательная контрольная сумма.', entry.path)); continue; }
    try {
      if (contentChecksum(entry.path, await readFile(absolute)) !== expected) findings.push(error('managed-modified', 'Управляемый файл изменён относительно установленной версии.', entry.path));
    } catch (cause) {
      findings.push(error('text-unreadable', `Не удалось прочитать файл: ${cause instanceof Error ? cause.message : String(cause)}`, entry.path));
    }
  }
  return { managedDocs };
}
