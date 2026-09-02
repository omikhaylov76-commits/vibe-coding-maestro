/**
 * Канонический контракт plan-документа 0.3 (Planning Gate, Phase 0).
 *
 * Этот модуль — единственный владелец схемы frontmatter и state machine плана.
 * Doctor и любые будущие адаптеры обязаны читать правила отсюда и не повторять их
 * у себя: дублирование словарей неизбежно расходится. Файловые проверки
 * (существование путей, перечисление планов) живут в doctor и здесь недоступны.
 */

export const PLAN_KINDS = ['mini', 'feature', 'project', 'program', 'phase'] as const;
export const PLAN_STATUSES = ['draft', 'in_review', 'approved', 'active', 'blocked', 'completed', 'rejected', 'superseded'] as const;
export const PLAN_SCALES = ['quick', 'feature', 'project', 'program'] as const;
export const PLAN_MODES = ['greenfield', 'extension', 'integration', 'migration'] as const;
export const PLAN_GOVERNANCES = ['light', 'standard', 'advanced'] as const;
export const PLAN_RISKS = ['low', 'medium', 'high', 'critical'] as const;

export type PlanKind = (typeof PLAN_KINDS)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type PlanScale = (typeof PLAN_SCALES)[number];
export type PlanMode = (typeof PLAN_MODES)[number];
export type PlanGovernance = (typeof PLAN_GOVERNANCES)[number];
export type PlanRisk = (typeof PLAN_RISKS)[number];

/** Статусы, при которых человеческая approval metadata обязательна. */
export const APPROVAL_REQUIRED_STATUSES: readonly PlanStatus[] = ['approved', 'active'];

/**
 * Статусы до утверждения: approval metadata обязана отсутствовать.
 * Иначе черновик мог бы нести правдоподобную «подпись» и обходить human gate.
 */
export const APPROVAL_FORBIDDEN_STATUSES: readonly PlanStatus[] = ['draft', 'in_review', 'rejected'];

export const PLAN_REQUIRED_KEYS = [
  'id', 'kind', 'status', 'scale', 'mode', 'governance', 'risk', 'profiles',
  'created', 'updated', 'sources', 'supersedes', 'approved_by', 'approved_at', 'active_phase',
] as const;

/** Общие для wiki поля документа: допустимы, но контрактом плана не управляются. */
export const PLAN_OPTIONAL_KEYS = ['type', 'title'] as const;

/**
 * Машиночитаемые поля build gate.
 *
 * Свободный текст плана не парсится: «открытых вопросов нет» и «spec delta нет»
 * должны быть объявлены полем, а не фразой в теле, иначе проверка превращается в
 * хрупкий grep. Поля необязательны — черновик имеет право их не иметь. Их
 * ОТСУТСТВИЕ у утверждённого плана не делает документ невалидным, но закрывает
 * build gate: см. `core/preflight.ts`. Doctor проверяет документ, preflight —
 * право на исполнение; смешивать эти две роли нельзя.
 */
export const PLAN_GATE_KEYS = ['blocking_questions', 'spec_delta', 'current_slice', 'current_phase_approved'] as const;

export const PLAN_SPEC_DELTAS = ['none', 'open', 'resolved'] as const;
export type PlanSpecDelta = (typeof PLAN_SPEC_DELTAS)[number];

/** Явное «поля нет» и «фаза утверждена» во frontmatter, который умеет только строки. */
export const PLAN_PHASE_APPROVALS = ['yes', 'no'] as const;

/** Явное «поля нет» во frontmatter, который умеет только строки. */
export const PLAN_NULL = 'null';

export interface PlanDocument {
  id: string;
  kind: PlanKind;
  status: PlanStatus;
  scale: PlanScale;
  mode: PlanMode;
  governance: PlanGovernance;
  risk: PlanRisk;
  profiles: string[];
  created: string;
  updated: string;
  sources: string[];
  supersedes: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  activePhase: string | null;
  /** null означает «поле не объявлено»: для build gate это не то же самое, что 0. */
  blockingQuestions: number | null;
  specDelta: PlanSpecDelta | null;
  /** Ровно одна разрешённая порция. null — не объявлена либо явное `null`. */
  currentSlice: string | null;
  currentPhaseApproved: boolean | null;
}

/** Код совпадает с doctor finding code: диагностика одна и та же в обоих слоях. */
export type PlanIssueCode = 'plan-schema-invalid' | 'plan-state-invalid' | 'plan-approval-missing' | 'plan-approval-unexpected';

export interface PlanIssue {
  code: PlanIssueCode;
  field: string;
  message: string;
}

export interface PlanValidation {
  /** null, если документ нельзя считать планом: дальнейшие межфайловые проверки к нему неприменимы. */
  plan: PlanDocument | null;
  issues: PlanIssue[];
}

const PLAN_ID = /^PLAN-[0-9]{4,}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const APPROVAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PROFILE_TOKEN = /^[A-Z][A-Z0-9_]*$/;
const ACTIVE_PHASE_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9][0-9]*)$/;
/** Внешняя provenance-ссылка опознаётся по URI-схеме и намеренно не проверяется на диске. */
const EXTERNAL_SOURCE = /^[a-z][a-z0-9+.-]*:/i;

