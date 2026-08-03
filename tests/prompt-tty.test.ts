import { PassThrough, Writable } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { afterEach, describe, expect, it } from 'vitest';
import {
  askLine,
  createReadlinePrompt,
  promptCapabilities,
  selectChoice,
} from '../src/cli/prompt.js';
import { createRenderer } from '../src/cli/renderer.js';

/** Любой ESC-байт: и цвет, и управление курсором. */
const ANY_ESC = /\x1b/;
/** Только управление курсором/очистка строки — то, что ломает dumb-терминалы. */
const CURSOR_CONTROL = /\x1b\[[0-9]*[A-DJKGHfsu]/;

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  rawModeThrows = false;

  setRawMode(mode: boolean): this {
    this.rawCalls.push(mode);
    if (this.rawModeThrows) throw new Error('setRawMode недоступен');
    this.isRaw = mode;
    return this;
  }
}

class FakeOutput extends Writable {
  isTTY = true;
  columns = 100;
  chunks: string[] = [];

  override _write(chunk: Buffer | string, _enc: unknown, done: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    done();
  }

  text(): string {
    return this.chunks.join('');
  }
}

interface Harness {
  input: FakeInput;
  output: FakeOutput;
  inStream: ReadStream;
  outStream: WriteStream;
  renderer: ReturnType<typeof createRenderer>;
  baseline: () => Record<string, number>;
  listeners: () => Record<string, number>;
}

function listenerSnapshot(input: FakeInput): Record<string, number> {
  const result: Record<string, number> = {};
  for (const event of input.eventNames()) result[String(event)] = input.listenerCount(event);
  return result;
}

function harness(options: { columns?: number; env?: Record<string, string | undefined> } = {}): Harness {
  const input = new FakeInput();
  const output = new FakeOutput();
  if (options.columns) output.columns = options.columns;
  const renderer = createRenderer((text) => output.write(text), {
    isTty: true,
    columns: output.columns,
    env: options.env ?? {},
    unicode: (options.env ?? {}).TERM !== 'dumb',
  });
  const counts = (): Record<string, number> => listenerSnapshot(input);
  const initial = counts();
  return {
    input,
    output,
    inStream: input as unknown as ReadStream,
    outStream: output as unknown as WriteStream,
    renderer,
    baseline: () => initial,
    listeners: counts,
  };
}

const CHOICES = [
  { value: 'create', label: 'Создать новый проект' },
  { value: 'connect', label: 'Подключить существующий проект' },
  { value: 'check', label: 'Проверить проект' },
] as const;

