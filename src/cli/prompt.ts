import { basename, resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';
import type { StartingPoint } from '../core/meta.js';

export type InteractiveAction = 'create' | 'connect' | 'check';

export interface InteractiveAnswers {
  action: InteractiveAction;
  target: string;
  name: string;
  startingPoint: StartingPoint;
}

export interface PromptAdapter {
  /** Ровно три пользовательских шага: action, path+name, starting point. */
  ask(): Promise<InteractiveAnswers>;
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

async function select<T extends string>(
  input: ReadStream,
  output: WriteStream,
  title: string,
  choices: readonly Choice<T>[],
): Promise<T> {
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  let index = 0;

  const draw = (first: boolean): void => {
    if (!first) output.write(`\x1b[${choices.length}A`);
    for (let i = 0; i < choices.length; i += 1) {
      output.write(`\x1b[2K${i === index ? '❯' : ' '} ${i + 1}. ${choices[i]?.label}\n`);
    }
  };

  output.write(`${title} (↑/↓ и Enter; также 1–${choices.length})\n`);
  draw(true);

  return new Promise<T>((resolveChoice, reject) => {
    const finish = (value?: T, error?: Error): void => {
      input.off('keypress', onKey);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      if (error) reject(error);
      else resolveChoice(value as T);
    };
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === 'c') return finish(undefined, new Error('Ввод отменён.'));
      if (key.name === 'up') index = (index - 1 + choices.length) % choices.length;
      else if (key.name === 'down') index = (index + 1) % choices.length;
      else if (key.name === 'return') return finish(choices[index]?.value);
      else if (/^[1-9]$/.test(text)) {
        const numeric = Number(text) - 1;
        if (numeric < choices.length) return finish(choices[numeric]?.value);
        return;
      } else return;
      draw(false);
    };
    input.on('keypress', onKey);
  });
}

async function pathAndName(input: ReadStream, output: WriteStream): Promise<{ target: string; name: string }> {
  input.resume();
  const rl = createInterface({ input, output });
  try {
    const raw = await new Promise<string>((resolveLine) =>
      rl.question('Путь и название проекта (путь | название): ', resolveLine),
    );
    const [pathPart = '', ...nameParts] = raw.split('|');
    const target = resolve(pathPart.trim() || '.');
    const name = nameParts.join('|').trim() || basename(target);
    return { target, name };
  } finally {
    rl.close();
  }
}

export function createReadlinePrompt(
  input: ReadStream = process.stdin as ReadStream,
  output: WriteStream = process.stdout as WriteStream,
): PromptAdapter {
  return {
    async ask(): Promise<InteractiveAnswers> {
      const action = await select(input, output, 'Что сделать?', [
        { value: 'create', label: 'Создать новый проект' },
        { value: 'connect', label: 'Подключить существующий проект' },
        { value: 'check', label: 'Проверить проект' },
      ]);
      const project = await pathAndName(input, output);
      const startingPoint = await select(input, output, 'Starting point?', [
        { value: 'idea', label: 'Идея' },
        { value: 'materials', label: 'Материалы' },
        { value: 'spec', label: 'Спецификация' },
        { value: 'code', label: 'Код' },
      ]);
      return { action, ...project, startingPoint };
    },
  };
}
