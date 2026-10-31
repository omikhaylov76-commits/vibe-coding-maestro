import { DEFAULT_BUDGET, FINISH_SLICE_SHARE, measureContext, NEW_SESSION_SHARE } from '../core/context.js';
import type { ContextLevel } from '../core/context.js';
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

const ADVICE: Readonly<Record<ContextLevel, string>> = {
  continue: 'Можно продолжать в этой сессии.',
  'finish-slice': 'Закончите текущую порцию, сделайте передачу дел (/handoff) и начните новую сессию.',
  'new-session': 'Пора в новую сессию: сделайте передачу дел (/handoff) сейчас и продолжайте в новой.',
};

export async function executeContextCommand(options: ContextRunOptions, io: CliIo): Promise<number> {
  const report = await measureContext({ root: options.path, budget: options.window ?? DEFAULT_BUDGET });
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? EXIT_OK : EXIT_FAILED;
  }
  if (!report.ok || report.level === undefined) {
    io.err(`Vibe Coding Maestro context: ${report.message ?? 'размер сессии не измерен.'}`);
    return EXIT_FAILED;
  }
  io.out(`Размер сессии: ${formatTokens(report.contextTokens ?? 0)} токенов (${report.percent}% от ${formatTokens(report.budget)}).`);
  io.out(ADVICE[report.level]);
  io.out(`За сессию модель получила на вход ${formatTokens(report.totalInputTokens ?? 0)} токенов (шагов модели: ${report.requests}): каждый шаг заново пересылает всю историю.`);
  io.out(`Пороги ${Math.round(FINISH_SLICE_SHARE * 100)}% и ${Math.round(NEW_SESSION_SHARE * 100)}% — гипотеза; их уточнит замер.`);
  return EXIT_OK;
}
