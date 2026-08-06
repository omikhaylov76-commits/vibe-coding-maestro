/**
 * Матрица интеграции нескольких существующих источников (Planning Gate, Phase 4).
 *
 * Матрица сравнивает уже доказанные факты и предлагает — но не выбирает.
 * Швы и рекомендация всегда `PROPOSAL`: направление интеграции меняет границы
 * продукта, а такое решение принимает человек в плане, а не механическая команда.
 * Действие `migrate` здесь не предлагается автоматически ни при каких данных:
 * перенос требует no-loss runbook, staging-копии и отдельного утверждения.
 */

import { compareText, finding } from './model.js';
import type {
  Confidence,
  IntegrationBoundary,
  IntegrationCollision,
  IntegrationMatrix,
  IntegrationRecommendation,
  IntegrationSeam,
  RecommendationReason,
  SourceFinding,
  SourceRecord,
} from './model.js';

const CONFIDENCE_ORDER: readonly Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];

function lower(confidence: Confidence): Confidence {
  const index = CONFIDENCE_ORDER.indexOf(confidence);
  return CONFIDENCE_ORDER[Math.max(0, index - 1)] as Confidence;
}

/** Источник участвует в сравнении, только если он прочитан и не дубликат. */
const isComparable = (record: SourceRecord): boolean =>
  record.readable && record.duplicateOf === null && record.type === 'directory';

function collisionsOf(records: readonly SourceRecord[]): IntegrationCollision[] {
  const collisions: IntegrationCollision[] = [];
  const group = (key: (record: SourceRecord) => string | null, kind: IntegrationCollision['kind']): void => {
    const buckets = new Map<string, string[]>();
    for (const record of records) {
      const value = key(record);
      if (value === null) continue;
      buckets.set(value, [...(buckets.get(value) ?? []), record.id]);
    }
    for (const [value, sources] of [...buckets.entries()].sort((left, right) => compareText(left[0], right[0]))) {
      if (sources.length > 1) collisions.push({ kind, value, sources: [...sources].sort(compareText) });
    }
  };
  group((record) => record.label, 'label');
  group((record) => record.packageName, 'package-name');
  return collisions;
}

function seamsOf(records: readonly SourceRecord[]): IntegrationSeam[] {
  const seams: IntegrationSeam[] = [];
  const propose = (id: string, capability: string, summary: string, confidence: Confidence): void => {
    const carriers = records.filter((record) =>
      record.capabilities.some((item) => item.id === capability && item.state === 'DETECTED'));
    if (carriers.length < 2) return;
    seams.push({
      id,
      kind: 'PROPOSAL',
      summary,
      sources: carriers.map((record) => record.id).sort(compareText),
      evidence: carriers.flatMap((record) =>
        record.capabilities.find((item) => item.id === capability)?.evidence.map((item) => `${record.id}:${item}`) ?? []).sort(compareText),
      confidence,
      owner: null,
    });
  };

  propose('shell-ui', 'ui', 'У источников есть собственный интерфейс: нужен владелец оболочки и навигации.', 'MEDIUM');
  propose('shared-identity', 'auth', 'Оба источника решают вопрос входа: возможен общий владелец идентичности.', 'MEDIUM');
  propose('data-ownership', 'persistence', 'Оба источника хранят данные: нужен явный владелец каждой сущности.', 'MEDIUM');
  propose('realtime-transport', 'realtime', 'Оба источника используют realtime: транспорт и переподключение нуждаются в контракте.', 'MEDIUM');

  const node = records.filter((record) => record.ecosystems.some((item) => item.id === 'node'));
  if (node.length >= 2) {
    seams.push({
      id: 'shared-tooling',
      kind: 'PROPOSAL',
      summary: 'Общая экосистема сборки допускает общий инструментарий, но не требует общего runtime.',
      sources: node.map((record) => record.id).sort(compareText),
      evidence: node.map((record) => `${record.id}:package.json`).sort(compareText),
      confidence: 'LOW',
      owner: null,
    });
  }
  return seams.sort((left, right) => compareText(left.id, right.id));
}

