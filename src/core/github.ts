import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Закрытая копия проекта на GitHub через GitHub CLI (`gh`).
 *
 * Maestro не хранит токены и не ходит в сеть сам: всё делает `gh`, в который
 * человек уже вошёл. Любой сбой `gh` — не ошибка создания проекта: проект
 * остаётся на компьютере, человеку показывается команда на потом.
 */

export interface GhResult {
  /** Код выхода; null — процесс не завершился сам (таймаут) или не запустился. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `missing` — программы `gh` нет; `timeout` — не ответила вовремя. */
  failure?: 'missing' | 'timeout';
}

/** Запуск `gh`. Подменяется в тестах: на Windows поддельный `.cmd` без оболочки не запустить. */
export type GhRunner = (args: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<GhResult>;

/** Ответ на проверку входа не должен задерживать мастер дольше этого. */
export const GH_DETECT_TIMEOUT_MS = 3_000;
/** Создание репозитория и первая отправка идут по сети. */
export const GH_CREATE_TIMEOUT_MS = 120_000;

export const defaultGhRunner: GhRunner = (args, options) => new Promise((resolve) => {
  const child = execFile('gh', [...args], {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    // gh не задаёт вопросов и не проверяет обновления: ответить ему некому.
    // git внутри gh тоже не спрашивает логин в терминале: лучше быстрый понятный сбой, чем зависание.
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
  }, (error, stdout, stderr) => {
    if (error === null) { resolve({ code: 0, stdout, stderr }); return; }
    const cause = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
    if (cause.code === 'ENOENT') resolve({ code: null, stdout, stderr, failure: 'missing' });
    else if (cause.killed === true) resolve({ code: null, stdout, stderr, failure: 'timeout' });
    else resolve({ code: typeof cause.code === 'number' ? cause.code : 1, stdout, stderr });
  });
  child.stdin?.end();
});

/** Есть ли `gh` и выполнен ли в нём вход на github.com. Нет ответа за отведённое время — «нет». */
export async function githubReady(runner: GhRunner = defaultGhRunner, timeoutMs = GH_DETECT_TIMEOUT_MS): Promise<boolean> {
  try {
    const result = await runner(['auth', 'status', '--hostname', 'github.com'], { timeoutMs });
    return result.code === 0;
  } catch {
    return false;
  }
}

const TRANSLIT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

function transliterate(text: string): string {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const lower = char.toLowerCase();
    const latin = TRANSLIT[lower];
    if (latin === undefined) { out += char; continue; }
    out += char !== lower && latin !== '' ? latin[0]!.toUpperCase() + latin.slice(1) : latin;
  }
  return out;
}

/**
 * Имя репозитория — латиницей из названия папки: кириллица транслитерируется,
 * остальное, кроме букв, цифр, `.`, `_` и `-`, становится дефисом. Пустое имя —
 * `project-ГГГГММДД`.
 */
export function githubRepoName(folderName: string, now: Date = new Date()): string {
  const name = transliterate(folderName)
    .normalize('NFD').replace(/\p{Mark}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 100)
    .replace(/[-.]+$/g, '');
  return name === '' ? `project-${now.toISOString().slice(0, 10).replace(/-/g, '')}` : name;
}

export type GithubCopy =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Команда, которой человек заведёт копию сам, из папки проекта. */
export function githubCreateCommand(name: string): string {
  return `gh repo create ${name} --private --source . --remote origin --push`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '';
}

/** `gh repo create <имя> --private --source <папка> --remote origin --push` после первого коммита. */
export async function createGithubCopy(
  projectRoot: string,
  name: string,
  runner: GhRunner = defaultGhRunner,
  timeoutMs = GH_CREATE_TIMEOUT_MS,
): Promise<GithubCopy> {
  let result: GhResult;
  try {
    result = await runner(['repo', 'create', name, '--private', '--source', projectRoot, '--remote', 'origin', '--push'], { cwd: projectRoot, timeoutMs });
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (result.failure === 'missing') return { ok: false, reason: 'не найдена программа GitHub CLI (gh)' };
  if (result.failure === 'timeout') return { ok: false, reason: `gh не ответил за ${Math.round(timeoutMs / 1000)} с` };
  if (result.code !== 0) return { ok: false, reason: firstLine(result.stderr) || firstLine(result.stdout) || `gh завершился с кодом ${result.code}` };
  const url = /https:\/\/github\.com\/[^\s'"]+/.exec(`${result.stdout}\n${result.stderr}`)?.[0];
  if (url !== undefined) return { ok: true, url };
  // gh не напечатал адрес — берём тот, что он записал в remote.
  const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot, encoding: 'utf8' }).catch(() => null);
  return { ok: true, url: remote?.stdout.trim() || name };
}
