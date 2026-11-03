import { frontmatter } from './doctor/text.js';

/**
 * Разбор отчёта проверки: один для doctor и archive. Если бы archive считал
 * закрытым то, что doctor не разобрал, в архив уехал бы неразборчивый отчёт.
 */

const AUDIT_STATUSES: ReadonlySet<string> = new Set(['open', 'resolved']);

export interface ParsedAudit {
  /** Нет audit_id, допустимого status или валидных находок. */
  malformed: boolean;
  /** Разобран, `status: resolved`, и все находки resolved. */
  closed: boolean;
  /** Открытые critical и high. */
  blocking: { id: string; severity: string }[];
}

export function parseAudit(text: string): ParsedAudit {
  const meta = frontmatter(text);
  let malformed = !meta?.audit_id || !meta.status || !AUDIT_STATUSES.has(meta.status);
  const starts = [...text.matchAll(/^## Finding ([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/gm)];
  if (starts.length === 0) malformed = true;
  const blocking: ParsedAudit['blocking'] = [];
  const ids = new Set<string>();
  for (let index = 0; index < starts.length; index += 1) {
    const current = starts[index];
    const id = current?.[1] ?? '';
    const body = text.slice((current?.index ?? 0) + (current?.[0].length ?? 0), starts[index + 1]?.index ?? text.length);
    const fields = (name: string): string[] => [...body.matchAll(new RegExp(`^- ${name}:[ \\t]*(.*?)[ \\t]*$`, 'gm'))].map((match) => match[1]?.trim() ?? '');
    const severityValues = fields('severity'); const targetValues = fields('target'); const evidenceValues = fields('evidence'); const statusValues = fields('status'); const resolutionValues = fields('resolution');
    const severity = severityValues[0]; const status = statusValues[0];
    if (ids.has(id) || severityValues.length !== 1 || targetValues.length !== 1 || evidenceValues.length !== 1 || statusValues.length !== 1 || resolutionValues.length !== 1 || !['critical', 'high', 'medium', 'low'].includes(severity ?? '') || !targetValues[0] || !evidenceValues[0] || !AUDIT_STATUSES.has(status ?? '') || !resolutionValues[0]) malformed = true;
    else if (meta?.status !== 'open' && status === 'open') malformed = true;
    else if ((severity === 'critical' || severity === 'high') && status === 'open') blocking.push({ id, severity });
    ids.add(id);
  }
  // Разобранный отчёт `resolved` не содержит открытых находок: иначе он был бы malformed.
  return { malformed, closed: !malformed && meta?.status === 'resolved', blocking };
}
