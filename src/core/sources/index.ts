/**
 * Публичная поверхность безопасной инвентаризации исходников (Planning Gate, Phase 4).
 *
 * Наружу выходят ровно две операции: чтение (`analyzeSources`) и явная запись
 * снимка в канонический проект (`writeSourceInventory`). Обратного направления —
 * копирования, преобразования или изменения источника — здесь нет и не появится:
 * это отдельный, утверждаемый человеком маршрут миграции.
 */

export { SOURCES_DIR, SOURCE_HASHES_PATH, SOURCE_OWNERSHIP } from './contract.js';
export { analyzeSources, DEFAULT_LIMITS, sourceSlug } from './analyze.js';
export type { AnalyzeOptions, AnalyzeRequest } from './analyze.js';
export { sanitizeRemoteUrl } from './git.js';
export type { GitRunner } from './git.js';
export { isSecretName } from './scan.js';
export { ARTIFACT_ID, buildArtifact, DEFAULT_OUTPUT_PATH, isAllowedOutputPath, writeSourceInventory } from './write.js';
export type { WriteRequest, WriteResult } from './write.js';
export type * from './model.js';
