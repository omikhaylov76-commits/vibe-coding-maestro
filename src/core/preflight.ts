/**
 * Механический build preflight (Planning Gate, Phase 3).
 *
 * Отвечает ровно на один вопрос: разрешено ли начинать код прямо сейчас и какая
 * именно порция разрешена. Решение принимается только по структурно доказуемым
 * фактам — объявленному активному плану, его статусу, approval metadata и
 * машиночитаемым gate-полям. Свободный текст плана не парсится и не толкуется:
 * то, что не объявлено полем, считается необъявленным, и гейт закрывается.
 *
 * Границы ответственности:
 * - doctor проверяет документы проекта на валидность;
 * - preflight решает вопрос права на исполнение и потому строже: отсутствие
 *   gate-полей у утверждённого плана — валидный документ, но закрытый гейт;
 * - выбор «что делать дальше» остаётся за протоколом и человеком: preflight
 *   ничего не запускает и ничего не пишет.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decodeUtf8, frontmatter } from './doctor/text.js';
import {
  ACTIVE_PLAN_NONE,
  isWikiRelativePlanRef,
  validatePlanFrontmatter,
  PLAN_SCALES,
} from './plan.js';
import type { PlanDocument, PlanScale } from './plan.js';

export const HOT_PATH = 'wiki/hot.md';

/**
 * Явные критерии исключения для QUICK.
 *
 * Их нельзя вывести из файлов: это утверждения о характере правки. Поэтому они
 * приходят как явное объявление вызывающей стороны, а гейт требует полного
 * набора. Частичное объявление — это FEATURE+ и маршрут в `/plan`.
 */
export const QUICK_CRITERIA = [
  'no-new-architecture',
  'no-external-integration',
  'no-data-change',
  'no-contract-change',
] as const;
export type QuickCriterion = (typeof QUICK_CRITERIA)[number];

export type PreflightRoute = 'build' | 'plan' | 'human';
export type PreflightLevel = 'block' | 'info';

export interface PreflightFinding {
  level: PreflightLevel;
  code: string;
  message: string;
  path?: string;
}

export interface PreflightDecision {
  reportVersion: 1;
  /** true только если код разрешён прямо сейчас. */
  ok: boolean;
  route: PreflightRoute;
  /** Project-relative путь активного плана. */
  plan: string | null;
  /** Ровно одна разрешённая порция. */
  slice: string | null;
  /** Единственное исключение канона: QUICK mini-plan без plan-документа. */
  exception: 'quick-mini-plan' | null;
  findings: PreflightFinding[];
}

export interface PreflightRequest {
  scale: PlanScale;
  quickCriteria?: readonly string[];
}

/** Прочитанное состояние проекта. Чтение отделено от решения, чтобы решение было чистым. */
export interface PreflightState {
  /** Объявленный active_plan; null — поле отсутствует либо `none`. */
  declared: string | null;
  /** Project-relative путь плана, если ссылка синтаксически допустима. */
  planPath: string | null;
  planText: string | null;
  hotFound: boolean;
}

const finding = (level: PreflightLevel, code: string, message: string, path?: string): PreflightFinding =>
  ({ level, code, message, ...(path === undefined ? {} : { path }) });

const decision = (patch: Partial<PreflightDecision>): PreflightDecision => ({
  reportVersion: 1,
  ok: false,
  route: 'plan',
  plan: null,
  slice: null,
  exception: null,
  findings: [],
  ...patch,
});

export function isPlanScale(value: string): value is PlanScale {
  return (PLAN_SCALES as readonly string[]).includes(value);
}

/** Решение по уже прочитанному состоянию. Чистая функция: ни файлов, ни времени. */
export function decideBuildPreflight(state: PreflightState, request: PreflightRequest): PreflightDecision {
  if (!state.hotFound) {
    return decision({ findings: [finding('block', 'preflight-hot-missing', 'Файл горячего контекста отсутствует: состояние проекта недоказуемо.', HOT_PATH)] });
  }

  if (state.declared === null) {
    const unknown = (request.quickCriteria ?? []).filter((item) => !(QUICK_CRITERIA as readonly string[]).includes(item));
    if (unknown.length > 0) {
      return decision({ findings: [finding('block', 'preflight-quick-criteria-unknown', `Неизвестные критерии QUICK: ${unknown.join(', ')}. Допустимы: ${QUICK_CRITERIA.join(', ')}.`)] });
    }
    if (request.scale !== 'quick') {
      return decision({
        findings: [finding('block', 'preflight-plan-absent', `Активного плана нет, а масштаб работы ${request.scale} требует утверждённого плана. Маршрут: protocols/plan.md.`, HOT_PATH)],
      });
    }
    const missing = QUICK_CRITERIA.filter((item) => !(request.quickCriteria ?? []).includes(item));
    if (missing.length > 0) {
      return decision({
        findings: [finding('block', 'preflight-quick-criteria-missing', `Исключение QUICK требует явного объявления всех критериев; не объявлены: ${missing.join(', ')}.`)],
      });
    }
    return decision({
      ok: true,
      route: 'build',
      exception: 'quick-mini-plan',
      findings: [finding('info', 'preflight-quick-exception', 'Разрешён mini-plan QUICK без plan-документа; исключение обязано остаться видимым в wiki/progress/.')],
    });
  }

  if (state.planPath === null) {
    return decision({ findings: [finding('block', 'preflight-plan-path-invalid', 'Ссылка active_plan не является wiki-относительным путём к плану.', HOT_PATH)] });
  }
  if (state.planText === null) {
    return decision({ plan: state.planPath, findings: [finding('block', 'preflight-plan-missing', 'Объявленный активный план отсутствует или нечитаем.', state.planPath)] });
  }

  const meta = frontmatter(state.planText);
  if (meta === null) {
    return decision({ plan: state.planPath, findings: [finding('block', 'preflight-plan-invalid', 'Frontmatter активного плана не разобран.', state.planPath)] });
  }
  const validation = validatePlanFrontmatter(meta);
  if (validation.plan === null) {
    return decision({
      plan: state.planPath,
      findings: validation.issues.map((issue) => finding('block', 'preflight-plan-invalid', `${issue.field}: ${issue.message}`, state.planPath ?? undefined)),
    });
  }

  return decideForPlan(validation.plan, state.planPath);
}

