import { PRODUCT_NAME, SERVICE_COMMAND, VERSION } from '../core/meta.js';
import { CliIo, EXIT_OK, EXIT_USAGE, processIo } from './io.js';

const HELP = `${PRODUCT_NAME} — служебный CLI проекта.

Использование:
  npx ${SERVICE_COMMAND} <команда> [опции]

Команды:
  doctor              механическая проверка целостности проекта (без LLM и токенов)
  skills              безопасная инвентаризация локальных SKILL.md и рекомендации

Опции doctor/skills:
  --path <путь>       корень проверяемого проекта (по умолчанию текущая папка)
  --json              детерминированный машиночитаемый отчёт

Опции doctor:
  --strict            считать warning блокирующим

Общие опции:
  --help, -h          эта справка
  --version, -v       версия`;

interface CommandOptions { path: string; json: boolean; strict?: boolean }
type ParseResult =
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'doctor' | 'skills'; options: CommandOptions };

export function parseMaestroArgs(argv: readonly string[]): ParseResult {
  if (argv.length === 0) return { kind: 'error', message: 'Не указана команда. Доступно: doctor, skills.' };
  const first = argv[0] as string;
  if (first === '--version' || first === '-v') return { kind: 'version' };
  if (first === '--help' || first === '-h') return { kind: 'help' };
  if (first !== 'doctor' && first !== 'skills') return { kind: 'error', message: `Неизвестная команда: ${first}. Доступно: doctor, skills.` };

  const options: CommandOptions = { path: process.cwd(), json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    switch (arg) {
      case '--help': case '-h': return { kind: 'help' };
      case '--json': options.json = true; break;
      case '--strict': {
        if (first !== 'doctor') return { kind: 'error', message: `Флаг ${arg} доступен только для doctor.` };
        options.strict = true;
        break;
      }
      case '--path': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) return { kind: 'error', message: `Флаг ${arg} требует значение.` };
        options.path = value; i += 1; break;
      }
      default:
        if (arg.startsWith('-')) return { kind: 'error', message: `Неизвестный аргумент: ${arg}` };
        return { kind: 'error', message: `Лишний аргумент: ${arg}` };
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
  const { executeSkillsCommand } = await import('./skills-run.js');
  return executeSkillsCommand(parsed.options, io);
}
