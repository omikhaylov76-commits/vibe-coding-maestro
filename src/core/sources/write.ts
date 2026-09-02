/**
 * Запись снимка инвентаризации в канонический проект (Planning Gate, Phase 4).
 *
 * Запись — исключение, а не режим по умолчанию, поэтому она обставлена четырьмя
 * границами: проект должен быть каноническим, путь — принадлежать `maestro/sources/`,
 * существующий артефакт не перезаписывается молча, а сама запись атомарна.
 * Проверки выполняются до первой операции записи: отказ обязан оставить дерево
 * проекта побайтово прежним.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { absolutePathHasSymlink, pathHasSymlink } from '../doctor/fs-utils.js';
import { isCanonicalManifest, isSafeProjectPath, serializeJson, sha256, tryLoadManifest } from '../manifest.js';
import { SERVICE_COMMAND, VERSION } from '../meta.js';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { SOURCES_DIR, SOURCE_HASHES_PATH } from './contract.js';
import { compareText, finding } from './model.js';
import type { HumanIntent, SourceFinding, SourceInventoryArtifact, SourceInventoryReport } from './model.js';

export const ARTIFACT_ID = 'vibe-maestro-source-inventory';
export const DEFAULT_OUTPUT_PATH = `${SOURCES_DIR}/source-inventory.json`;

export interface WriteRequest {
  projectPath: string;
  output?: string;
  replace?: boolean;
  /** Часы передаются снаружи: артефакт обязан быть воспроизводим в тестах. */
  generatedAt: string;
}

export interface WriteResult {
  ok: boolean;
  /** Project-relative путь артефакта; null, если запись не выполнена. */
  path: string | null;
  sha256: string | null;
  replaced: boolean;
  findings: SourceFinding[];
}

interface SourceHashes { files: Record<string, string> }

const failure = (findings: SourceFinding[]): WriteResult => ({ ok: false, path: null, sha256: null, replaced: false, findings });

/**
 * Артефакт хранит только переносимые данные.
 *
 * Абсолютные пути сюда не попадают: снимок должен читаться на другой машине и в
 * другом клоне проекта так же, как здесь.
 */
export function buildArtifact(report: SourceInventoryReport, provenance: {
  generatedAt: string;
  humanIntent: HumanIntent;
  replaces: string | null;
}): SourceInventoryArtifact {
  return {
    artifact: ARTIFACT_ID,
    artifactVersion: 1,
    provenance: {
      tool: SERVICE_COMMAND,
      version: VERSION,
      generatedAt: provenance.generatedAt,
      humanIntent: provenance.humanIntent,
      replaces: provenance.replaces,
      inputs: [...new Set(report.sources.map((record) => record.origin.descriptor))].sort(compareText),
    },
    report,
  };
}

/** Путь артефакта: только внутрь `maestro/sources/` и только JSON. */
export function isAllowedOutputPath(path: string): boolean {
  if (!isSafeProjectPath(path) || !path.startsWith(`${SOURCES_DIR}/`) || !path.endsWith('.json')) return false;
  const name = basename(path);
  return name !== '.json' && !name.startsWith('.');
}

function parseSourceHashes(raw: string): SourceHashes | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || Object.keys(parsed).join() !== 'files') return null;
    const files = (parsed as { files: unknown }).files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
    const entries = Object.entries(files as Record<string, unknown>);
    const valid = entries.every(([path, hash]) =>
      isSafeProjectPath(path) && path.startsWith(`${SOURCES_DIR}/`) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
    return valid ? { files: files as Record<string, string> } : null;
  } catch {
    return null;
  }
}

