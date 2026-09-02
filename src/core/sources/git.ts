/**
 * Чтение Git-метаданных существующего исходника (Planning Gate, Phase 4).
 *
 * Запускаются только локальные read-only команды. Сеть исключена, необязательные
 * блокировки выключены (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`), поэтому
 * даже обновление индекса чужого репозитория невозможно. Любая ошибка Git — это
 * «неизвестно», а не догадка: недоступная информация остаётся `null`.
 */

import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { compareText } from './model.js';
import type { SourceGit, SourceGitRemote } from './model.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/** Окружение без интерактивности, без сети по подсказке и без необязательных блокировок. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
};

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>;

export const systemGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
    });
    return stdout;
  } catch {
    return null;
  }
};

const LOCAL_PATH = /^(\.{0,2}[/\\]|~|\\\\)/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const SCP_LIKE = /^([^@/\s]+)@([^:/\s]+):(.+)$/;
const NETWORK_PROTOCOLS: readonly string[] = ['http:', 'https:', 'ssh:', 'git:', 'ftp:', 'ftps:'];

/**
 * Приводит remote URL к безопасному для публикации виду.
 *
 * Из URL удаляются учётные данные, query и fragment: токен в remote — обычная
 * практика, и он не должен попасть в файл проекта. Локальный путь публикуется как
 * «опущен»: он раскрывает раскладку машины и не переносим.
 */
export function sanitizeRemoteUrl(raw: string): Omit<SourceGitRemote, 'name'> {
  const value = raw.trim();
  if (value === '') return { url: null, sanitized: false, omitted: 'unparsable' };
  if (LOCAL_PATH.test(value) || WINDOWS_DRIVE.test(value) || value.startsWith('file://')) {
    return { url: null, sanitized: false, omitted: 'local-path' };
  }
  try {
    const parsed = new URL(value);
    if (NETWORK_PROTOCOLS.includes(parsed.protocol)) {
      const carriedSecret = parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '';
      return { url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`, sanitized: carriedSecret, omitted: null };
    }
  } catch {
    // Не URL: ниже разбирается scp-подобная форма user@host:path.
  }
  const scp = SCP_LIKE.exec(value);
  if (scp !== null) return { url: `${scp[2]}:${scp[3]}`, sanitized: true, omitted: null };
  return { url: null, sanitized: false, omitted: 'unparsable' };
}

function parseRemotes(config: string | null): SourceGitRemote[] {
  if (config === null) return [];
  const remotes: SourceGitRemote[] = [];
  for (const line of config.split('\n')) {
    const match = /^remote\.(.+)\.url\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    remotes.push({ name: match[1] as string, ...sanitizeRemoteUrl(match[2] as string) });
  }
  return remotes.sort((left, right) => compareText(left.name, right.name));
}

const NOT_A_REPO: SourceGit = {
  isRepo: false, rootDescriptor: null, rootIsAncestor: false,
  branch: null, head: null, dirty: null, remotes: [], nestedRepos: [],
};

/** Собирает Git-метаданные источника; ничего не пишет и не обращается к сети. */
export async function readGitMetadata(root: string, nestedRepos: readonly string[], git: GitRunner = systemGit): Promise<SourceGit> {
  const toplevel = await git(['rev-parse', '--show-toplevel'], root);
  if (toplevel === null || toplevel.trim() === '') return { ...NOT_A_REPO, nestedRepos: [...nestedRepos] };

  const gitRoot = toplevel.trim();
  let rootIsAncestor = false;
  let rootDescriptor = '.';
  try {
    const [realRoot, realSource] = [await realpath(gitRoot), await realpath(root)];
    rootIsAncestor = realRoot !== realSource;
    const rawDescriptor = relative(realSource, realRoot).split(sep).join('/');
    rootDescriptor = rawDescriptor === '' ? '.' : rawDescriptor;
  } catch {
    rootIsAncestor = false;
  }

  const branchRaw = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root))?.trim() ?? '';
  const headRaw = (await git(['rev-parse', 'HEAD'], root))?.trim() ?? '';
  const status = await git(['status', '--porcelain=v1', '--untracked-files=normal'], root);

  return {
    isRepo: true,
    rootDescriptor,
    rootIsAncestor,
    branch: branchRaw === '' || branchRaw === 'HEAD' ? null : branchRaw,
    head: /^[0-9a-f]{40}$/.test(headRaw) ? headRaw : null,
    dirty: status === null ? null : status.trim() !== '',
    remotes: parseRemotes(await git(['config', '--get-regexp', '^remote\\..*\\.url'], root)),
    nestedRepos: [...nestedRepos],
  };
}