export function isPlanId(value: string): boolean {
  return PLAN_ID.test(value);
}

/** Дата обязана быть не только по форме, но и существовать в календаре. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** approved_at принимает и календарную дату, и UTC-отметку времени. */
export function isApprovalTimestamp(value: string): boolean {
  const match = APPROVAL_TIMESTAMP.exec(value);
  if (match === null) return isCalendarDate(value);
  return isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
}

export function isExternalSourceRef(value: string): boolean {
  return EXTERNAL_SOURCE.test(value);
}

/** Значение `active_plan`, означающее «активного плана нет». */
export const ACTIVE_PLAN_NONE = 'none';

/**
 * Ссылка на активный план в `hot.md`: путь относительно `wiki/`, как active_progress.
 *
 * Граница 0.3 beta: активный план обязан лежать в плоском `wiki/plans/` — ровно в
 * том каталоге, который doctor перечисляет и проверяет. `wiki/programs/<слаг>/` в
 * этой бете хранит проектные материалы программы и планами не считается.
 *
 * Сужение здесь, а не в одном из слоёв, принципиально: preflight не имеет права
 * признать доказанным документ, которого doctor не видит. Расширять границу до
 * program/phase layout можно только вместе с его registry — и сразу в обоих слоях,
 * потому что владелец правила один.
 */
export function isWikiRelativePlanRef(value: string): boolean {
  return /^plans\/[^/]+\.md$/.test(value) && isProjectRelativeSourceRef(value);
}

/**
 * Project-relative source: только внутрь проекта и без обхода дерева.
 * Тот же смысл, что и у isSafeProjectPath, но без зависимости от manifest-слоя.
 */
export function isProjectRelativeSourceRef(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\')) return false;
  const parts = value.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..') && parts[0] !== '.git';
}

/** Flow-массив YAML в его единственной поддерживаемой здесь форме: `[]` или `[a, b]`. */
export function parseFlowList(value: string): string[] | null {
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (inner === '') return [];
  const items = inner.split(',').map((item) => item.trim());
  return items.every((item) => item !== '') ? items : null;
}

const issue = (code: PlanIssueCode, field: string, message: string): PlanIssue => ({ code, field, message });

function enumField<T extends string>(
  meta: Readonly<Record<string, string>>,
  field: string,
  allowed: readonly T[],
  issues: PlanIssue[],
): T | null {
  const value = meta[field];
  if (value === undefined) return null;
  if (!(allowed as readonly string[]).includes(value)) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field} должно быть одним из: ${allowed.join(', ')}.`));
    return null;
  }
  return value as T;
}

function listField(
  meta: Readonly<Record<string, string>>,
  field: string,
  itemValid: (item: string) => boolean,
  expectation: string,
  issues: PlanIssue[],
): string[] | null {
  const value = meta[field];
  if (value === undefined) return null;
  const parsed = parseFlowList(value);
  if (parsed === null) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field} должно быть flow-массивом вида [] или [a, b].`));
    return null;
  }
  const invalid = parsed.filter((item) => !itemValid(item));
  if (invalid.length > 0) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field}: ${expectation}. Не подходит: ${invalid.join(', ')}.`));
    return null;
  }
  return parsed;
}

/** Читает поле, где строка `null` означает отсутствие значения. */
function nullableField(
  meta: Readonly<Record<string, string>>,
  field: string,
  valid: (value: string) => boolean,
  expectation: string,
  issues: PlanIssue[],
): { value: string | null } | null {
  const raw = meta[field];
  if (raw === undefined) return null;
  if (raw === PLAN_NULL) return { value: null };
  if (!valid(raw)) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field}: ${expectation}.`));
    return null;
  }
  return { value: raw };
}