function decideForPlan(plan: PlanDocument, planPath: string): PreflightDecision {
  const findings: PreflightFinding[] = [];
  const at = (code: string, message: string): void => { findings.push(finding('block', code, message, planPath)); };
  let route: PreflightRoute = 'plan';

  if (plan.status !== 'approved' && plan.status !== 'active') {
    at('preflight-plan-not-approved', `Статус плана ${plan.status}: код по неутверждённому плану не пишется.`);
    return decision({ plan: planPath, route, findings });
  }
  if (plan.approvedBy === null || plan.approvedAt === null) {
    route = 'human';
    at('preflight-approval-missing', 'У утверждённого плана нет следа человеческого решения.');
    return decision({ plan: planPath, route, findings });
  }

  const missing: string[] = [];
  if (plan.blockingQuestions === null) missing.push('blocking_questions');
  if (plan.specDelta === null) missing.push('spec_delta');
  if (plan.currentSlice === null) missing.push('current_slice');
  if (plan.kind === 'program' && plan.currentPhaseApproved === null) missing.push('current_phase_approved');
  if (missing.length > 0) {
    at('preflight-gate-fields-missing', `План не объявляет обязательные для build поля: ${missing.join(', ')}. Необъявленное считается неизвестным.`);
    return decision({ plan: planPath, route, findings });
  }

  if ((plan.blockingQuestions ?? 0) > 0) {
    route = 'human';
    at('preflight-blocking-questions', `Открытых блокирующих вопросов: ${plan.blockingQuestions}. Их закрывает человек, а не агент.`);
  }
  if (plan.specDelta !== 'none') {
    at('preflight-spec-delta', `Объявлен spec delta (${plan.specDelta}): граница изменилась и требует повторного утверждения.`);
  }
  if (plan.kind === 'program') {
    if (plan.activePhase === null) {
      at('preflight-phase-undeclared', 'Program-план не объявляет active_phase: неизвестно, какая фаза исполняется.');
    }
    if (plan.currentPhaseApproved !== true) {
      route = 'human';
      at('preflight-phase-not-approved', 'Текущая фаза программы не утверждена; утверждение программы не утверждает будущие фазы.');
    }
  }

  const blocked = findings.some((item) => item.level === 'block');
  return decision({
    ok: !blocked,
    route: blocked ? route : 'build',
    plan: planPath,
    slice: blocked ? null : plan.currentSlice,
    findings: blocked ? findings : [
      finding('info', 'preflight-slice-selected', `Разрешена ровно одна порция: ${plan.currentSlice}. Остановка на её стоп-гейте обязательна.`, planPath),
    ],
  });
}

/** Читает состояние проекта. Ничего не пишет и ничего не исполняет. */
export async function inspectBuildPreflight(rootInput: string): Promise<PreflightState> {
  const root = resolve(rootInput);
  const hotText = await readText(join(root, HOT_PATH));
  if (hotText === null) return { declared: null, planPath: null, planText: null, hotFound: false };

  const meta = frontmatter(hotText);
  const declared = meta?.active_plan ?? ACTIVE_PLAN_NONE;
  if (declared === ACTIVE_PLAN_NONE) return { declared: null, planPath: null, planText: null, hotFound: true };
  if (!isWikiRelativePlanRef(declared)) return { declared, planPath: null, planText: null, hotFound: true };

  const planPath = `wiki/${declared}`;
  return { declared, planPath, planText: await readText(join(root, planPath)), hotFound: true };
}

async function readText(absolute: string): Promise<string | null> {
  try {
    return decodeUtf8(await readFile(absolute));
  } catch {
    return null;
  }
}

export async function buildPreflight(rootInput: string, request: PreflightRequest): Promise<PreflightDecision> {
  return decideBuildPreflight(await inspectBuildPreflight(rootInput), request);
}