function recommend(
  records: readonly SourceRecord[],
  boundaries: readonly IntegrationBoundary[],
  unavailable: readonly SourceRecord[],
): IntegrationRecommendation {
  const reasons: RecommendationReason[] = [];
  const proposal = (action: IntegrationRecommendation['action'], confidence: Confidence): IntegrationRecommendation =>
    ({ action, kind: 'PROPOSAL', confidence, reasons, requiresHumanDecision: true });

  if (unavailable.length > 0) {
    reasons.push({
      code: 'source-unavailable',
      message: 'Часть указанных источников не прочитана: выводы об интеграции преждевременны.',
      evidence: unavailable.map((record) => `${record.id}:${record.type}`).sort(compareText),
    });
    return proposal('defer', 'LOW');
  }
  if (records.length === 0) {
    reasons.push({ code: 'no-sources', message: 'Ни один источник не описан.', evidence: ['sources:0'] });
    return proposal('defer', 'LOW');
  }

  const independentBuild = boundaries.filter((item) => item.independentBuild);
  const independentDeploy = boundaries.filter((item) => item.independentDeploy === 'YES');
  const truncated = records.filter((record) => record.scan.truncated);

  if (independentBuild.length === 0) {
    reasons.push({
      code: 'insufficient-evidence',
      message: 'Ни у одного источника нет доказанной независимой сборки: сначала нужны факты, а не решение.',
      evidence: records.map((record) => `${record.id}:build=0`).sort(compareText),
    });
    return proposal('defer', 'LOW');
  }

  if (independentBuild.length === boundaries.length) {
    reasons.push({
      code: 'independent-build-boundaries',
      message: 'Каждый источник собирается самостоятельно: оболочка вокруг автономных систем дешевле общего runtime.',
      evidence: independentBuild.flatMap((item) => item.evidence.map((value) => `${item.source}:${value}`)).sort(compareText),
    });
    let confidence: Confidence = independentDeploy.length === boundaries.length ? 'HIGH' : 'MEDIUM';
    if (independentDeploy.length !== boundaries.length) {
      reasons.push({
        code: 'deploy-boundary-unknown',
        message: 'Независимый deployment подтверждён не у всех источников.',
        evidence: boundaries.filter((item) => item.independentDeploy === 'UNKNOWN').map((item) => `${item.source}:deploy=UNKNOWN`).sort(compareText),
      });
    }
    if (truncated.length > 0) {
      confidence = lower(confidence);
      reasons.push({
        code: 'evidence-truncated',
        message: 'Обход части источников усечён: доказательная база неполна.',
        evidence: truncated.map((record) => `${record.id}:truncated`).sort(compareText),
      });
    }
    return proposal('wrap', confidence);
  }

  reasons.push({
    code: 'mixed-boundaries',
    message: 'Границы сборки разные: часть источников придётся адаптировать под общий контракт.',
    evidence: boundaries.map((item) => `${item.source}:build=${String(item.independentBuild)}`).sort(compareText),
  });
  return proposal('adapt', truncated.length > 0 ? 'LOW' : 'MEDIUM');
}

export function buildIntegrationMatrix(records: readonly SourceRecord[], findings: SourceFinding[]): IntegrationMatrix {
  const comparable = records.filter(isComparable);
  const unavailable = records.filter((record) => !record.readable && record.duplicateOf === null);

  const ecosystemsBySource = new Map(comparable.map((record) => [record.id, record.ecosystems.map((item) => item.id)]));
  const all = [...new Set([...ecosystemsBySource.values()].flat())].sort(compareText);
  const commonEcosystems = comparable.length === 0
    ? []
    : all.filter((id) => comparable.every((record) => ecosystemsBySource.get(record.id)?.includes(id) === true));

  const boundaries: IntegrationBoundary[] = comparable.map((record) => ({
    source: record.id,
    independentBuild: record.buildConfig.length > 0,
    independentDeploy: record.deployConfig.length > 0 ? 'YES' : 'UNKNOWN',
    evidence: [...record.buildConfig, ...record.deployConfig].sort(compareText),
  }));

  const collisions = collisionsOf(comparable);
  for (const record of records) {
    if (record.duplicateOf !== null) {
      collisions.push({ kind: 'realpath', value: record.duplicateOf, sources: [record.id, record.duplicateOf].sort(compareText) });
    }
  }
  collisions.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.value, right.value));
  if (collisions.some((item) => item.kind !== 'realpath')) {
    findings.push(finding('warning', 'source-collision', 'Имена источников или пакетов совпадают: при объединении потребуется явное пространство имён.'));
  }

  return {
    sources: comparable.map((record) => record.id).sort(compareText),
    commonEcosystems,
    distinctEcosystems: comparable
      .map((record) => ({
        source: record.id,
        ecosystems: (ecosystemsBySource.get(record.id) ?? []).filter((id) => !commonEcosystems.includes(id)),
      }))
      .sort((left, right) => compareText(left.source, right.source)),
    collisions,
    boundaries: boundaries.sort((left, right) => compareText(left.source, right.source)),
    seams: seamsOf(comparable),
    recommendation: recommend(comparable, boundaries, unavailable),
  };
}
