import { existsSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Размер текущей сессии Claude Code по её журналу `~/.claude/projects/<папка>/<сессия>.jsonl`.
 *
 * Читаются только числа из `message.usage` ответов модели: текст переписки не
 * разбирается и не печатается. Каждый шаг сессии заново отправляет модели всю
 * историю, поэтому длинная сессия дорожает с каждым шагом.
 */

/** Сколько токенов считать «полной» сессией по умолчанию. */
export const DEFAULT_BUDGET = 200_000;
/** HYPOTHESIS: пороги подобраны на глаз и уточняются повторным замером. */
export const FINISH_SLICE_SHARE = 0.4;
export const NEW_SESSION_SHARE = 0.7;

export type ContextLevel = 'continue' | 'finish-slice' | 'new-session';

export interface ContextReport {
  reportVersion: 1;
  ok: boolean;
  message?: string;
  transcript?: string;
  sessionId?: string;
  /** Контекст последнего ответа модели: вход (с кешем) плюс выход. */
  contextTokens?: number;
  budget: number;
  percent?: number;
  level?: ContextLevel;
  /** Сколько токенов модель получила на входе за всю сессию. */
  totalInputTokens?: number;
  requests?: number;
}

export interface ContextOptions {
  root: string;
  /** Папка настроек Claude Code; по умолчанию `$CLAUDE_CONFIG_DIR` или `~/.claude`. */
  claudeDir?: string;
  budget?: number;
  /** Сессия Claude Code; по умолчанию `$CLAUDE_CODE_SESSION_ID`, которую Claude Code передаёт командам. */
  sessionId?: string;
}

/** Имя папки журналов: Claude Code заменяет в пути проекта всё, кроме латиницы и цифр, на `-`. */
export function projectLogDirName(root: string): string {
  return resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
}

async function newestJsonl(dir: string): Promise<string | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(dir, name);
    const { mtimeMs } = await stat(path);
    if (best === null || mtimeMs > best.mtime || (mtimeMs === best.mtime && path > best.path)) best = { path, mtime: mtimeMs };
  }
  return best?.path ?? null;
}

async function tail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Журнал текущей сессии. Известен id сессии — её файл `<id>.jsonl`. Иначе самый
 * свежий журнал в папке проекта. Длинные и не-латинские пути Claude Code может
 * назвать иначе, поэтому запасной путь — самый свежий журнал с той же рабочей папкой.
 */
export async function findTranscript(root: string, claudeDir: string, sessionId?: string): Promise<string | null> {
  const projects = join(claudeDir, 'projects');
  if (sessionId !== undefined && /^[A-Za-z0-9-]+$/.test(sessionId)) {
    const own = join(projects, projectLogDirName(root), `${sessionId}.jsonl`);
    if (existsSync(own)) return own;
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const candidate = join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }
  const direct = await newestJsonl(join(projects, projectLogDirName(root)));
  if (direct !== null) return direct;
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return null;
  }
  const marker = `"cwd":${JSON.stringify(resolve(root))}`;
  let best: { path: string; mtime: number } | null = null;
  for (const dir of dirs) {
    const candidate = await newestJsonl(join(projects, dir));
    if (candidate === null) continue;
    if (!(await tail(candidate, 256 * 1024)).includes(marker)) continue;
    const { mtimeMs } = await stat(candidate);
    if (best === null || mtimeMs > best.mtime) best = { path: candidate, mtime: mtimeMs };
  }
  return best?.path ?? null;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

export function levelFor(share: number): ContextLevel {
  if (share >= NEW_SESSION_SHARE) return 'new-session';
  if (share >= FINISH_SLICE_SHARE) return 'finish-slice';
  return 'continue';
}

export async function measureContext(options: ContextOptions): Promise<ContextReport> {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const claudeDir = options.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const transcript = await findTranscript(options.root, claudeDir, options.sessionId ?? (process.env.CLAUDE_CODE_SESSION_ID || undefined));
  if (transcript === null) {
    return { reportVersion: 1, ok: false, budget, message: `Журнал сессии Claude Code для этой папки не найден (искал в ${join(claudeDir, 'projects')}). Команда работает внутри сессии Claude Code, открытой в папке проекта.` };
  }

  const seen = new Set<string>();
  let last: Usage | null = null;
  let totalInput = 0;
  let sessionId: string | undefined;
  for (const line of (await readFile(transcript, 'utf8')).split('\n')) {
    if (line.trim() === '') continue;
    let entry: { type?: unknown; isSidechain?: unknown; sessionId?: unknown; message?: { id?: unknown; usage?: Usage } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // незаконченная последняя строка, пока сессия пишет журнал
    }
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue;
    const usage = entry.message?.usage;
    const id = entry.message?.id;
    if (usage === undefined || typeof id !== 'string') continue;
    if (typeof entry.sessionId === 'string') sessionId = entry.sessionId;
    last = usage;
    if (seen.has(id)) continue;
    seen.add(id);
    totalInput += count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
  }
  if (last === null) {
    return { reportVersion: 1, ok: false, budget, transcript, message: 'В журнале сессии пока нет ни одного ответа модели.' };
  }
  const contextTokens = count(last.input_tokens) + count(last.cache_read_input_tokens) + count(last.cache_creation_input_tokens) + count(last.output_tokens);
  const share = contextTokens / budget;
  return {
    reportVersion: 1,
    ok: true,
    transcript,
    ...(sessionId === undefined ? {} : { sessionId }),
    contextTokens,
    budget,
    percent: Math.round(share * 100),
    level: levelFor(share),
    totalInputTokens: totalInput,
    requests: seen.size,
  };
}
