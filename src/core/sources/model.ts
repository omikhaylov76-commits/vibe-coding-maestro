/**
 * Модель безопасной инвентаризации существующих исходников (Planning Gate, Phase 4).
 *
 * Отчёт описывает чужой проект как evidence, а не как решение: каждое утверждение
 * либо доказано путём/полем манифеста, либо честно объявлено `UNKNOWN`. Абсолютных
 * путей в модели нет — артефакт обязан оставаться переносимым между машинами.
 */

import { SOURCE_OWNERSHIP } from './contract.js';

export type SourceFindingLevel = 'error' | 'warning' | 'info';

export interface SourceFinding {
  level: SourceFindingLevel;
  code: string;
  message: string;
  /** id источника, если находка относится к одному источнику. */
  source?: string;
}

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Что найдено по пути источника; `symlink` закрывает источник, а не следует по ссылке. */
export type SourceType = 'directory' | 'file' | 'symlink' | 'missing' | 'other';

/** Переносимое описание источника: относительный путь вместо абсолютного. */
export interface SourceOrigin {
  descriptor: string;
  /** false, если относительный путь невозможен (например, другой диск Windows). */
  portable: boolean;
  outsideProject: boolean;
}

export type RemoteOmitReason = 'local-path' | 'unparsable';

export interface SourceGitRemote {
  name: string;
  /** null означает «URL опущен»: причина указана в `omitted`. */
  url: string | null;
  sanitized: boolean;
  omitted: RemoteOmitReason | null;
}

export interface SourceGit {
  isRepo: boolean;
  /** Путь корня репозитория относительно источника: `.`, `..` и так далее. */
  rootDescriptor: string | null;
  /** true, если источник — подкаталог чужого репозитория. */
  rootIsAncestor: boolean;
  branch: string | null;
  head: string | null;
  /** null — состояние рабочего дерева не выяснено. */
  dirty: boolean | null;
  remotes: SourceGitRemote[];
  /** Вложенные репозитории: их история не является историей источника. */
  nestedRepos: string[];
}

export interface SourceEcosystem {
  id: string;
  evidence: string[];
}

export type CapabilityState = 'DETECTED' | 'UNKNOWN';

export interface SourceCapability {
  id: string;
  state: CapabilityState;
  evidence: string[];
}

export type RevisionKind = 'git-head' | 'metadata-fingerprint' | 'unknown';

export interface SourceRevision {
  kind: RevisionKind;
  value: string | null;
  dirty: boolean | null;
  /** Отпечаток ограниченного обхода: путь и размер, без времени и содержимого. */
  fingerprint: string | null;
}

export interface SourceScanStats {
  entries: number;
  truncated: boolean;
  secretsSkipped: number;
  symlinksSkipped: number;
  skippedDirs: number;
}

export interface SourceOwnership {
  owner: 'external';
  allowedAction: typeof SOURCE_OWNERSHIP;
}

export interface SourceRecord {
  id: string;
  label: string;
  origin: SourceOrigin;
  exists: boolean;
  type: SourceType;
  readable: boolean;
  /** id ранее описанного источника с тем же realpath; null — источник самостоятельный. */
  duplicateOf: string | null;
  ownership: SourceOwnership;
  git: SourceGit | null;
  packageName: string | null;
  ecosystems: SourceEcosystem[];
  entrypoints: string[];
  buildConfig: string[];
  testConfig: string[];
  deployConfig: string[];
  capabilities: SourceCapability[];
  revision: SourceRevision;
  scan: SourceScanStats;
  limitations: string[];
  unknowns: string[];
}

export interface EcosystemSplit {
  source: string;
  ecosystems: string[];
}

export type CollisionKind = 'label' | 'package-name' | 'realpath';

export interface IntegrationCollision {
  kind: CollisionKind;
  value: string;
  sources: string[];
}

export interface IntegrationBoundary {
  source: string;
  independentBuild: boolean;
  independentDeploy: 'YES' | 'UNKNOWN';
  evidence: string[];
}

export interface IntegrationSeam {
  id: string;
  /** Шов всегда остаётся предложением: владельца и контракт назначает человек. */
  kind: 'PROPOSAL';
  summary: string;
  sources: string[];
  evidence: string[];
  confidence: Confidence;
  owner: null;
}

export type RecommendationAction = 'wrap' | 'adapt' | 'migrate' | 'defer';

export interface RecommendationReason {
  code: string;
  message: string;
  evidence: string[];
}

export interface IntegrationRecommendation {
  action: RecommendationAction;
  kind: 'PROPOSAL';
  confidence: Confidence;
  reasons: RecommendationReason[];
  /** Инвентаризация ничего не выполняет: решение принимает человек. */
  requiresHumanDecision: true;
}

export interface IntegrationMatrix {
  sources: string[];
  commonEcosystems: string[];
  distinctEcosystems: EcosystemSplit[];
  collisions: IntegrationCollision[];
  boundaries: IntegrationBoundary[];
  seams: IntegrationSeam[];
  recommendation: IntegrationRecommendation;
}

export interface AnalyzeLimits {
  maxDepth: number;
  maxEntries: number;
  maxFileBytes: number;
}

export interface SourceInventoryReport {
  reportVersion: 1;
  /** Отчёт всегда получен чтением: запись — отдельный шаг с явным флагом. */
  mode: 'analyze';
  ownership: typeof SOURCE_OWNERSHIP;
  ok: boolean;
  limits: AnalyzeLimits;
  sources: SourceRecord[];
  integration: IntegrationMatrix;
  findings: SourceFinding[];
}

export type HumanIntent = 'create' | 'replace';

export interface ArtifactProvenance {
  tool: string;
  version: string;
  generatedAt: string;
  humanIntent: HumanIntent;
  /** sha256 заменённого артефакта; null при первой записи. */
  replaces: string | null;
  inputs: string[];
}

export interface SourceInventoryArtifact {
  artifact: string;
  artifactVersion: 1;
  provenance: ArtifactProvenance;
  report: SourceInventoryReport;
}

/** Строковый порядок по кодовым точкам: одинаковый на всех платформах и локалях. */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const LEVEL_RANK: Readonly<Record<SourceFindingLevel, number>> = { error: 0, warning: 1, info: 2 };

export function sortSourceFindings(findings: readonly SourceFinding[]): SourceFinding[] {
  return [...findings].sort((left, right) =>
    LEVEL_RANK[left.level] - LEVEL_RANK[right.level]
    || compareText(left.code, right.code)
    || compareText(left.source ?? '', right.source ?? '')
    || compareText(left.message, right.message));
}

export const finding = (
  level: SourceFindingLevel,
  code: string,
  message: string,
  source?: string,
): SourceFinding => ({ level, code, message, ...(source === undefined ? {} : { source }) });
