import { createInterface } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { StartingPoint } from '../core/meta.js';
import { resolveProjectInput, runtimeDesktopOptions } from './desktop.js';
import { createRenderer, runtimeRendererOptions, type CliRenderer } from './renderer.js';

export type InteractiveAction = 'create' | 'check';
export type InteractiveAnswers =
  | { action: 'create'; target: string; name: string; startingPoint: StartingPoint; usedDesktopDefault: boolean }
  | { action: 'check'; target: string };

export interface PromptAdapter {
  ask(): Promise<InteractiveAnswers>;
  renderer?: CliRenderer;
}

/**
 * Возможности терминала для интерактивного ввода.
 * cursorRedraw — можно ли двигать курсор и очищать строки (ESC-последовательности).
 */
export interface PromptCapabilities {
  cursorRedraw: boolean;
  unicode: boolean;
}

/** Минимальная ширина, при которой перерисовка меню по фиксированному числу строк безопасна. */
const MIN_REDRAW_COLUMNS = 60;

const CANCELLED = 'Ввод отменён. Файлы не изменены.';
const CLOSED = 'Ввод прерван: поток ввода закрыт. Файлы не изменены.';

/**
 * NO_COLOR, TERM=dumb, узкий или неинтерактивный вывод отключают любое управление курсором:
 * в этих режимах меню печатается один раз простым нумерованным списком.
 */
export function promptCapabilities(
  output: { isTTY?: boolean; columns?: number },
  env: Record<string, string | undefined>,
): PromptCapabilities {
  const noColor = Object.prototype.hasOwnProperty.call(env, 'NO_COLOR');
  const dumb = env.TERM === 'dumb';
  const columns = output.columns && output.columns > 0 ? output.columns : 80;
  return {
    cursorRedraw: Boolean(output.isTTY) && !noColor && !dumb && columns >= MIN_REDRAW_COLUMNS,
    unicode: !dumb,
  };
}

interface Choice<T extends string> { value: T; label: string }

type ListenerSnapshot = Map<string | symbol, Function[]>;

function snapshotListeners(input: ReadStream): ListenerSnapshot {
  return new Map(input.eventNames().map((event) => [event, input.rawListeners(event)]));
}

/** Remove only listeners added after the snapshot; preserve pre-existing listeners. */
function restoreListeners(input: ReadStream, before: ListenerSnapshot): void {
  for (const event of input.eventNames()) {
    const baseline = [...(before.get(event) ?? [])];
    for (const listener of input.rawListeners(event)) {
      const index = baseline.indexOf(listener);
      if (index >= 0) baseline.splice(index, 1);
      else {
        try { input.removeListener(event, listener as (...args: unknown[]) => void); } catch { /* stream may be closed */ }
      }
    }
  }
}

export function selectChoice<T extends string>(
  input: ReadStream,
  output: WriteStream,
  renderer: CliRenderer,
  title: string,
  choices: readonly Choice<T>[],
  capabilities: PromptCapabilities,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const listenersBefore = snapshotListeners(input);
    const initialRaw = Boolean(input.isRaw);
    let settled = false;
    let index = 0;
    let drawn = 0;

    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (text.includes('\x03')) return settle(undefined, new Error(CANCELLED));
      if (text === '\x1b[A') index = (index - 1 + choices.length) % choices.length;
      else if (text === '\x1b[B') index = (index + 1) % choices.length;
      else if (text === '\r' || text === '\n') return settle(choices[index]?.value);
      else if (/^[1-9]$/.test(text)) {
        const numeric = Number(text) - 1;
        if (numeric < choices.length) return settle(choices[numeric]?.value);
        return;
      } else return;
      draw(false);
    };
    const onEnd = (): void => settle(undefined, new Error(CLOSED));
    const onStreamError = (error: unknown): void =>
      settle(undefined, new Error(`Не удалось прочитать ввод: ${error instanceof Error ? error.message : String(error)}`));

    /** Идempotentная очистка: снимает все обработчики и всегда пытается вернуть исходный raw-режим. */
    const cleanup = (): void => {
      try { input.off('data', onData); } catch { /* поток мог быть уничтожен */ }
      try { input.off('error', onStreamError); } catch { /* см. выше */ }
      try { input.off('end', onEnd); } catch { /* см. выше */ }
      try { input.off('close', onEnd); } catch { /* см. выше */ }
      try { input.setRawMode(initialRaw); } catch { /* raw-режим может быть недоступен */ }
      try { input.pause(); } catch { /* поток мог быть уничтожен */ }
      restoreListeners(input, listenersBefore);
    };

    const settle = (value?: T, error?: Error): void => {
      if (settled) return;
      settled = true;
      try { cleanup(); } finally { if (error) reject(error); else resolve(value as T); }
    };

    const draw = (first: boolean): void => {
      if (!capabilities.cursorRedraw) {
        if (first) {
          for (let i = 0; i < choices.length; i += 1) output.write(`  ${i + 1}. ${choices[i]?.label}\n`);
        } else {
          output.write(`  Выбрано: ${index + 1}. ${choices[index]?.label}\n`);
        }
        return;
      }
      if (!first && drawn > 0) output.write(`\x1b[${drawn}A`);
      drawn = choices.length;
      for (let i = 0; i < choices.length; i += 1) {
        const marker = i === index ? renderer.accent('❯') : ' ';
        output.write(`\x1b[2K${marker} ${i + 1}. ${choices[i]?.label}\n`);
      }
    };

    try {
      const hint = capabilities.cursorRedraw
        ? '↑/↓ — выбрать, Enter — продолжить; также можно нажать цифру.'
        : 'Нажмите цифру нужного пункта и Enter, либо Enter для первого пункта.';
      output.write(`\n${renderer.accent(title)}\n${renderer.muted(hint)}\n`);
      try { input.setRawMode(true); } catch { /* без raw-режима остаётся строчный ввод */ }
      input.resume();
      input.on('data', onData);
      input.on('error', onStreamError);
      input.on('end', onEnd);
      input.on('close', onEnd);
      draw(true);
    } catch (error) {
      onStreamError(error);
    }
  });
}