/** Счётчик gate-поля: только неотрицательное целое, без `null` и без «нет». */
function intField(meta: Readonly<Record<string, string>>, field: string, issues: PlanIssue[]): number | null {
  const value = meta[field];
  if (value === undefined) return null;
  if (!NON_NEGATIVE_INTEGER.test(value)) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field} должно быть неотрицательным целым числом.`));
    return null;
  }
  return Number(value);
}

function dateField(meta: Readonly<Record<string, string>>, field: string, issues: PlanIssue[]): string | null {
  const value = meta[field];
  if (value === undefined) return null;
  if (!isCalendarDate(value)) {
    issues.push(issue('plan-schema-invalid', field, `Поле ${field} должно быть реальной датой YYYY-MM-DD.`));
    return null;
  }
  return value;
}

/**
 * Механически проверяет frontmatter plan-документа.
 *
 * Проверяется только то, что доказуемо в пределах одного файла: словари, форматы,
 * обязательность полей и согласованность статуса с approval metadata. Разрешение
 * supersedes, уникальность id и число active-планов требуют перечисления планов
 * и живут в doctor.
 */
export function validatePlanFrontmatter(meta: Readonly<Record<string, string>>): PlanValidation {
  const issues: PlanIssue[] = [];
  const allowed = new Set<string>([...PLAN_REQUIRED_KEYS, ...PLAN_OPTIONAL_KEYS, ...PLAN_GATE_KEYS]);

  for (const key of PLAN_REQUIRED_KEYS) {
    if (!(key in meta)) issues.push(issue('plan-schema-invalid', key, `Обязательное поле плана отсутствует: ${key}.`));
  }
  for (const key of Object.keys(meta)) {
    if (!allowed.has(key)) issues.push(issue('plan-schema-invalid', key, `Поле вне схемы плана: ${key}.`));
  }

  const id = meta.id;
  if (id !== undefined && !isPlanId(id)) {
    issues.push(issue('plan-schema-invalid', 'id', 'Поле id должно иметь вид PLAN-nnnn.'));
  }

  const kind = enumField(meta, 'kind', PLAN_KINDS, issues);
  const status = enumField(meta, 'status', PLAN_STATUSES, issues);
  const scale = enumField(meta, 'scale', PLAN_SCALES, issues);
  const mode = enumField(meta, 'mode', PLAN_MODES, issues);
  const governance = enumField(meta, 'governance', PLAN_GOVERNANCES, issues);
  const risk = enumField(meta, 'risk', PLAN_RISKS, issues);

  const profiles = listField(meta, 'profiles', (item) => PROFILE_TOKEN.test(item), 'элементы — токены ВЕРХНИМ_РЕГИСТРОМ', issues);
  const sources = listField(
    meta,
    'sources',
    (item) => isExternalSourceRef(item) || isProjectRelativeSourceRef(item),
    'элементы — project-relative пути или внешние URI',
    issues,
  );

  const created = dateField(meta, 'created', issues);
  const updated = dateField(meta, 'updated', issues);

  // supersedes в минимальном контракте — только plan id: путь/registry resolution отложены.
  const supersedes = nullableField(meta, 'supersedes', isPlanId, 'допустимо null или PLAN-nnnn', issues);
  const approvedBy = nullableField(meta, 'approved_by', (value) => value.length > 0, 'допустимо null или имя утвердившего человека', issues);
  const approvedAt = nullableField(meta, 'approved_at', isApprovalTimestamp, 'допустимо null, дата YYYY-MM-DD или UTC-отметка времени', issues);
  const activePhase = nullableField(meta, 'active_phase', (value) => ACTIVE_PHASE_TOKEN.test(value), 'допустимо null или идентификатор фазы', issues);

  const blockingQuestions = intField(meta, 'blocking_questions', issues);
  const specDelta = enumField(meta, 'spec_delta', PLAN_SPEC_DELTAS, issues);
  const currentSlice = nullableField(meta, 'current_slice', (value) => ACTIVE_PHASE_TOKEN.test(value), 'допустимо null или идентификатор порции', issues);
  const currentPhaseApproved = enumField(meta, 'current_phase_approved', PLAN_PHASE_APPROVALS, issues);

  if (status !== null && approvedBy !== null && approvedAt !== null) {
    const hasApproval = approvedBy.value !== null && approvedAt.value !== null;
    if (APPROVAL_REQUIRED_STATUSES.includes(status) && !hasApproval) {
      issues.push(issue('plan-approval-missing', 'status', `Статус ${status} требует approved_by и approved_at.`));
    }
    if (APPROVAL_FORBIDDEN_STATUSES.includes(status) && (approvedBy.value !== null || approvedAt.value !== null)) {
      issues.push(issue('plan-approval-unexpected', 'status', `Статус ${status} не утверждён человеком и не может нести approved_by/approved_at.`));
    }
  }

  if (id !== undefined && supersedes?.value === id) {
    issues.push(issue('plan-state-invalid', 'supersedes', 'План не может замещать сам себя.'));
  }
  if (kind !== null && activePhase !== null && activePhase.value !== null && kind !== 'program') {
    issues.push(issue('plan-state-invalid', 'active_phase', 'Поле active_phase имеет смысл только для kind: program.'));
  }
  if (kind !== null && kind !== 'program' && currentPhaseApproved !== null) {
    issues.push(issue('plan-state-invalid', 'current_phase_approved', 'Поле current_phase_approved имеет смысл только для kind: program.'));
  }

  if (issues.length > 0) return { plan: null, issues };

  // Все поля проверены выше; отсутствие любого из них уже дало бы issue.
  return {
    plan: {
      id: id!,
      kind: kind!,
      status: status!,
      scale: scale!,
      mode: mode!,
      governance: governance!,
      risk: risk!,
      profiles: profiles!,
      created: created!,
      updated: updated!,
      sources: sources!,
      supersedes: supersedes!.value,
      approvedBy: approvedBy!.value,
      approvedAt: approvedAt!.value,
      activePhase: activePhase!.value,
      blockingQuestions,
      specDelta,
      currentSlice: currentSlice === null ? null : currentSlice.value,
      currentPhaseApproved: currentPhaseApproved === null ? null : currentPhaseApproved === 'yes',
    },
    issues,
  };
}
