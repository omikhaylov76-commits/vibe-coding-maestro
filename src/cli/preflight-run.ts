import { buildPreflight } from '../core/preflight.js';
import type { PlanScale } from '../core/plan.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface PreflightRunOptions {
  path: string;
  json: boolean;
  scale?: PlanScale;
  quickCriteria?: readonly string[];
}

const ROUTE_HINT: Readonly<Record<string, string>> = {
  build: 'Разрешено продолжать по protocols/build.md.',
  plan: 'Маршрут: protocols/plan.md — план и утверждение человеком до кода.',
  human: 'Нужно решение человека: агент не закрывает этот гейт сам.',
};

/** Механический гейт: ничего не пишет, ничего не запускает, только отвечает «можно или нет». */
export async function executePreflightCommand(options: PreflightRunOptions, io: CliIo): Promise<number> {
  const decision = await buildPreflight(options.path, {
    scale: options.scale ?? 'feature',
    quickCriteria: options.quickCriteria ?? [],
  });

  if (options.json) {
    io.out(JSON.stringify(decision, null, 2));
    return decision.ok ? EXIT_OK : EXIT_FAILED;
  }

  const write = (line: string): void => { if (decision.ok) io.out(line); else io.err(line); };
  write(`Build preflight: ${decision.ok ? 'разрешено' : 'заблокировано'}. ${ROUTE_HINT[decision.route] ?? ''}`.trimEnd());
  if (decision.plan !== null) write(`План: ${decision.plan}`);
  if (decision.slice !== null) write(`Разрешённая порция: ${decision.slice}`);
  if (decision.exception !== null) write(`Исключение: ${decision.exception}`);
  for (const item of decision.findings) {
    write(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
  }
  return decision.ok ? EXIT_OK : EXIT_FAILED;
}
