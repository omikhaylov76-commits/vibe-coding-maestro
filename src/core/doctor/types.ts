/** Уровень и структура находки doctor. Публичный versioned contract. */
export type FindingLevel = 'critical' | 'error' | 'warning' | 'info';

export interface DoctorFinding {
  level: FindingLevel;
  code: string;
  message: string;
  path?: string;
}

export interface DoctorReport {
  reportVersion: 1;
  ok: boolean;
  root: string;
  findings: DoctorFinding[];
}

export interface DoctorOptions {
  strict?: boolean;
}

const makeFinding = (level: FindingLevel, code: string, message: string, path?: string): DoctorFinding =>
  ({ level, code, message, ...(path === undefined ? {} : { path }) });

export const critical = (code: string, message: string, path?: string): DoctorFinding =>
  makeFinding('critical', code, message, path);

export const error = (code: string, message: string, path?: string): DoctorFinding =>
  makeFinding('error', code, message, path);

export const warning = (code: string, message: string, path?: string): DoctorFinding =>
  makeFinding('warning', code, message, path);

export const info = (code: string, message: string, path?: string): DoctorFinding =>
  makeFinding('info', code, message, path);

const SEVERITY_RANK: Readonly<Record<FindingLevel, number>> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export function sortFindings(findings: readonly DoctorFinding[]): DoctorFinding[] {
  const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  return [...findings].sort((left, right) =>
    SEVERITY_RANK[left.level] - SEVERITY_RANK[right.level]
    || compareText(left.code, right.code)
    || compareText(left.path ?? '', right.path ?? '')
    || compareText(left.message, right.message));
}

export function findingsPass(findings: readonly DoctorFinding[], strict = false): boolean {
  return findings.every((item) => item.level === 'info' || (!strict && item.level === 'warning'));
}
