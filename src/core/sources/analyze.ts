/**
 * Инвентаризация существующих исходников (Planning Gate, Phase 4).
 *
 * Команда отвечает на один вопрос: что уже существует и что об этом доказуемо
 * известно. Она ничего не изменяет, не копирует и не преобразует; чужой проект
 * остаётся своим собственным источником истины с единственным разрешённым
 * действием `READ_ONLY_SOURCE`. Всё, что не подтверждено путём или полем
 * манифеста, остаётся `UNKNOWN` и попадает в раздел ограничений.
 */

import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalizeSystemTempPrefix } from '../platform-paths.js';
import { SOURCE_OWNERSHIP } from './contract.js';
import {
  detectBuildConfig,
  detectCapabilities,
  detectDeployConfig,
  detectEcosystems,
  detectEntrypoints,
  detectTestConfig,
  readPackageManifest,
} from './detect.js';
import { readGitMetadata, systemGit } from './git.js';
import type { GitRunner } from './git.js';
import { buildIntegrationMatrix } from './integration.js';
import { compareText, finding, sortSourceFindings } from './model.js';
import type {
  AnalyzeLimits,
  SourceFinding,
  SourceInventoryReport,
  SourceOrigin,
  SourceRecord,
  SourceType,
} from './model.js';
import { DEFAULT_LIMITS, scanSourceTree } from './scan.js';
import type { ScanResult } from './scan.js';

export { DEFAULT_LIMITS } from './scan.js';

export interface AnalyzeRequest {
  /** Канонический проект-получатель: нужен для переносимых относительных путей. */
  projectPath: string;
  sources: readonly string[];
}

export interface AnalyzeOptions {
  limits?: Partial<AnalyzeLimits>;
  git?: GitRunner;
}

const EMPTY_SCAN = { entries: 0, truncated: false, secretsSkipped: 0, symlinksSkipped: 0, skippedDirs: 0 };

/** Устойчивый id источника: без пробелов и регистра, но с сохранением не-ASCII имён. */
export function sourceSlug(label: string): string {
  const slug = label.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'source' : slug.slice(0, 60);
}

function originOf(projectRoot: string, absolute: string): SourceOrigin {
  const raw = relative(projectRoot, absolute);
  if (raw === '') return { descriptor: '.', portable: true, outsideProject: false };
  if (isAbsolute(raw) || raw === '') return { descriptor: basename(absolute), portable: false, outsideProject: true };
  const descriptor = raw.split(sep).join('/');
  return { descriptor, portable: true, outsideProject: descriptor === '..' || descriptor.startsWith('../') };
}

async function sourceTypeOf(absolute: string): Promise<SourceType> {
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return 'missing';
  }
}

const emptyRecord = (id: string, label: string, origin: SourceOrigin, type: SourceType): SourceRecord => ({
  id,
  label,
  origin,
  exists: type !== 'missing',
  type,
  readable: false,
  duplicateOf: null,
  ownership: { owner: 'external', allowedAction: SOURCE_OWNERSHIP },
  git: null,
  packageName: null,
  ecosystems: [],
  entrypoints: [],
  buildConfig: [],
  testConfig: [],
  deployConfig: [],
  capabilities: [],
  revision: { kind: 'unknown', value: null, dirty: null, fingerprint: null },
  scan: { ...EMPTY_SCAN },
  limitations: [],
  unknowns: [],
});

