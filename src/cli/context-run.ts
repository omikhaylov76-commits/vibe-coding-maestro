import { FINISH_SLICE_SHARE, measureContext, NEW_SESSION_SHARE } from '../core/context.js';
import type { ContextLevel, WindowSource } from '../core/context.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface ContextRunOptions {
  path: string;
  json: boolean;
  window?: number;
}

/** Тысячи через пробел, без зависимости от локали машины. */
export function formatTokens(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** «1 токен», «2 токена», «5 токенов». */
export function tokensWord(value: number): string {
  const n = Math.abs(Math.round(value));
  if (n % 10 === 1 && n % 100 !== 11) return 'токен';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'токена';
  return 'токенов';
}

const ADVICE: Readonly<Record<ContextLevel, string>> = {
  continue: 'Можно продолжать в этой сессии.',
  'finish-slice': 'Порцию лучше закончить в этой сессии, а следующую начать в новой — после передачи дел (/handoff).',
  'new-session': 'Пора в новую сессию: сделайте передачу дел (/handoff) сейчас и продолжайте в новой.',
};

/** Откуда взято окно — одной строкой. */
function windowLine(source: WindowSource | undefined, model: string | undefined, budget: number): string {
  if (source === 'option') return `Окно задано вручную (--window): ${formatTokens(budget)} ${tokensWord(budget)}.`;
  if (source === 'model' && model !== undefined) return `Модель ${model} — окно ${formatTokens(budget)} ${tokensWord(budget)}.`;
  const name = model === undefined ? 'в журнале не названа' : `«${model}» мне незнакома`;
  return `Модель ${name}: окно взято ${formatTokens(budget)} ${tokensWord(budget)} по размеру сессии. Знаете окно этой модели — задайте его: --window <токены>.`;
}

export async function executeContextCommand(options: ContextRunOptions, io: CliIo): Promise<number> {
  const report = await measureContext({ root: options.path, ...(options.window === undefined ? {} : { budget: options.window }) });
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!report.ok || report.level === undefined) {
    io.err(`Vibe Coding Maestro context: ${report.message ?? 'размер сессии не измерен.'}`);
    return EXIT_FAILED;
  }
  const tokens = report.contextTokens ?? 0;
  io.out(`Размер сессии: ${formatTokens(tokens)} ${tokensWord(tokens)} (${report.percent}% окна модели в ${formatTokens(report.budget)}).`);
  io.out(windowLine(report.windowSource, report.model, report.budget));
  io.out(ADVICE[report.level]);
  const total = report.totalInputTokens ?? 0;
  io.out(`За сессию модель получила на вход ${formatTokens(total)} ${tokensWord(total)} (шагов модели: ${report.requests}): каждый шаг заново пересылает всю историю.`);
  io.out(`Пороги ${Math.round(FINISH_SLICE_SHARE * 100)}% и ${Math.round(NEW_SESSION_SHARE * 100)}% — гипотеза; их уточнит замер.`);
  return EXIT_OK;
}
