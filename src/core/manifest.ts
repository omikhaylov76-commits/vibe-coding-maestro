import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { CREATE_COMMAND, MANIFEST_SCHEMA_VERSION } from './meta.js';
import type { StartingPoint } from './meta.js';
import { canonicalManagedKind, canonicalOwnershipInventory } from './inventory.js';
import { readPackageJson } from './paths.js';

/** Служебный каталог проекта и пути внутри него (относительные, POSIX). */
export const MAESTRO_DIR = '.maestro';
export const MANIFEST_PATH = `${MAESTRO_DIR}/manifest.json`;
export const CHECKSUMS_PATH = `${MAESTRO_DIR}/checksums.json`;

/**
 * Вид файла с точки зрения владения:
 * - managed   — файл создаёт и восстанавливает инструмент (пока пользователь его не изменил);
 * - merged    — файл принадлежит пользователю, инструмент лишь дописывает нужные строки;
 * - generated — служебный файл инструмента (манифест, контрольные суммы).
 */
export type ManagedKind = 'managed' | 'merged' | 'generated';

/** Классификация любого пути в проекте: известные виды плюс пользовательский файл. */
export type FileClass = ManagedKind | 'user';
export const DEPTHS = ['light', 'standard', 'advanced'] as const;
export type ProjectDepth = (typeof DEPTHS)[number];
export type Ownership = 'managed' | 'generated' | 'project-owned' | 'immutable';
export interface InventoryEntry { path: string; ownership: Ownership }

export interface ManagedEntry {
  path: string;
  kind: ManagedKind;
}

export interface Manifest {
  schemaVersion: number;
  product: { name: string; version: string; createdBy: string };
  project: { id: string; name: string; startingPoint: StartingPoint; createdAt: string; depth: ProjectDepth };
  managed: ManagedEntry[];
  inventory: InventoryEntry[];
}