/** Атомарная запись: временный файл в том же каталоге и rename поверх цели. */
async function atomicWrite(absolute: string, data: Buffer): Promise<void> {
  const temporary = join(dirname(absolute), `.${basename(absolute)}.tmp`);
  try {
    await writeFile(temporary, data);
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Записывает снимок в канонический проект.
 *
 * Возвращает результат вместо исключения: отказ — обычный, ожидаемый исход,
 * который CLI обязан показать человеку вместе с причиной.
 */
export async function writeSourceInventory(report: SourceInventoryReport, request: WriteRequest): Promise<WriteResult> {
  const root = await canonicalizeSystemTempPrefix(resolve(request.projectPath));
  const output = request.output ?? DEFAULT_OUTPUT_PATH;

  if (await absolutePathHasSymlink(root)) {
    return failure([finding('error', 'write-project-symlink', 'Путь к корню проекта содержит symbolic link: запись не выполняется.')]);
  }
  const manifest = await tryLoadManifest(root);
  if (manifest === null || !isCanonicalManifest(manifest) || manifest.project.name !== basename(root)) {
    return failure([finding('error', 'write-not-canonical-project', 'Целевой путь не является каноническим проектом Maestro: артефакт некуда положить.')]);
  }
  if (!isAllowedOutputPath(output)) {
    return failure([finding('error', 'write-output-not-allowed', `Артефакт разрешено писать только в ${SOURCES_DIR}/ и только как *.json.`)]);
  }
  if (await pathHasSymlink(root, output)) {
    return failure([finding('error', 'write-output-symlink', 'Путь артефакта содержит symbolic link: запись не выполняется.')]);
  }

  const hashesAbsolute = join(root, SOURCE_HASHES_PATH);
  let hashes: SourceHashes = { files: {} };
  if (existsSync(hashesAbsolute)) {
    if (await pathHasSymlink(root, SOURCE_HASHES_PATH)) {
      return failure([finding('error', 'write-hashes-symlink', 'Metadata source hashes содержит symbolic link: запись не выполняется.')]);
    }
    const parsed = parseSourceHashes(await readFile(hashesAbsolute, 'utf8'));
    if (parsed === null) {
      return failure([finding('error', 'write-hashes-invalid', `Metadata ${SOURCE_HASHES_PATH} повреждён: сначала запустите doctor.`)]);
    }
    hashes = parsed;
  }

  const absolute = join(root, output);
  let replaces: string | null = null;
  if (existsSync(absolute)) {
    if (!(await lstat(absolute)).isFile()) {
      return failure([finding('error', 'write-output-not-allowed', 'По пути артефакта находится не обычный файл.')]);
    }
    const previous = await readFile(absolute);
    if (request.replace !== true) {
      return failure([finding('error', 'write-output-exists', `Артефакт уже существует: ${output}. Замена выполняется только с явным --replace.`)]);
    }
    let previousArtifact: unknown;
    try {
      previousArtifact = JSON.parse(previous.toString('utf8'));
    } catch {
      previousArtifact = null;
    }
    const isOwn = typeof previousArtifact === 'object' && previousArtifact !== null
      && (previousArtifact as { artifact?: unknown }).artifact === ARTIFACT_ID;
    if (!isOwn) {
      return failure([finding('error', 'write-output-foreign', `Файл ${output} создан не этой командой: замена не выполняется.`)]);
    }
    replaces = sha256(previous);
  }

  const intent: HumanIntent = replaces === null ? 'create' : 'replace';
  const data = Buffer.from(serializeJson(buildArtifact(report, { generatedAt: request.generatedAt, humanIntent: intent, replaces })), 'utf8');
  const digest = sha256(data);

  await mkdir(dirname(absolute), { recursive: true });
  await atomicWrite(absolute, data);

  hashes.files[output] = digest;
  const sortedFiles: Record<string, string> = {};
  for (const key of Object.keys(hashes.files).sort(compareText)) sortedFiles[key] = hashes.files[key] as string;
  await atomicWrite(hashesAbsolute, Buffer.from(serializeJson({ files: sortedFiles }), 'utf8'));

  return {
    ok: true,
    path: output,
    sha256: digest,
    replaced: replaces !== null,
    findings: [finding('info', 'write-ok', `Снимок записан: ${output}; versioned hash обновлён в ${SOURCE_HASHES_PATH}.`)],
  };
}
