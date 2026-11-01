import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_PLAN_NONE, APPROVAL_REQUIRED_STATUSES, isExternalSourceRef, isWikiRelativePlanRef, planDigestMatches, validatePlanFrontmatter } from '../plan.js';
import type { PlanDocument } from '../plan.js';
import { frontmatter } from './text.js';
import { error } from './types.js';
import type { DoctorFinding } from './types.js';

export const PLANS_DIR = 'wiki/plans';
export const HOT_PATH = 'wiki/hot.md';

/** Документация контракта, а не планы: схемой плана они не проверяются. */
const NON_PLAN_FILES: ReadonlySet<string> = new Set(['README.md', 'TEMPLATE.md']);

/**
 * Project scope планов в минимальном контракте 0.3 — ровно один плоский каталог.
 * Program/phase layout (wiki/programs/...) появится вместе со своим registry;
 * до тех пор такие пути не перечисляются и не выдаются за проверенные — и ровно
 * ту же границу держит `isWikiRelativePlanRef`, поэтому preflight не может счесть
 * доказанным план, невидимый здесь.
 */
function planFileName(path: string): string | null {
  const match = /^wiki\/plans\/([^/]+\.md)$/.exec(path);
  const name = match?.[1];
  return name === undefined || NON_PLAN_FILES.has(name) ? null : name;
}

/**
 * Проверяет plan lifecycle по уже прочитанным wiki-документам.
 *
 * Один владелец правил: схема и state machine живут в core/plan.ts, здесь остаются
 * только проверки, которым нужны файловая система и перечисление планов.
 */
export function checkPlans(root: string, decoded: ReadonlyMap<string, string>, findings: DoctorFinding[]): void {
  const plans = new Map<string, PlanDocument>();
  for (const [path, text] of decoded) {
    if (planFileName(path) === null) continue;
    const meta = frontmatter(text);
    // Неразобранный frontmatter уже отмечен как wiki-frontmatter-invalid.
    if (meta === null) continue;
    const { plan, issues } = validatePlanFrontmatter(meta);
    for (const item of issues) findings.push(error(item.code, item.message, path));
    if (plan === null) continue;
    plans.set(path, plan);
    if (APPROVAL_REQUIRED_STATUSES.includes(plan.status) && plan.approvedDigest !== null && !planDigestMatches(plan.approvedDigest, text)) {
      findings.push(error('plan-changed-after-approval', 'Текст утверждённого плана изменился после утверждения (approved_digest не совпадает). Покажите изменения человеку; после повторного «план утверждаю» запишите новый отпечаток из вывода preflight.', path));
    }
  }

  const byId = new Map<string, string[]>();
  for (const [path, plan] of plans) byId.set(plan.id, [...(byId.get(plan.id) ?? []), path]);
  for (const [id, paths] of byId) {
    if (paths.length > 1) {
      for (const path of paths) findings.push(error('plan-duplicate-id', `Plan id ${id} объявлен в нескольких планах: ${paths.join(', ')}.`, path));
    }
  }

  for (const [path, plan] of plans) {
    if (plan.supersedes !== null && !byId.has(plan.supersedes)) {
      findings.push(error('plan-supersedes-unresolved', `Поле supersedes ссылается на неизвестный в project scope план: ${plan.supersedes}.`, path));
    }
    for (const source of plan.sources) {
      // Внешняя provenance-ссылка намеренно не проверяется: её разрешение — не файловая операция.
      if (isExternalSourceRef(source)) continue;
      if (!existsSync(join(root, source))) findings.push(error('plan-source-missing', `Объявленный project-relative source отсутствует: ${source}.`, path));
    }
  }

  const hot = decoded.get(HOT_PATH);
  if (hot === undefined) return;
  const hotMeta = frontmatter(hot);
  if (hotMeta === null) return;

  /**
   * Обратная совместимость с 0.2: у созданных ранее проектов поля active_plan нет.
   * Отсутствие поля читается как none — это единственное значение, совместимое
   * с проектом, в котором каталога планов ещё не существовало. Ломать такие
   * проекты можно только осознанным migration/version решением, а не молча.
   */
  const declared = hotMeta.active_plan ?? ACTIVE_PLAN_NONE;
  if (declared !== ACTIVE_PLAN_NONE && (!isWikiRelativePlanRef(declared) || !existsSync(join(root, 'wiki', declared)))) {
    findings.push(error('hot-active-plan-invalid', 'Contract: hot.md active_plan должен быть none либо существующим планом в wiki/plans/.', HOT_PATH));
    return;
  }

  const active = [...plans.entries()].filter(([, plan]) => plan.status === 'active').map(([path]) => path).sort();
  if (active.length > 1) {
    findings.push(error('plan-multiple-active', `В project scope допустим не более одного active плана; найдены: ${active.join(', ')}.`));
    return;
  }
  /**
   * Тот же договор, что у preflight: объявленный план утверждён (approved — работа
   * ещё не начата, active — идёт), а план со status: active обязан быть объявлен.
   */
  if (declared === ACTIVE_PLAN_NONE) {
    if (active.length === 1) {
      findings.push(error('hot-active-plan-mismatch', `План ${active[0]} имеет status: active, но не объявлен: запишите active_plan: ${active[0]!.slice('wiki/'.length)} в wiki/hot.md.`, HOT_PATH));
    }
    return;
  }
  const declaredPlan = plans.get(`wiki/${declared}`);
  if (active.length === 1 && active[0] !== `wiki/${declared}`) {
    findings.push(error('hot-active-plan-mismatch', `В hot.md объявлен ${declared}, а status: active у ${active[0]}: активный план один, и он объявлен.`, HOT_PATH));
  } else if (declaredPlan !== undefined && !APPROVAL_REQUIRED_STATUSES.includes(declaredPlan.status)) {
    findings.push(error('hot-active-plan-mismatch', `Объявленный план ${declared} имеет status: ${declaredPlan.status}; объявлять можно только утверждённый план (approved или active).`, HOT_PATH));
  }
}