export interface Checksums {
  files: Record<string, string>;
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Расширения, которые считаются текстовыми для целей контрольных сумм.
 * Только эти файлы нормализуются по переводам строк.
 */
const TEXT_EXTENSIONS: readonly string[] = ['.md', '.json', '.yml', '.yaml', '.txt', '.gitkeep', '.gitattributes'];

export function isTextChecksumPath(relativePath: string): boolean {
  const posix = toPosixPath(relativePath);
  const base = posix.slice(posix.lastIndexOf('/') + 1);
  if (base === '.gitkeep' || base === '.gitattributes' || base === '.gitignore') return true;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return TEXT_EXTENSIONS.includes(base.slice(dot).toLowerCase());
}

/**
 * Приводит переводы строк к LF. Нужно, чтобы CRLF-рабочая копия на Windows
 * не выглядела как изменённый пользователем файл.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Единая контрольная сумма содержимого с учётом вида файла.
 * Текст сравнивается по LF-нормализованному виду, бинарные данные — побайтово.
 */
export function contentChecksum(relativePath: string, data: Buffer | string): string {
  if (!isTextChecksumPath(relativePath)) {
    return sha256(data);
  }
  const text = typeof data === 'string' ? data : data.toString('utf8');
  return sha256(normalizeEol(text));
}

/** Пути в манифесте всегда POSIX, чтобы проект переносился между ОС. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(sep).join('/');
}

/** Единый вид JSON на диске: 2 пробела и завершающий перевод строки, без BOM. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface BuildManifestInput {
  projectName: string;
  startingPoint: StartingPoint;
  createdAt: string;
  productName: string;
  productVersion: string;
  createdBy: string;
  managed: readonly ManagedEntry[];
  projectId?: string;
  depth?: ProjectDepth;
  inventory: readonly InventoryEntry[];
}

export function buildManifest(input: BuildManifestInput): Manifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: {
      name: input.productName,
      version: input.productVersion,
      createdBy: input.createdBy,
    },
    project: {
      id: input.projectId ?? randomUUID(),
      name: input.projectName,
      startingPoint: input.startingPoint,
      createdAt: input.createdAt,
      depth: input.depth ?? 'standard',
    },
    managed: input.managed.map((entry) => ({ path: entry.path, kind: entry.kind })),
    inventory: input.inventory.map((entry) => ({ path: entry.path, ownership: entry.ownership })),
  };
}

export function isSafeProjectPath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.startsWith('/')) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && parts[0] !== '.git';
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key);
}

export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ['schemaVersion', 'product', 'project', 'managed', 'inventory'])) return false;
  if (candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(candidate.managed) || candidate.managed.length === 0) return false;
  const product = candidate.product;
  const project = candidate.project;
  if (typeof product !== 'object' || product === null || Array.isArray(product) || !exactKeys(product as Record<string, unknown>, ['name', 'version', 'createdBy'])) return false;
  if (typeof project !== 'object' || project === null || Array.isArray(project) || !exactKeys(project as Record<string, unknown>, ['id', 'name', 'startingPoint', 'createdAt', 'depth'])) return false;
  const p = product as Record<string, unknown>;
  const j = project as Record<string, unknown>;
  if (![p.name, p.version, p.createdBy, j.name, j.createdAt].every((item) => typeof item === 'string' && item.length > 0)) return false;
  if (!['idea', 'materials', 'spec', 'code'].includes(String(j.startingPoint))) return false;
  if (typeof j.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(j.id)) return false;
  if (!DEPTHS.includes(j.depth as ProjectDepth)) return false;
  const seen = new Set<string>();
  const managedValid = candidate.managed.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || !exactKeys(item as Record<string, unknown>, ['path', 'kind'])) return false;
    const entry = item as Record<string, unknown>;
    if (!isSafeProjectPath(entry.path) || !['managed', 'merged', 'generated'].includes(String(entry.kind)) || seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  });
  if (!managedValid || !Array.isArray(candidate.inventory) || candidate.inventory.length === 0) return false;
  const inventorySeen = new Set<string>();
  return candidate.inventory.every((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item) || !exactKeys(item as Record<string, unknown>, ['path', 'ownership'])) return false;
    const entry = item as Record<string, unknown>;
    if (!isSafeProjectPath(entry.path) || !['managed', 'generated', 'project-owned', 'immutable'].includes(String(entry.ownership)) || inventorySeen.has(String(entry.path))) return false;
    inventorySeen.add(String(entry.path));
    return true;
  });
}

export function isCanonicalManifest(manifest: Manifest): boolean {
  const expectedInventory = canonicalOwnershipInventory(manifest.project.depth);
  if (manifest.product.name !== readPackageJson().name || manifest.product.createdBy !== CREATE_COMMAND) return false;
  if (manifest.inventory.length !== Object.keys(expectedInventory).length || manifest.managed.length !== Object.keys(expectedInventory).length) return false;

  const inventory = new Map(manifest.inventory.map((entry) => [entry.path, entry.ownership]));
  const managed = new Map(manifest.managed.map((entry) => [entry.path, entry.kind]));
  return Object.entries(expectedInventory).every(([path, ownership]) =>
    inventory.get(path) === ownership && managed.get(path) === canonicalManagedKind(path, ownership));
}

export async function loadManifest(root: string): Promise<Manifest> {
  const raw = await readFile(join(root, MANIFEST_PATH), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isManifest(parsed)) {
    throw new Error(`Повреждён манифест проекта: ${join(root, MANIFEST_PATH)}`);
  }
  return parsed;
}

/** Мягкое чтение: отсутствующий или нечитаемый манифест — это просто «не наш проект». */
export async function tryLoadManifest(root: string): Promise<Manifest | null> {
  try {
    return await loadManifest(root);
  } catch {
    return null;
  }
}

export async function loadChecksums(root: string): Promise<Checksums | null> {
  try {
    const raw = await readFile(join(root, CHECKSUMS_PATH), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !exactKeys(parsed as Record<string, unknown>, ['files'])) return null;
    const files = (parsed as { files?: unknown }).files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
    if (!Object.entries(files as Record<string, unknown>).every(([path, hash]) => isSafeProjectPath(path) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) return null;
    return { files: files as Record<string, string> };
  } catch {
    return null;
  }
}

export async function writeManifest(root: string, manifest: Manifest): Promise<void> {
  await writeFile(join(root, MANIFEST_PATH), serializeJson(manifest), 'utf8');
}

/** Ключи сортируются, чтобы повторный init давал побайтово тот же файл. */
export async function writeChecksums(root: string, files: Record<string, string>): Promise<void> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) {
    const value = files[key];
    if (value !== undefined) sorted[key] = value;
  }
  await writeFile(join(root, CHECKSUMS_PATH), serializeJson({ files: sorted }), 'utf8');
}

/**
 * Определяет вид файла по манифесту.
 * Сравнение точное, по пути: файл пользователя внутри managed-каталога остаётся пользовательским.
 */
export function classifyFile(manifest: Manifest, relativePath: string): FileClass {
  const needle = toPosixPath(relativePath);
  const entry = manifest.managed.find((item) => item.path === needle);
  return entry === undefined ? 'user' : entry.kind;
}
