import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const tracked: string[] = [];

/** Временная папка; префикс позволяет проверять пробелы и кириллицу в путях. */
export async function makeTempDir(prefix = 'vcm-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tracked.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function walk(root: string, current: string, acc: string[], skipGit: boolean): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (skipGit && entry.isDirectory() && entry.name === '.git') continue;
    if (entry.isDirectory()) {
      await walk(root, full, acc, skipGit);
    } else {
      acc.push(relative(root, full).split(sep).join('/'));
    }
  }
}

/** Все файлы проекта относительными POSIX-путями, отсортированные. */
export async function listFiles(root: string, options: { includeGit?: boolean } = {}): Promise<string[]> {
  const acc: string[] = [];
  await walk(root, root, acc, options.includeGit !== true);
  return acc.sort();
}

/** Снимок «путь → sha256» для побайтового сравнения до/после. */
export async function snapshotTree(root: string): Promise<Record<string, string>> {
  const files = await listFiles(root);
  const snapshot: Record<string, string> = {};
  for (const rel of files) {
    snapshot[rel] = sha256(await readFile(join(root, rel)));
  }
  return snapshot;
}

export async function readUtf8(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), 'utf8');
}

export async function readJson<T>(root: string, rel: string): Promise<T> {
  return JSON.parse(await readFile(join(root, rel), 'utf8')) as T;
}

export async function isDir(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  return (await stat(path)).isDirectory();
}

export const FIXED_NOW = new Date('2026-08-02T10:00:00.000Z');
export const FIXED_DATE = '2026-08-02';
