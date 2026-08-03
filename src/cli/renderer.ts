export interface RendererOptions {
  isTty: boolean;
  columns: number;
  env: Record<string, string | undefined>;
  unicode: boolean;
}

export interface PreviewModel {
  action: 'create' | 'connect' | 'check';
  target: string;
  name?: string;
  usedDesktopDefault?: boolean;
}

export interface SuccessModel {
  action: 'create' | 'connect' | 'check';
  target: string;
  name?: string;
  doctorOk: boolean;
}

export interface CliRenderer {
  welcome(): void;
  preview(model: PreviewModel): void;
  progress(message: string): void;
  success(model: SuccessModel): void;
  warning(message: string): void;
  failure(message: string): void;
  accent(text: string): string;
  muted(text: string): string;
}

type Write = (text: string) => void;

const ESC = '\x1b[';
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text.replace(ANSI_PATTERN, '')) {
    if (/\p{Mark}|\u200d|\ufe0f/u.test(char)) continue;
    const code = char.codePointAt(0)!;
    const wide = /\p{Extended_Pictographic}/u.test(char)
      || (code >= 0x1100 && (
        code <= 0x115f || code === 0x2329 || code === 0x232a
        || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe19)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
      ));
    width += wide ? 2 : 1;
  }
  return width;
}

function padToDisplayWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function wrap(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (!line) { line = word; continue; }
    if (displayWidth(`${line} ${word}`) <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

export function createRenderer(write: Write, options: RendererOptions): CliRenderer {
  const columns = Math.max(24, options.columns || 80);
  const colorEnabled = options.isTty
    && !Object.prototype.hasOwnProperty.call(options.env, 'NO_COLOR')
    && options.env.TERM !== 'dumb';
  const paint = (code: string, text: string): string => colorEnabled ? `${ESC}${code}m${text}${ESC}0m` : text;
  const accent = (text: string) => paint('1;35', text);
  const info = (text: string) => paint('36', text);
  const success = (text: string) => paint('1;32', text);
  const warning = (text: string) => paint('1;33', text);
  const danger = (text: string) => paint('1;31', text);
  const muted = (text: string) => paint('2', text);
  const narrow = columns < 60;

  const panel = (title: string, lines: readonly string[], tone: 'accent' | 'success' = 'accent'): void => {
    const titlePaint = tone === 'success' ? success : accent;
    if (narrow) {
      write(`\n${titlePaint(title)}\n`);
      const contentWidth = columns;
      for (const item of lines) for (const line of wrap(item, contentWidth)) write(`${line}\n`);
      write('\n');
      return;
    }
    const width = Math.min(88, columns - 2);
    const leftPadding = 2;
    const rightPadding = 4;
    const inner = width - leftPadding - rightPadding - 2;
    const top = options.unicode ? `╭${'─'.repeat(width - 2)}╮` : `+${'-'.repeat(width - 2)}+`;
    const bottom = options.unicode ? `╰${'─'.repeat(width - 2)}╯` : `+${'-'.repeat(width - 2)}+`;
    const side = options.unicode ? '│' : '|';
    write(`\n${top}\n`);
    const titleLine = `${' '.repeat(leftPadding)}${title}`;
    write(`${side}${titlePaint(padToDisplayWidth(titleLine, width - 2))}${side}\n`);
    write(`${side}${' '.repeat(width - 2)}${side}\n`);
    for (const item of lines) {
      for (const line of wrap(item, inner)) {
        write(`${side}${' '.repeat(leftPadding)}${padToDisplayWidth(line, inner)}${' '.repeat(rightPadding)}${side}\n`);
      }
    }
    write(`${bottom}\n\n`);
  };

  return {
    welcome(): void {
      const lines = [
        'Создадим понятную основу проекта и память для AI-инструментов.',
        '',
        'Не больше трёх коротких шагов: действие, проект и исходная точка.',
        'Если ввести только название, папка появится на Рабочем столе.',
        'Ваши существующие файлы Maestro не перезаписывает молча.',
        '',
        'Управление: ↑/↓ — выбрать, Enter — продолжить, Ctrl+C — выйти.',
      ];
      panel('VIBE CODING MAESTRO', columns < 36 ? [lines[0]!, lines[3]!, lines[6]!] : lines);
    },
    preview(model): void {
      const heading = model.action === 'check' ? 'ПРОВЕРЯЕМ ПРОЕКТ' : model.action === 'connect' ? 'ПОДКЛЮЧАЕМ MAESTRO' : 'СОЗДАЁМ ПРОЕКТ';
      write(`\n${info(`> ${heading}`)}\n`);
      if (model.name) write(`  Проект: ${model.name}\n`);
      write(`  Папка:  ${model.target}\n`);
      if (model.usedDesktopDefault) write(`  ${muted('Папка будет создана на Рабочем столе.')}\n`);
      write('\n');
    },
    progress(message): void { write(`${info('>')} ${message}\n`); },
    success(model): void {
      if (!model.doctorOk) { this.failure('Проверка нашла проблемы.'); return; }
      if (model.action === 'check') {
        panel('OK  ПРОВЕРКА ПРОЙДЕНА', [`Проект: ${model.target}`, 'Структура Maestro в порядке.'], 'success');
        return;
      }
      const title = model.action === 'connect' ? 'OK  MAESTRO ПОДКЛЮЧЁН' : 'OK  ПРОЕКТ ГОТОВ';
      panel(title, [
        model.name ? `Название: ${model.name}` : '',
        'Проект находится здесь:',
        model.target,
        '',
        'Что делать дальше:',
        '1. Откройте папку проекта.',
        '2. Добавьте заметки и файлы в maestro/inbox/.',
        '3. Начните с wiki/hot.md.',
        '4. Для discovery откройте maestro/runbooks/cowork-discovery.md.',
        '',
        'Проверка пройдена: структура проекта в порядке.',
      ].filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')), 'success');
    },
    warning(message): void { write(`${warning('! ВНИМАНИЕ')}  ${message}\n`); },
    failure(message): void { write(`${danger('X ОШИБКА')}  ${message}\n`); },
    accent,
    muted,
  };
}

export function runtimeRendererOptions(output: { isTTY?: boolean; columns?: number }): RendererOptions {
  return {
    isTty: Boolean(output.isTTY),
    columns: output.columns && output.columns > 0 ? output.columns : 80,
    env: process.env,
    unicode: process.env.TERM !== 'dumb',
  };
}
