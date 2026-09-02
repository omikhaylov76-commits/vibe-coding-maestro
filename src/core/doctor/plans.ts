import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_PLAN_NONE, isExternalSourceRef, isWikiRelativePlanRef, validatePlanFrontmatter } from '../plan.js';
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
    if (plan !== null) plans.set(path, plan);
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
  const expected = active.length === 0 ? ACTIVE_PLAN_NONE : active[0]!.slice('wiki/'.length);
  if (declared !== expected) {
    findings.push(error('hot-active-plan-mismatch', 'Contract: hot.md active_plan должен быть none либо путём единственного плана со status: active.', HOT_PATH));
  }
}