const CAPABLE = { cursorRedraw: true, unicode: true };
const PLAIN = { cursorRedraw: false, unicode: false };

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Таймаут ожидания: ${label}`);
}

const savedEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

describe('promptCapabilities: NO_COLOR, TERM=dumb и узкие терминалы отключают перерисовку', () => {
  it('включает перерисовку только в достаточно широком цветном TTY', () => {
    expect(promptCapabilities({ isTTY: true, columns: 100 }, { TERM: 'xterm-256color' })).toEqual({
      cursorRedraw: true,
      unicode: true,
    });
  });

  it.each([
    ['NO_COLOR=1', { NO_COLOR: '1', TERM: 'xterm-256color' }],
    ['NO_COLOR=""', { NO_COLOR: '', TERM: 'xterm-256color' }],
    ['TERM=dumb', { TERM: 'dumb' }],
  ])('%s отключает перерисовку', (_label, env) => {
    expect(promptCapabilities({ isTTY: true, columns: 100 }, env).cursorRedraw).toBe(false);
  });

  it('узкий терминал (columns<60) и non-TTY тоже переходят в plain-режим', () => {
    expect(promptCapabilities({ isTTY: true, columns: 40 }, { TERM: 'xterm' }).cursorRedraw).toBe(false);
    expect(promptCapabilities({ isTTY: false, columns: 200 }, { TERM: 'xterm' }).cursorRedraw).toBe(false);
  });
});

describe('selectChoice: рабочий ввод', () => {
  it('Enter выбирает текущий вариант и восстанавливает raw-режим и listeners', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\r');

    await expect(promise).resolves.toBe('create');
    expect(h.input.isRaw).toBe(false);
    expect(h.input.rawCalls).toEqual([true, false]);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('цифра выбирает вариант напрямую', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('2');

    await expect(promise).resolves.toBe('connect');
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('стрелки двигают выбор в capable-терминале', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\x1b[B');
    await waitFor(() => h.output.text().split('Подключить существующий проект').length > 2, 'перерисовка');
    h.input.write('\r');

    await expect(promise).resolves.toBe('connect');
  });
});

describe('selectChoice: fail-closed cleanup', () => {
  it('Ctrl+C всегда завершает Promise контролируемой ошибкой и снимает listeners', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\x03');

    await expect(promise).rejects.toThrow(/отмен/i);
    expect(h.input.isRaw).toBe(false);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('EOF (end потока) не оставляет Promise висящим', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.end();

    await expect(promise).rejects.toThrow(Error);
    expect(h.input.isRaw).toBe(false);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('ошибка потока завершает Promise и снимает listeners', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.emit('error', new Error('поток оборвался'));

    await expect(promise).rejects.toThrow(Error);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('бросающий setRawMode не мешает Promise завершиться и listeners сняться', async () => {
    const h = harness();
    h.input.rawModeThrows = true;
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\r');

    await expect(promise).resolves.toBe('create');
    expect(h.input.rawCalls).toEqual([true, false]);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('повторные события после завершения не переоткрывают Promise', async () => {
    const h = harness();
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\r');
    await expect(promise).resolves.toBe('create');

    h.input.end();
    h.input.emit('close');
    expect(h.listeners()).toEqual(h.baseline());
  });
});

describe('точное восстановление listener identities', () => {
  const identities = (input: FakeInput) => new Map(input.eventNames().map((event) => [event, input.rawListeners(event)]));

  it('selectChoice сохраняет чужие data/newListener listeners и settles на actual close', async () => {
    const h = harness();
    const foreignData = () => undefined;
    const foreignNew = () => undefined;
    h.input.on('data', foreignData);
    h.input.on('newListener', foreignNew);
    const before = identities(h.input);
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, CAPABLE);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'menu');
    h.input.emit('close');
    await expect(promise).rejects.toThrow(Error);
    expect(identities(h.input)).toEqual(before);
  });

  it('askLine сохраняет точные чужие listener identities после обычного ответа', async () => {
    const h = harness();
    const foreignData = () => undefined;
    const foreignNew = () => undefined;
    h.input.on('data', foreignData);
    h.input.on('newListener', foreignNew);
    const before = identities(h.input);
    const promise = askLine(h.inStream, h.outStream, h.renderer, 'Проект?', 'hint');
    await waitFor(() => h.output.text().includes('Проект?'), 'question');
    h.input.write('Demo\n');
    await expect(promise).resolves.toBe('Demo');
    expect(identities(h.input)).toEqual(before);
  });
});

describe('selectChoice: plain-режим для dumb и узких терминалов', () => {
  it('не использует управление курсором и печатает нумерованный список', async () => {
    const h = harness({ columns: 40, env: { TERM: 'dumb', NO_COLOR: '1' } });
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, PLAIN);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('3');

    await expect(promise).resolves.toBe('check');
    const text = h.output.text();
    expect(text).not.toMatch(ANY_ESC);
    expect(text).toContain('1. Создать новый проект');
    expect(text).toContain('3. Проверить проект');
  });

  it('в plain-режиме стрелки и Enter работают без перерисовки', async () => {
    const h = harness({ columns: 40, env: { TERM: 'dumb' } });
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'Что делаем?', CHOICES, PLAIN);
    await waitFor(() => h.output.text().includes('Что делаем?'), 'отрисовка меню');
    h.input.write('\x1b[B');
    await waitFor(() => h.output.text().includes('Выбрано: 2.'), 'подтверждение выбора');
    h.input.write('\r');

    await expect(promise).resolves.toBe('connect');
    expect(h.output.text()).not.toMatch(CURSOR_CONTROL);
  });

  it('длинные локализованные подписи на узком терминале не обрезаются управляющими кодами', async () => {
    const long = [
      { value: 'idea', label: 'Только идея — помогите оформить замысел' },
      { value: 'materials', label: 'Есть материалы — заметки, ссылки или файлы' },
      { value: 'spec', label: 'Есть требования — спецификация уже написана' },
      { value: 'code', label: 'Есть код — проект уже разрабатывается' },
    ] as const;
    const h = harness({ columns: 24, env: { TERM: 'dumb', NO_COLOR: '1' } });
    const promise = selectChoice(h.inStream, h.outStream, h.renderer, 'С чего начинаете?', long, PLAIN);
    await waitFor(() => h.output.text().includes('С чего начинаете?'), 'отрисовка меню');
    h.input.write('2');

    await expect(promise).resolves.toBe('materials');
    const text = h.output.text();
    expect(text).not.toMatch(ANY_ESC);
    expect(text).toContain('Есть материалы — заметки, ссылки или файлы');
  });
});

describe('askLine: завершение при close, SIGINT и ошибке', () => {
  it('возвращает введённую строку и переспрашивает при пустом вводе', async () => {
    const h = harness();
    const promise = askLine(h.inStream, h.outStream, h.renderer, 'Как назовём проект?', 'Например: Мой проект');
    await waitFor(() => h.output.text().includes('Как назовём проект?'), 'вопрос');
    h.input.write('\n');
    await waitFor(() => h.output.text().includes('Введите название проекта или путь.'), 'повторный вопрос');
    h.input.write('Demo\n');

    await expect(promise).resolves.toBe('Demo');
  });

  it('actual close потока завершает Promise ошибкой, чистит listeners и не зависает', async () => {
    const h = harness();
    const promise = askLine(h.inStream, h.outStream, h.renderer, 'Как назовём проект?', 'подсказка');
    await waitFor(() => h.output.text().includes('Как назовём проект?'), 'вопрос');
    h.input.emit('close');

    await expect(promise).rejects.toThrow(Error);
    expect(h.listeners()).toEqual(h.baseline());
  });

  it('SIGINT завершает Promise контролируемой отменой', async () => {
    const h = harness();
    const promise = askLine(h.inStream, h.outStream, h.renderer, 'Как назовём проект?', 'подсказка');
    await waitFor(() => h.output.text().includes('Как назовём проект?'), 'вопрос');
    await expect(Promise.all([
      expect(promise).rejects.toThrow(/отмен/i),
      (async () => { h.input.write('\x03'); })(),
    ])).resolves.toBeDefined();
  });

  it('ошибка потока завершает Promise', async () => {
    const h = harness();
    const promise = askLine(h.inStream, h.outStream, h.renderer, 'Как назовём проект?', 'подсказка');
    await waitFor(() => h.output.text().includes('Как назовём проект?'), 'вопрос');
    h.input.emit('error', new Error('поток оборвался'));

    await expect(promise).rejects.toThrow(Error);
  });
});

describe('полный guided-прогон через fake TTY не содержит ESC при NO_COLOR и TERM=dumb', () => {
  it.each([
    ['NO_COLOR=1', { NO_COLOR: '1', TERM: 'xterm-256color' }],
    ['TERM=dumb', { TERM: 'dumb' }],
  ])('%s: create-диалог задаёт три вопроса без единого ESC-байта', async (_label, env) => {
    delete process.env.NO_COLOR;
    Object.assign(process.env, env);

    const input = new FakeInput();
    const output = new FakeOutput();
    const prompt = createReadlinePrompt(input as unknown as ReadStream, output as unknown as WriteStream);
    const answer = prompt.ask();

    await waitFor(() => output.text().includes('Что вы хотите сделать?'), 'первый вопрос');
    input.write('1');
    await waitFor(() => output.text().includes('Как назовём проект?'), 'второй вопрос');
    input.write('Demo\n');
    await waitFor(() => output.text().includes('С чего вы начинаете?'), 'третий вопрос');
    input.write('2');

    const result = await answer;
    expect(result.action).toBe('create');
    if (result.action !== 'check') {
      expect(result.name).toBe('Demo');
      expect(result.startingPoint).toBe('materials');
      expect(result.usedDesktopDefault).toBe(true);
    }

    const text = output.text();
    expect(text).not.toMatch(ANY_ESC);
    expect(text).toContain('VIBE CODING MAESTRO');
    expect(text).toContain('1. Создать новый проект');
  });

  it('в capable-терминале перерисовка со стрелками сохраняется', async () => {
    delete process.env.NO_COLOR;
    process.env.TERM = 'xterm-256color';

    const input = new FakeInput();
    const output = new FakeOutput();
    const prompt = createReadlinePrompt(input as unknown as ReadStream, output as unknown as WriteStream);
    const answer = prompt.ask();

    await waitFor(() => output.text().includes('Что вы хотите сделать?'), 'первый вопрос');
    input.write('\x1b[B');
    await waitFor(() => CURSOR_CONTROL.test(output.text()), 'управление курсором');
    input.write('\r');

    await waitFor(() => output.text().includes('Где находится существующий проект?'), 'второй вопрос');
    input.write('Demo\n');
    await waitFor(() => output.text().includes('С чего вы начинаете?'), 'третий вопрос');
    input.write('1');

    const result = await answer;
    expect(result.action).toBe('connect');
    expect(output.text()).toMatch(CURSOR_CONTROL);
  });
});
