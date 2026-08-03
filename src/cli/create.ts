import { CREATE_COMMAND, isStartingPoint, PRODUCT_NAME, STARTING_POINTS, VERSION } from '../core/meta.js';
import type { StartingPoint } from '../core/meta.js';
import { CliIo, EXIT_OK, EXIT_USAGE, processIo } from './io.js';
import type { PromptAdapter } from './prompt.js';

interface CreateOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  force: boolean;
  git: boolean;
  json: boolean;
}

export interface CreateCliRuntime {
  isTty: boolean;
  prompt?: PromptAdapter;
}

type ParseResult =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; options: CreateOptions };

const HELP = `${PRODUCT_NAME} — подготовка проекта одной командой.

Использование:
  npx ${CREATE_COMMAND}@latest --target <путь> [опции]

Опции:
  --target <путь>     куда создать проект (можно указать первым позиционным аргументом)
  --name <имя>        название проекта (по умолчанию — имя папки)
  --start <состояние> исходное состояние идеи: ${STARTING_POINTS.join(' | ')} (по умолчанию idea)
  --force             разрешить запись в непустую папку
  --no-git            не выполнять git init и стартовый commit
  --yes, -y           неинтерактивный режим (все ответы взяты из флагов)
  --json              машиночитаемый отчёт
  --help, -h          эта справка
  --version, -v       версия

После создания проект проверяется командой:
  npx --package ${CREATE_COMMAND}@latest vibe-maestro doctor`;

export function parseCreateArgs(argv: readonly string[]): ParseResult {
  const options: CreateOptions = {
    target: '',
    startingPoint: 'idea',
    force: false,
    git: true,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--version':
      case '-v':
        return { kind: 'version' };
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--force':
        options.force = true;
        break;
      case '--no-git':
        options.git = false;
        break;
      case '--yes':
      case '-y':
        break;
      case '--json':
        options.json = true;
        break;
      case '--target':
      case '--name':
      case '--start': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        }
        i += 1;
        if (arg === '--target') options.target = value;
        else if (arg === '--name') options.name = value;
        else {
          if (!isStartingPoint(value)) {
            return {
              kind: 'error',
              message: `Неизвестное значение --start: ${value}. Допустимо: ${STARTING_POINTS.join(', ')}.`,
            };
          }
          options.startingPoint = value;
        }
        break;
      }
      default:
        if (arg.startsWith('-')) {
          return { kind: 'error', message: `Неизвестный аргумент: ${arg}` };
        }
        if (options.target === '') {
          options.target = arg;
          break;
        }
        return { kind: 'error', message: `Лишний аргумент: ${arg}` };
    }
  }

  if (options.target === '') {
    return {
      kind: 'error',
      message: `Не указана папка проекта. Передайте --target <путь> (интерактивное меню появится позже).`,
    };
  }

  return { kind: 'run', options };
}

export async function runCreateCli(
  argv: readonly string[],
  io: CliIo = processIo,
  runtime: CreateCliRuntime = { isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY) },
): Promise<number> {
  const parsed = parseCreateArgs(argv);

  if (parsed.kind === 'version') {
    io.out(VERSION);
    return EXIT_OK;
  }
  if (parsed.kind === 'help') {
    io.out(HELP);
    return EXIT_OK;
  }
  const automatic = argv.includes('--yes') || argv.includes('-y');
  const needsTty =
    parsed.kind === 'run' ||
    (parsed.kind === 'error' && parsed.message.startsWith('Не указана папка проекта.'));
  if (needsTty && !runtime.isTty && !automatic) {
    io.err('Интерактивный режим требует TTY. Для автоматического запуска передайте --yes и --target <путь>.');
    return EXIT_USAGE;
  }
  if (parsed.kind === 'error') {
    const wantsInteractive = argv.length === 0 && parsed.message.startsWith('Не указана папка проекта.');
    if (wantsInteractive) {
      if (!runtime.isTty) {
        io.err('Интерактивный режим требует TTY. Для автоматического запуска передайте --yes и --target <путь>.');
        return EXIT_USAGE;
      }
      try {
        const prompt = runtime.prompt ?? (await import('./prompt.js')).createReadlinePrompt();
        const answers = await prompt.ask();
        if (answers.action === 'check') {
          const { executeDoctorCommand } = await import('./doctor-run.js');
          const code = await executeDoctorCommand({ path: answers.target, json: false }, io);
          if (prompt.renderer) {
            if (code === EXIT_OK) prompt.renderer.success({ action: 'check', target: answers.target, doctorOk: true });
            else prompt.renderer.failure('Проверка нашла проблемы. Подробности указаны выше.');
          }
          return code;
        }
        const { executeCreate } = await import('./create-run.js');
        return executeCreate(
          {
            target: answers.target,
            name: answers.name,
            startingPoint: answers.startingPoint,
            force: answers.action === 'connect',
            git: true,
            json: false,
          },
          io,
          prompt.renderer,
        );
      } catch (error) {
        io.err(error instanceof Error ? error.message : 'Интерактивный ввод прерван.');
        return EXIT_USAGE;
      }
    }
    io.err(parsed.message);
    io.err(`Подсказка: ${CREATE_COMMAND} --help`);
    return EXIT_USAGE;
  }

  const { executeCreate } = await import('./create-run.js');
  return executeCreate(parsed.options, io);
}
