import { parseAudit } from '../audits.js';
import { parseFlowList } from '../plan.js';
import type { ProjectDisk } from './disk.js';
import { linkTargets } from './links.js';
import { withoutBom } from './markdown.js';
import type { PlanFile } from './plan.js';

export const AUDITS_ARCHIVE_DIR = 'wiki/audits/archive';

export const AUDIT_FILE_RE = /^wiki\/audits\/([^/]+\.md)$/;

export interface KeptAudit {
  path: string;
  code: 'audit-open' | 'audit-malformed' | 'audit-plan-source' | 'audit-archive-exists' | 'audit-plan-changed';
  reason: string;
}

export interface AuditSelection {
  /** Старый путь → новый. */
  moved: Map<string, string>;
  kept: KeptAudit[];
}

/**
 * В архив уходят только закрытые отчёты. Открытые остаются: их видят `/status`,
 * завершение и скрипты, и закрыть их можно позже.
 */
export function selectAudits(files: ReadonlyMap<string, string>, plans: readonly PlanFile[], disk: ProjectDisk): AuditSelection {
  const moved = new Map<string, string>();
  const kept: KeptAudit[] = [];
  const sources = new Set(plans.flatMap((plan) => parseFlowList(plan.meta?.sources ?? '[]') ?? []).map((source) => disk.locate('', source) ?? source));
  const changed = plans.filter((plan) => plan.guarded && !plan.intact).map((plan) => ({ path: plan.path, links: linkTargets(plan.text, plan.path, disk.locate) }));
  for (const [path, text] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const name = AUDIT_FILE_RE.exec(path)?.[1];
    if (name === undefined) continue;
    const target = `${AUDITS_ARCHIVE_DIR}/${name}`;
    const audit = parseAudit(withoutBom(text));
    const blockingPlan = changed.find((plan) => plan.links.has(path));
    if (audit.malformed) kept.push({ path, code: 'audit-malformed', reason: 'doctor не разобрал отчёт (audit-malformed): сначала поправьте его.' });
    else if (!audit.closed) kept.push({ path, code: 'audit-open', reason: 'отчёт открыт: в архив уходят только status: resolved.' });
    else if (sources.has(path)) kept.push({ path, code: 'audit-plan-source', reason: 'отчёт назван в sources плана.' });
    else if (disk.exists(target)) kept.push({ path, code: 'audit-archive-exists', reason: `в архиве уже есть ${target}: перезаписывать нельзя.` });
    else if (blockingPlan !== undefined) kept.push({ path, code: 'audit-plan-changed', reason: `на него ссылается ${blockingPlan.path}, а текст этого плана изменился после утверждения: ссылку править нельзя.` });
    else moved.set(path, target);
  }
  return { moved, kept };
}