export async function askLine(
  input: ReadStream,
  output: WriteStream,
  renderer: CliRenderer,
  question: string,
  hint: string,
  capabilities: PromptCapabilities = promptCapabilities(output, process.env),
): Promise<string> {
  const listenersBefore = snapshotListeners(input);
  let rl: ReturnType<typeof createInterface>;
  try {
    input.resume();
    rl = createInterface({ input, output, terminal: capabilities.cursorRedraw });
  } catch (error) {
    restoreListeners(input, listenersBefore);
    throw error;
  }

  let abort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_, rejectAbort) => { abort = rejectAbort; });
  aborted.catch(() => { /* гарантия отсутствия unhandled rejection */ });

  let settled = false;
  const fail = (error: Error): void => { if (!settled) { settled = true; abort?.(error); } };
  const onSigint = (): void => fail(new Error(CANCELLED));
  const onClose = (): void => fail(new Error(CLOSED));
  const onStreamError = (error: unknown): void =>
    fail(new Error(`Не удалось прочитать ввод: ${error instanceof Error ? error.message : String(error)}`));
  /** Ctrl+C виден как байт 0x03, если readline работает без terminal-режима. */
  const onData = (chunk: Buffer | string): void => { if (chunk.toString().includes('\x03')) onSigint(); };

  const cleanup = (): void => {
    try { rl.off('SIGINT', onSigint); } catch { /* интерфейс уже закрыт */ }
    try { rl.off('close', onClose); } catch { /* см. выше */ }
    try { rl.off('error', onStreamError); } catch { /* см. выше */ }
    try { input.off('error', onStreamError); } catch { /* см. выше */ }
    try { input.off('close', onClose); } catch { /* см. выше */ }
    try { input.off('data', onData); } catch { /* см. выше */ }
  };

  rl.on('SIGINT', onSigint);
  rl.on('close', onClose);
  rl.on('error', onStreamError);
  input.on('error', onStreamError);
  input.on('close', onClose);
  input.on('data', onData);

  try {
    output.write(`\n${renderer.accent(question)}\n${renderer.muted(hint)}\n`);
    while (true) {
      const raw = await Promise.race([
        aborted,
        new Promise<string>((resolveLine) => rl.question('> ', resolveLine)),
      ]);
      if (raw.trim()) { settled = true; return raw; }
      output.write('Введите название проекта или путь.\n');
    }
  } finally {
    cleanup();
    rl.close();
    restoreListeners(input, listenersBefore);
  }
}

export function createReadlinePrompt(input: ReadStream = process.stdin as ReadStream, output: WriteStream = process.stdout as WriteStream): PromptAdapter {
  const renderer = createRenderer((text) => output.write(text), runtimeRendererOptions(output));
  const capabilities = promptCapabilities(output, process.env);
  return {
    renderer,
    async ask(): Promise<InteractiveAnswers> {
      renderer.welcome();
      const action = await selectChoice(input, output, renderer, 'Что вы хотите сделать?', [
        { value: 'create', label: 'Создать новый проект' },
        { value: 'check', label: 'Проверить canonical project' },
      ], capabilities);
      const question = action === 'create' ? 'Как назовём проект? Можно указать полный путь.' : 'Какой canonical project проверить?';
      const hint = action === 'create' ? 'Например: Мой проект. Тогда папка появится на Рабочем столе.' : 'Перетащите папку сюда или вставьте путь.';
      const raw = await askLine(input, output, renderer, question, hint, capabilities);
      const project = await resolveProjectInput(raw, runtimeDesktopOptions(action));
      if (action === 'check') {
        renderer.preview({ action, target: project.target });
        renderer.progress('Проверяем структуру проекта…');
        return { action, target: project.target };
      }
      const startingPoint = await selectChoice(input, output, renderer, 'С чего вы начинаете?', [
        { value: 'idea', label: 'Только идея — помогите оформить замысел' },
        { value: 'materials', label: 'Есть материалы — заметки, ссылки или файлы' },
        { value: 'spec', label: 'Есть требования — спецификация уже написана' },
        { value: 'code', label: 'Есть код — проект уже разрабатывается' },
      ], capabilities);
      renderer.preview({ action, target: project.target, name: project.name, usedDesktopDefault: project.usedDesktopDefault });
      renderer.progress('Создаём структуру canonical project…');
      return { action, target: project.target, name: project.name, startingPoint, usedDesktopDefault: project.usedDesktopDefault };
    },
  };
}
