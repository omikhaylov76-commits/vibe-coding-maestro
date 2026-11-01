import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { critical, error, info, warning } from './types.js';
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

export async function checkGit(root: string, managedDocs: Set<string>, findings: DoctorFinding[], managedFiles: ReadonlySet<string> = new Set()): Promise<void> {
  if (!existsSync(join(root, '.git'))) return;
  try {
    const tracked = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    for (const path of tracked.stdout.split('\0').filter(Boolean).sort()) {
      const base = path.split('/').at(-1) ?? path;
      if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') findings.push(critical('git-env-tracked', 'Секретный env-файл отслеживается Git.', path));
    }
    const status = await execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    for (const entry of parsePorcelainV1Z(status.stdout)) {
      const path = entry.path;
      if (entry.status === '??') {
        // Файл Maestro, которого нет в Git, не попадёт в клон: проект там будет без него.
        // Предупреждение, а не ошибка: create в уже существующий репозиторий законно оставляет файлы неиндексированными.
        if (managedFiles.has(path)) findings.push(warning('git-managed-untracked', 'Файл Maestro не добавлен в Git: в клоне проекта его не будет. Добавьте его (git add) и закоммитьте.', path));
        continue;
      }
      if (managedDocs.has(path)) findings.push(error('git-managed-dirty', 'Управляемый документ имеет незакоммиченные изменения. Если это результат upgrade — просмотрите diff и закоммитьте; если правка ручная — верните файл.', path));
    }
    await checkCloudCopy(root, findings);
  } catch (cause) { findings.push(error('git-check-failed', `Не удалось проверить Git: ${cause instanceof Error ? cause.message : String(cause)}`, '.git')); }
}

/** Команда git, чей отказ — ответ «нет», а не сбой проверки. */
async function gitAnswer(root: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await execFileAsync('git', [...args], { cwd: root, encoding: 'utf8' })).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Есть ли копия в облаке — только по локальным данным git, без сети: `git fetch` не
 * запускается, поэтому «отправлено» значит «по данным последней синхронизации».
 * Уровень `info`: не красит ни обычную проверку, ни `--strict`, ни `preflight` —
 * проект может сознательно жить только на компьютере.
 */
async function checkCloudCopy(root: string, findings: DoctorFinding[]): Promise<void> {
  const remotes = await gitAnswer(root, ['remote']);
  if (remotes === null) return;
  if (remotes === '') {
    findings.push(info('git-no-remote', 'Копии проекта в облаке нет: у репозитория нет remote. Если этот компьютер пропадёт, проект не восстановить. Завести закрытую копию поможет `/start`.'));
    return;
  }
  // Ветка без коммитов или detached HEAD: отправлять пока нечего или некуда.
  const branch = await gitAnswer(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch === null || branch === '' || await gitAnswer(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) === null) return;
  const upstream = await gitAnswer(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream === null || upstream === '') {
    const names = remotes.split(/\r?\n/).filter(Boolean);
    const remote = names.includes('origin') ? 'origin' : names[0] ?? 'origin';
    findings.push(info('git-no-upstream', `Ветка ${branch} ещё не связана с копией в облаке (upstream), по данным последней синхронизации. Первая отправка: git push -u ${remote} ${branch}.`));
    return;
  }
  const ahead = Number(await gitAnswer(root, ['rev-list', '--count', '@{u}..HEAD']));
  if (Number.isInteger(ahead) && ahead > 0) {
    findings.push(info('git-unpushed', `Коммитов, не отправленных в облако (${upstream}): ${ahead} — по данным последней синхронизации, без запроса в сеть. Отправка: git push.`));
  }
}
