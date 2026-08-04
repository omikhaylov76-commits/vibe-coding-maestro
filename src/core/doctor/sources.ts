import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isSafeProjectPath, sha256 } from '../manifest.js';
import { pathHasSymlink } from './fs-utils.js';
import { critical, error } from './types.js';
import type { DoctorFinding } from './types.js';

export const SOURCE_HASHES_PATH = '.maestro/source-hashes.json';
export const SOURCES_DIR = 'maestro/sources';

async function sourceFiles(root: string, dir: string, findings: DoctorFinding[]): Promise<string[]> {
  const relativeDir = relative(root, dir).split(sep).join('/');
  if (await pathHasSymlink(root, relativeDir)) {
    findings.push(critical('source-symlink', 'Sources path не должен содержать symbolic link.', relativeDir));
    return [];
  }
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) findings.push(critical('source-symlink', 'Source не должен быть symbolic link.', path));
    else if (entry.isDirectory()) result.push(...await sourceFiles(root, absolute, findings));
    else if (entry.isFile() && entry.name !== '.gitkeep') result.push(path);
  }
  return result.sort();
}

export async function checkSources(root: string, findings: DoctorFinding[]): Promise<void> {
  const sourcesPath = SOURCES_DIR;
  if (await pathHasSymlink(root, sourcesPath)) {
    findings.push(critical('source-symlink', 'Sources path не должен содержать symbolic link.', sourcesPath));
    return;
  }
  const metadataPath = SOURCE_HASHES_PATH;
  const metadataAbsolute = join(root, metadataPath);
  if (await pathHasSymlink(root, metadataPath)) {
    findings.push(critical('source-hashes-symlink', 'Metadata source hashes не должен содержать symbolic link.', metadataPath));
    return;
  }
  if (!existsSync(metadataAbsolute)) {
    const actualPaths = await sourceFiles(root, join(root, SOURCES_DIR), findings);
    if (actualPaths.length > 0) findings.push(critical('source-hashes-missing', 'Для существующих sources отсутствует metadata с versioned hashes.', metadataPath));
    return;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataAbsolute, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).join() !== 'files') throw new Error('ожидается объект { files }');
    const files = (parsed as { files?: unknown }).files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) throw new Error('files должен быть объектом');
    const hashes = files as Record<string, unknown>;
    for (const [path, hash] of Object.entries(hashes)) {
      if (!isSafeProjectPath(path) || !path.startsWith('maestro/sources/') || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`неверная запись ${path}`);
    }
    const actualPaths = await sourceFiles(root, join(root, SOURCES_DIR), findings);
    const actualSet = new Set(actualPaths);
    for (const path of actualPaths) {
      if (!(path in hashes)) findings.push(critical('source-hash-missing', 'Для source отсутствует versioned hash.', path));
      else if (sha256(await readFile(join(root, path))) !== hashes[path]) findings.push(critical('source-hash-mismatch', 'Source не совпадает с versioned hash.', path));
    }
    for (const path of Object.keys(hashes).sort()) {
      if (!actualSet.has(path)) findings.push(critical('source-hash-extra', 'Hash ссылается на отсутствующий source.', path));
    }
  } catch (cause) { findings.push(critical('source-hashes-invalid', `Metadata source hashes повреждён: ${cause instanceof Error ? cause.message : String(cause)}`, metadataPath)); }
}
