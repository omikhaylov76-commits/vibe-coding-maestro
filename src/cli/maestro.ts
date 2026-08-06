import { PLAN_SCALES } from '../core/plan.js';
import type { PlanScale } from '../core/plan.js';
import { QUICK_CRITERIA } from '../core/preflight.js';
import { PRODUCT_NAME, SERVICE_COMMAND, VERSION } from '../core/meta.js';
import { CliIo, EXIT_OK, EXIT_USAGE, processIo } from './io.js';

const HELP = `${PRODUCT_NAME} — служебный CLI проекта.

Использование:
  npx ${SERVICE_COMMAND} <команда> [опции]

Команды:
  doctor              механическая проверка целостности проекта (без LLM и токенов)
  skills              безопасная инвентаризация локальных SKILL.md и рекомендации
  sources             read-only инвентаризация существующих исходников для планирования
  upgrade             предложение обновления канонического проекта прошлой версии
  preflight           механическая проверка права начинать код по активному плану

Общие опции команд:
  --path <путь>       корень проверяемого проекта (по умолчанию текущая папка)
  --json              детерминированный машиночитаемый отчёт

Опции doctor:
  --strict            считать warning блокирующим

Опции sources:
  --source <путь>     существующий исходник; флаг можно повторять
  --write             записать снимок в проект; без флага не пишется ничего
  --replace           заменить прежний снимок этой же команды (решение человека)
  --output <путь>     project-relative путь снимка внутри maestro/sources/

Опции upgrade:
  --apply             выполнить обновление; без флага это только dry-run

Опции preflight:
  --scale <масштаб>   ${PLAN_SCALES.join(' | ')} (по умолчанию feature)
  --quick <критерии>  через запятую: ${QUICK_CRITERIA.join(', ')}

Общие опции:
  --help, -h          эта справка
  --version, -v       версия`;

const COMMANDS = ['doctor', 'skills', 'sources', 'upgrade', 'preflight'] as const;
type Command = (typeof COMMANDS)[number];

export interface CommandOptions {
  path: string;
  json: boolean;
  strict?: boolean;
  apply?: boolean;
  scale?: PlanScale;
  quickCriteria?: string[];
  sources?: string[];
  write?: boolean;
  replace?: boolean;
  output?: string;
}

type ParseResult =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: Command; options: CommandOptions };

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

export function parseMaestroArgs(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: 'error', message: `Не указана команда. Доступно: ${COMMANDS.join(', ')}.` };
  const first = argv[0] as string;
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (!isCommand(first)) return { kind: 'error', message: `Неизвестная команда: ${first}. Доступно: ${COMMANDS.join(', ')}.` };

  const options: CommandOptions = { path: process.cwd(), json: false };
  const only = (arg: string, command: Command): string | null =>
    first === command ? null : `Флаг ${arg} доступен только для ${command}.`;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const value = (): string | undefined => {
      const next = argv[i + 1];
      return next === undefined || next.startsWith('--') ? undefined : next;
    };
    switch (arg) {
      case '--help': case '-h': return { kind: 'help' };
      case '--json': options.json = true; break;
      case '--strict': {
        const message = only(arg, 'doctor');
        if (message !== null) return { kind: 'error', message };
        options.strict = true;
        break;
      }
      case '--apply': {
        const message = only(arg, 'upgrade');
        if (message !== null) return { kind: 'error', message };
        options.apply = true;
        break;
      }
      case '--scale': {
        const message = only(arg, 'preflight');
        if (message !== null) return { kind: 'error', message };
        const scale = value();
        if (scale === undefined) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        if (!(PLAN_SCALES as readonly string[]).includes(scale)) {
          return { kind: 'error', message: `Неизвестный масштаб: ${scale}. Доступно: ${PLAN_SCALES.join(', ')}.` };
        }
        options.scale = scale as PlanScale;
        i += 1;
        break;
      }
      case '--quick': {
        const message = only(arg, 'preflight');
        if (message !== null) return { kind: 'error', message };
        const criteria = value();
        if (criteria === undefined) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        options.quickCriteria = criteria.split(',').map((item) => item.trim()).filter((item) => item !== '');
        i += 1;
        break;
      }
      case '--source': {
        const message = only(arg, 'sources');
        if (message !== null) return { kind: 'error', message };
        const source = value();
        if (source === undefined) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        (options.sources ??= []).push(source);
        i += 1;
        break;
      }
      case '--write': {
        const message = only(arg, 'sources');
        if (message !== null) return { kind: 'error', message };
        options.write = true;
        break;
      }
      case '--replace': {
        const message = only(arg, 'sources');
        if (message !== null) return { kind: 'error', message };
        options.replace = true;
        break;
      }
      case '--output': {
        const message = only(arg, 'sources');
        if (message !== null) return { kind: 'error', message };
        const output = value();
        if (output === undefined) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        options.output = output;
        i += 1;
        break;
      }
      case '--path': {
        const path = value();
        if (path === undefined) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        options.path = path;
        i += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) return { kind: 'error', message: `Неизвестный аргумент: ${arg}` };
        return { kind: 'error', message: `Лишний аргумент: ${arg}` };
    }
  }
  if (first === 'sources') {
    if ((options.sources ?? []).length === 0) {
      return { kind: 'error', message: 'Команда sources требует хотя бы один --source <путь>.' };
    }
    // Замена — исключение поверх исключения: она осмысленна только вместе с записью.
    if (options.replace === true && options.write !== true) {
      return { kind: 'error', message: 'Флаг --replace имеет смысл только вместе с --write.' };
    }
    if (options.output !== undefined && options.write !== true) {
      return { kind: 'error', message: 'Флаг --output имеет смысл только вместе с --write.' };
    }
  }
  return { kind: first, options };
}

export async function runMaestroCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const parsed = parseMaestroArgs(argv);
  if (parsed.kind === 'version') { io.out(VERSION); return EXIT_OK; }
  if (parsed.kind === 'help') { io.out(HELP); return EXIT_OK; }
  if (parsed.kind === 'error') { io.err(parsed.message); io.err(`Подсказка: ${SERVICE_COMMAND} --help`); return EXIT_USAGE; }
  if (parsed.kind === 'doctor') {
    const { executeDoctorCommand } = await import('./doctor-run.js');
    return executeDoctorCommand(parsed.options, io);
  }
  if (parsed.kind === 'upgrade') {
    const { executeUpgradeCommand } = await import('./upgrade-run.js');
    return executeUpgradeCommand(parsed.options, io);
  }
  if (parsed.kind === 'sources') {
    const { executeSourcesCommand } = await import('./sources-run.js');
    return executeSourcesCommand({ ...parsed.options, sources: parsed.options.sources ?? [] }, io);
  }
  if (parsed.kind === 'preflight') {
    const { executePreflightCommand } = await import('./preflight-run.js');
    return executePreflightCommand(parsed.options, io);
  }
  const { executeSkillsCommand } = await import('./skills-run.js');
  return executeSkillsCommand(parsed.options, io);
}