async function describeDirectory(
  absolute: string,
  record: SourceRecord,
  limits: AnalyzeLimits,
  git: GitRunner,
  findings: SourceFinding[],
): Promise<void> {
  const scan: ScanResult = await scanSourceTree(absolute, limits);
  const manifest = await readPackageManifest(absolute, scan, limits);

  record.readable = true;
  record.scan = {
    entries: scan.entries,
    truncated: scan.truncated,
    secretsSkipped: scan.secretsSkipped,
    symlinksSkipped: scan.symlinksSkipped,
    skippedDirs: scan.skippedDirs,
  };
  record.packageName = manifest?.name ?? null;
  record.ecosystems = detectEcosystems(scan, manifest);
  record.entrypoints = detectEntrypoints(scan);
  record.buildConfig = detectBuildConfig(scan, manifest);
  record.testConfig = detectTestConfig(scan, manifest);
  record.deployConfig = detectDeployConfig(scan, manifest);
  record.capabilities = detectCapabilities(scan, manifest);

  const gitMeta = await readGitMetadata(absolute, scan.nestedRepos, git);
  record.git = gitMeta;
  record.revision = {
    kind: gitMeta.head !== null ? 'git-head' : 'metadata-fingerprint',
    value: gitMeta.head ?? scan.fingerprint,
    dirty: gitMeta.dirty,
    fingerprint: scan.fingerprint,
  };

  if (scan.truncated) {
    record.limitations.push(`Обход усечён на пределе ${limits.maxEntries} записей: список доказательств неполон.`);
    findings.push(finding('warning', 'source-scan-truncated', `Обход источника усечён на пределе ${limits.maxEntries} записей.`, record.id));
  }
  if (scan.secretsSkipped > 0) {
    record.limitations.push(`Пропущено путей с признаками секретов: ${scan.secretsSkipped}; их имена и содержимое не публикуются.`);
    findings.push(finding('info', 'source-secrets-skipped', `Пути с признаками секретов пропущены без чтения: ${scan.secretsSkipped}.`, record.id));
  }
  if (scan.symlinksSkipped > 0) {
    record.limitations.push(`Пропущено symbolic link: ${scan.symlinksSkipped}; переход по ссылке не выполняется.`);
    findings.push(finding('warning', 'source-symlinks-skipped', `Symbolic link не раскрываются: пропущено ${scan.symlinksSkipped}.`, record.id));
  }
  if (scan.unreadableDirs > 0) {
    record.limitations.push(`Недоступных для чтения каталогов: ${scan.unreadableDirs}.`);
    findings.push(finding('warning', 'source-unreadable-dirs', `Часть каталогов недоступна для чтения: ${scan.unreadableDirs}.`, record.id));
  }
  if (scan.nestedRepos.length > 0) {
    record.limitations.push(`Вложенные репозитории: ${scan.nestedRepos.join(', ')}; их история не принадлежит источнику.`);
    findings.push(finding('warning', 'source-nested-git', `Внутри источника есть вложенные репозитории: ${scan.nestedRepos.length}.`, record.id));
  }
  if (!gitMeta.isRepo) {
    record.unknowns.push('Git-метаданные недоступны: каталог не является репозиторием или git недоступен.');
  } else {
    if (gitMeta.dirty === true) {
      record.limitations.push('Рабочее дерево грязное: незакоммиченные изменения делают ревизию невоспроизводимой.');
      findings.push(finding('warning', 'source-git-dirty', 'Рабочее дерево источника содержит незакоммиченные изменения.', record.id));
    }
    if (gitMeta.dirty === null) record.unknowns.push('Состояние рабочего дерева не выяснено.');
    if (gitMeta.branch === null) record.unknowns.push('Ветка не определена: HEAD отделён или репозиторий пуст.');
    if (gitMeta.rootIsAncestor) {
      record.limitations.push(`Источник — подкаталог репозитория (${gitMeta.rootDescriptor}): Git-состояние описывает весь репозиторий.`);
      findings.push(finding('warning', 'source-git-root-differs', 'Источник является подкаталогом чужого репозитория.', record.id));
    }
  }
}

/**
 * Читает существующие исходники и собирает отчёт.
 *
 * Гарантия по умолчанию: ни один путь — ни в источнике, ни в проекте — не
 * создаётся, не изменяется и не удаляется. Запись артефакта выполняется отдельной
 * функцией и только по явному решению человека.
 */
export async function analyzeSources(request: AnalyzeRequest, options: AnalyzeOptions = {}): Promise<SourceInventoryReport> {
  const limits: AnalyzeLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const git = options.git ?? systemGit;
  const projectRoot = await canonicalizeSystemTempPrefix(resolve(request.projectPath));
  const findings: SourceFinding[] = [];
  const records: SourceRecord[] = [];
  const usedIds = new Set<string>();
  const byRealpath = new Map<string, string>();

  for (const input of request.sources) {
    const absolute = await canonicalizeSystemTempPrefix(resolve(input));
    const label = basename(absolute);
    const base = sourceSlug(label);
    let id = base;
    for (let index = 2; usedIds.has(id); index += 1) id = `${base}-${index}`;
    usedIds.add(id);

    const type = await sourceTypeOf(absolute);
    const record = emptyRecord(id, label, originOf(projectRoot, absolute), type);

    if (type === 'missing') {
      findings.push(finding('error', 'source-missing', 'Источник не найден по указанному пути.', id));
      records.push(record);
      continue;
    }
    if (type === 'symlink') {
      // Fail closed: переход по ссылке мог бы вывести обход за пределы источника.
      findings.push(finding('error', 'source-symlink-root', 'Источник является symbolic link и не читается.', id));
      record.limitations.push('Symbolic link как корень источника не раскрывается: укажите реальный путь.');
      records.push(record);
      continue;
    }
    if (type !== 'directory') {
      record.readable = type === 'file';
      record.unknowns.push('Источник не является каталогом проекта: структура и сборка не выясняются.');
      findings.push(finding('info', 'source-not-a-directory', `Источник не является каталогом (${type}).`, id));
      records.push(record);
      continue;
    }

    let real = absolute;
    try {
      real = await realpath(absolute);
    } catch {
      real = absolute;
    }
    const twin = byRealpath.get(real);
    if (twin !== undefined) {
      record.duplicateOf = twin;
      record.readable = true;
      record.limitations.push(`Тот же каталог уже описан как ${twin}: повторный обход не выполняется.`);
      findings.push(finding('warning', 'source-duplicate', `Источник указывает на тот же каталог, что и ${twin}.`, id));
      records.push(record);
      continue;
    }
    byRealpath.set(real, id);

    await describeDirectory(absolute, record, limits, git, findings);
    records.push(record);
  }

  records.sort((left, right) => compareText(left.id, right.id));
  const integration = buildIntegrationMatrix(records, findings);
  const sorted = sortSourceFindings(findings);

  return {
    reportVersion: 1,
    mode: 'analyze',
    ownership: SOURCE_OWNERSHIP,
    ok: !sorted.some((item) => item.level === 'error'),
    limits,
    sources: records,
    integration,
    findings: sorted,
  };
}
