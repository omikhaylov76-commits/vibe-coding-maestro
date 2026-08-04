import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { critical, error } from './types.js';
import type { DoctorFinding } from './types.js';

const execFileAsync = promisify(execFile);

export interface PorcelainEntry { status: string; path: string; originalPath?: string }

/** Parse porcelain v1 `-z`; rename/copy records consume two NUL fields. */
export function parsePorcelainV1Z(output: string): PorcelainEntry[] {
  const fields = output.split('\0');
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const path = field.slice(3);
    const moved = status.includes('R') || status.includes('C');
    const originalPath = moved ? fields[++index] : undefined;
    entries.push({ status, path, ...(originalPath ? { originalPath } : {}) });
  }
  return entries;
}

export async function checkGit(root: string, managedDocs: Set<string>, findings: DoctorFinding[]): Promise<void> {
  if (!existsSync(join(root, '.git'))) return;
  try {
    const tracked = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    for (const path of tracked.stdout.split('\0').filter(Boolean).sort()) {
      const base = path.split('/').at(-1) ?? path;
      if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') findings.push(critical('git-env-tracked', 'Секретный env-файл отслеживается Git.', path));
    }
    const status = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    for (const entry of parsePorcelainV1Z(status.stdout)) {
      if (entry.status === '??') continue;
      const path = entry.path;
      if (managedDocs.has(path)) findings.push(error('git-managed-dirty', 'Управляемый документ имеет незакоммиченные изменения.', path));
    }
  } catch (cause) { findings.push(error('git-check-failed', `Не удалось проверить Git: ${cause instanceof Error ? cause.message : String(cause)}`, '.git')); }
}
