import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { analyzeSources, DEFAULT_LIMITS, SOURCE_OWNERSHIP } from '../src/core/sources/index.js';
import type { SourceInventoryReport, SourceRecord } from '../src/core/sources/index.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';
import {
  gitStatus,
  makeDicePokerFixture,
  makeDurakFixture,
  makePythonFixture,
  SECRET_VALUE,
  treeState,
  trySymlink,
  writeFixtureFile,
} from './source-fixtures.js';

/**
 * Phase 4 Planning Gate: безопасная инвентаризация существующих исходников.
 *
 * Контракт одной строкой: команда описывает чужой проект и ничего в нём не трогает.
 * Поэтому тесты доказывают не «поля заполнены», а границы: ноль записей, отсутствие
 * секретов, ограниченный обход, санитизированные remote и предложение вместо действия.
 */

afterEach(cleanupTempDirs);

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

const byId = (report: SourceInventoryReport, id: string): SourceRecord => {
  const found = report.sources.find((item) => item.id === id);
  expect(found, `источник ${id} отсутствует в отчёте: ${report.sources.map((item) => item.id).join(', ')}`).toBeDefined();
  return found!;
};

const capability = (record: SourceRecord, id: string): { state: string; evidence: string[] } => {
  const found = record.capabilities.find((item) => item.id === id);
  expect(found, `способность ${id} не объявлена`).toBeDefined();
  return found!;
};

describe('Phase 4: zero-write гарантия', () => {
  it('анализ не изменяет ни исходник, ни целевой проект', async () => {
    const workspace = await makeTempDir('vcm sources ');
    const project = join(workspace, 'портал');
    await mkdir(project, { recursive: true });
    const durak = await makeDurakFixture(workspace);

    // Обычный `git status` сам обновляет индекс, поэтому он вызывается до снимка:
    // любое изменение дерева после снимка — уже вина инвентаризации.
    await gitStatus(durak);
    const statusBefore = await gitStatus(durak);
    const before = await treeState(durak);
    const projectBefore = await treeState(project);

    const report = await analyzeSources({ projectPath: project, sources: [durak] });
    expect(report.ok).toBe(true);

    expect(await treeState(durak)).toEqual(before);
    expect(await treeState(project)).toEqual(projectBefore);
    expect(await gitStatus(durak)).toBe(statusBefore);
  });

  it('CLI без --write ничего не создаёт и печатает детерминированный JSON', async () => {
    const workspace = await makeTempDir('vcm sources cli ');
    const project = join(workspace, 'портал');
    await mkdir(project, { recursive: true });
    const durak = await makeDurakFixture(workspace);
    const before = await treeState(durak);
    const projectBefore = await treeState(project);

    const cli = collect();
    const code = await runMaestroCli(['sources', '--path', project, '--source', durak, '--json'], cli.io);
    expect(code).toBe(0);

    const report = JSON.parse(cli.stdout()) as SourceInventoryReport;
    expect(report.reportVersion).toBe(1);
    expect(report.mode).toBe('analyze');
    expect(await treeState(durak)).toEqual(before);
    expect(await treeState(project)).toEqual(projectBefore);
  });

  it('каждый источник объявлен как READ_ONLY_SOURCE', async () => {
    const workspace = await makeTempDir('vcm sources ownership ');
    const durak = await makeDurakFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    expect(report.ownership).toBe(SOURCE_OWNERSHIP);
    for (const record of report.sources) {
      expect(record.ownership.allowedAction).toBe(SOURCE_OWNERSHIP);
      expect(record.ownership.owner).toBe('external');
    }
  });
});

describe('Phase 4: секреты и приватность', () => {
  it('секреты не читаются и не попадают в отчёт ни значением, ни именем файла', async () => {
    const workspace = await makeTempDir('vcm sources secrets ');
    const durak = await makeDurakFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(SECRET_VALUE);
    for (const name of ['.env', 'id_rsa', 'service-account']) {
      expect(serialized, name).not.toContain(name);
    }
    expect(byId(report, 'durak').scan.secretsSkipped).toBeGreaterThanOrEqual(4);
    expect(report.findings.some((item) => item.code === 'source-secrets-skipped')).toBe(true);
  });

  it('remote URL публикуется без учётных данных и query, а локальный путь опускается', async () => {
    const workspace = await makeTempDir('vcm sources remote ');
    const durak = await makeDurakFixture(workspace);
    const mirror = await makeDicePokerFixture(workspace, 'mirror', { git: { remote: join(workspace, 'bare.git') } });

    const report = await analyzeSources({ projectPath: workspace, sources: [durak, mirror] });
    const remote = byId(report, 'durak').git?.remotes[0];
    expect(remote?.url).toBe('https://github.com/example/durak.git');
    expect(remote?.sanitized).toBe(true);
    expect(JSON.stringify(report)).not.toContain('ghp_secrettoken');

    const localRemote = byId(report, 'mirror').git?.remotes[0];
    expect(localRemote?.url).toBeNull();
    expect(localRemote?.omitted).toBe('local-path');
  });

  it('артефакт портируем: абсолютных путей источника и проекта в нём нет', async () => {
    const workspace = await makeTempDir('vcm sources portable ');
    const project = join(workspace, 'портал');
    await mkdir(project, { recursive: true });
    const durak = await makeDurakFixture(workspace);

    const report = await analyzeSources({ projectPath: project, sources: [durak] });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(durak);
    expect(serialized).not.toContain(project);
    const origin = byId(report, 'durak').origin;
    expect(origin.descriptor).toBe('../durak');
    expect(origin.portable).toBe(true);
    expect(origin.outsideProject).toBe(true);
  });
});

describe('Phase 4: границы обхода', () => {
  it('обход ограничен детерминированным лимитом и помечает усечение', async () => {
    const workspace = await makeTempDir('vcm sources limit ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    for (let index = 0; index < 40; index += 1) {
      await writeFixtureFile(durak, `src/module-${String(index).padStart(3, '0')}.ts`, 'export const x = 1;\n');
    }

    const limited = await analyzeSources({ projectPath: workspace, sources: [durak] }, { limits: { maxEntries: 10 } });
    const record = byId(limited, 'durak');
    expect(record.scan.truncated).toBe(true);
    expect(record.scan.entries).toBeLessThanOrEqual(10);
    expect(record.limitations.join(' ')).toMatch(/усеч|предел/i);
    expect(limited.findings.some((item) => item.code === 'source-scan-truncated')).toBe(true);

    const again = await analyzeSources({ projectPath: workspace, sources: [durak] }, { limits: { maxEntries: 10 } });
    expect(JSON.stringify(again)).toBe(JSON.stringify(limited));
    expect(DEFAULT_LIMITS.maxEntries).toBeGreaterThan(100);
  });

  it('symlink внутри источника пропускается с находкой, а symlink-корень закрывает источник', async () => {
    const workspace = await makeTempDir('vcm sources symlink ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false });
    const outside = join(workspace, 'outside.txt');
    await writeFile(outside, 'снаружи\n', 'utf8');
    if (!await trySymlink(outside, join(durak, 'escape.txt'), 'file')) return;
    if (!await trySymlink(durak, join(workspace, 'durak-link'), 'dir')) return;

    const inside = await analyzeSources({ projectPath: workspace, sources: [durak] });
    expect(byId(inside, 'durak').scan.symlinksSkipped).toBe(1);
    expect(inside.findings.some((item) => item.code === 'source-symlinks-skipped')).toBe(true);

    const root = await analyzeSources({ projectPath: workspace, sources: [join(workspace, 'durak-link')] });
    const record = byId(root, 'durak-link');
    expect(record.type).toBe('symlink');
    expect(record.readable).toBe(false);
    expect(root.ok).toBe(false);
    expect(root.findings.some((item) => item.code === 'source-symlink-root')).toBe(true);
    expect(record.scan.entries).toBe(0);
  });

  it('содержимое читается только у разрешённых манифестов', async () => {
    const workspace = await makeTempDir('vcm sources read ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    await writeFixtureFile(durak, 'src/notes.md', `внутренняя заметка ${SECRET_VALUE}\n`);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
    // Значения скриптов package.json тоже не переносятся: только имена.
    expect(JSON.stringify(report)).not.toContain('vite build');
  });
});

describe('Phase 4: модель источника', () => {
  it('Git-репозиторий описан ветвью, HEAD, чистотой и воспроизводимой ревизией', async () => {
    const workspace = await makeTempDir('vcm sources git ');
    const durak = await makeDurakFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    const record = byId(report, 'durak');

    expect(record.git?.isRepo).toBe(true);
    expect(record.git?.branch).toBe('main');
    expect(record.git?.head).toMatch(/^[0-9a-f]{40}$/);
    expect(record.git?.dirty).toBe(false);
    expect(record.revision.kind).toBe('git-head');
    expect(record.revision.value).toBe(record.git?.head);
    expect(record.revision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('грязный репозиторий помечается и попадает в ограничения', async () => {
    const workspace = await makeTempDir('vcm sources dirty ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: { dirty: true, remote: 'git@github.com:example/durak.git' } });
    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    const record = byId(report, 'durak');
    expect(record.git?.dirty).toBe(true);
    expect(record.revision.dirty).toBe(true);
    expect(record.limitations.join(' ')).toMatch(/грязн|незакоммич/i);
    expect(record.git?.remotes[0]?.url).toBe('github.com:example/durak.git');
  });

  it('каталог без Git описан отпечатком метаданных, а не догадкой', async () => {
    const workspace = await makeTempDir('vcm sources nogit ');
    const python = await makePythonFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [python] });
    const record = byId(report, 'сервис-статистики');
    expect(record.git?.isRepo).toBe(false);
    expect(record.revision.kind).toBe('metadata-fingerprint');
    expect(record.revision.value).toMatch(/^[0-9a-f]{64}$/);
    expect(record.ecosystems.map((item) => item.id)).toContain('python');
    expect(record.unknowns.join(' ')).toMatch(/git/i);
  });

  it('вложенный репозиторий виден как находка, а не как молчаливое включение', async () => {
    const workspace = await makeTempDir('vcm sources nested ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    const nested = await makeDicePokerFixture(durak, 'packages-dice', { git: {}, secrets: false });
    expect(nested).toContain('packages-dice');

    const report = await analyzeSources({ projectPath: workspace, sources: [durak] });
    expect(byId(report, 'durak').git?.nestedRepos).toEqual(['packages-dice']);
    expect(report.findings.some((item) => item.code === 'source-nested-git')).toBe(true);
  });

  it('манифесты, точки входа и конфигурации даются как доказательные пути', async () => {
    const workspace = await makeTempDir('vcm sources evidence ');
    const durak = await makeDurakFixture(workspace);
    const record = byId(await analyzeSources({ projectPath: workspace, sources: [durak] }), 'durak');

    expect(record.ecosystems.map((item) => item.id)).toEqual(['docker', 'node', 'static-web']);
    expect(record.entrypoints).toContain('index.html');
    expect(record.buildConfig).toContain('vite.config.ts');
    expect(record.testConfig).toContain('package.json#scripts.test');
    expect(record.deployConfig).toContain('Dockerfile');
    for (const evidence of [...record.entrypoints, ...record.buildConfig, ...record.deployConfig]) {
      expect(evidence.startsWith('/'), evidence).toBe(false);
    }
    // node_modules не обходится: зависимости видны только по манифесту.
    expect(JSON.stringify(record)).not.toContain('left-pad');
  });

  it('способности либо доказаны, либо честно UNKNOWN', async () => {
    const workspace = await makeTempDir('vcm sources capabilities ');
    const durak = await makeDurakFixture(workspace);
    const python = await makePythonFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak, python] });

    const game = byId(report, 'durak');
    expect(capability(game, 'ui').state).toBe('DETECTED');
    expect(capability(game, 'realtime').evidence).toContain('package.json#dependencies.socket.io');
    expect(capability(game, 'auth').state).toBe('DETECTED');
    expect(capability(game, 'persistence').state).toBe('UNKNOWN');
    expect(capability(game, 'assets').evidence).toContain('assets');

    for (const record of report.sources) {
      for (const item of record.capabilities) {
        expect(item.state === 'DETECTED', `${record.id}:${item.id}`).toBe(item.evidence.length > 0);
      }
    }
    expect(capability(byId(report, 'сервис-статистики'), 'realtime').state).toBe('UNKNOWN');
  });
});

describe('Phase 4: пограничные входы', () => {
  it('отсутствующий источник — блокирующая находка, а не пустая запись', async () => {
    const workspace = await makeTempDir('vcm sources missing ');
    const report = await analyzeSources({ projectPath: workspace, sources: [join(workspace, 'нет-такого')] });
    const record = byId(report, 'нет-такого');
    expect(record.exists).toBe(false);
    expect(record.type).toBe('missing');
    expect(report.ok).toBe(false);
    expect(report.findings.some((item) => item.code === 'source-missing' && item.level === 'error')).toBe(true);

    const cli = collect();
    expect(await runMaestroCli(['sources', '--path', workspace, '--source', join(workspace, 'нет-такого')], cli.io)).toBe(1);
  });

  it('один и тот же путь дважды даёт один просканированный источник и явную находку', async () => {
    const workspace = await makeTempDir('vcm sources duplicate ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    const report = await analyzeSources({
      projectPath: workspace,
      sources: [durak, join(durak, '.', ''), join(workspace, 'durak', 'src', '..')],
    });

    expect(report.sources).toHaveLength(3);
    expect(report.sources.filter((item) => item.duplicateOf === null)).toHaveLength(1);
    expect(report.findings.some((item) => item.code === 'source-duplicate')).toBe(true);
    expect(report.integration.sources).toEqual(['durak']);
  });

  it('пути с пробелами и не-ASCII получают устойчивые id без коллизий', async () => {
    const workspace = await makeTempDir('vcm sources unicode ');
    const first = await makeDicePokerFixture(join(workspace, 'а'), 'dice poker', { secrets: false });
    await mkdir(join(workspace, 'б'), { recursive: true });
    const second = await makeDicePokerFixture(join(workspace, 'б'), 'dice poker', { secrets: false });
    const report = await analyzeSources({ projectPath: workspace, sources: [first, second] });

    expect(report.sources.map((item) => item.id)).toEqual(['dice-poker', 'dice-poker-2']);
    expect(report.sources.map((item) => item.label)).toEqual(['dice poker', 'dice poker']);
    expect(report.integration.collisions.some((item) => item.kind === 'label')).toBe(true);
  });

  it('файл вместо каталога описан честно и не блокирует остальные источники', async () => {
    const workspace = await makeTempDir('vcm sources file ');
    const file = join(workspace, 'заметки.md');
    await writeFile(file, '# материалы\n', 'utf8');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    const report = await analyzeSources({ projectPath: workspace, sources: [file, durak] });
    expect(byId(report, 'заметки-md').type).toBe('file');
    expect(byId(report, 'durak').readable).toBe(true);
  });
});

describe('Phase 4: матрица интеграции', () => {
  it('два источника дают общее, различное, коллизии и границы', async () => {
    const workspace = await makeTempDir('vcm sources matrix ');
    const durak = await makeDurakFixture(workspace);
    const dice = await makeDicePokerFixture(workspace);
    const report = await analyzeSources({ projectPath: workspace, sources: [durak, dice] });
    const matrix = report.integration;

    expect(matrix.sources).toEqual(['dice-poker', 'durak']);
    expect(matrix.commonEcosystems).toEqual(['node', 'static-web']);
    expect(matrix.distinctEcosystems).toContainEqual({ source: 'durak', ecosystems: ['docker'] });
    expect(matrix.boundaries.map((item) => item.source)).toEqual(['dice-poker', 'durak']);
    expect(matrix.boundaries.find((item) => item.source === 'durak')?.independentDeploy).toBe('YES');
    expect(matrix.boundaries.find((item) => item.source === 'dice-poker')?.independentDeploy).toBe('UNKNOWN');
    expect(matrix.boundaries.every((item) => item.independentBuild)).toBe(true);
  });

  it('швы предлагаются как PROPOSAL с доказательствами и уверенностью', async () => {
    const workspace = await makeTempDir('vcm sources seams ');
    const durak = await makeDurakFixture(workspace);
    const dice = await makeDicePokerFixture(workspace);
    const matrix = (await analyzeSources({ projectPath: workspace, sources: [durak, dice] })).integration;

    expect(matrix.seams.length).toBeGreaterThan(0);
    for (const seam of matrix.seams) {
      expect(seam.kind).toBe('PROPOSAL');
      expect(seam.owner).toBeNull();
      expect(seam.sources.length).toBeGreaterThanOrEqual(2);
      expect(seam.evidence.length).toBeGreaterThan(0);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(seam.confidence);
    }
    expect(matrix.seams.map((item) => item.id)).toContain('shell-ui');
  });

  it('рекомендация — предложение с доказательствами, а не действие', async () => {
    const workspace = await makeTempDir('vcm sources recommendation ');
    const durak = await makeDurakFixture(workspace);
    const dice = await makeDicePokerFixture(workspace);
    const recommendation = (await analyzeSources({ projectPath: workspace, sources: [durak, dice] })).integration.recommendation;

    expect(recommendation.action).toBe('wrap');
    expect(recommendation.kind).toBe('PROPOSAL');
    expect(recommendation.confidence).toBe('MEDIUM');
    expect(recommendation.reasons.length).toBeGreaterThan(0);
    expect(recommendation.reasons.every((item) => item.evidence.length > 0)).toBe(true);
    expect(recommendation.requiresHumanDecision).toBe(true);
  });

  it('недоступный источник переводит рекомендацию в defer', async () => {
    const workspace = await makeTempDir('vcm sources defer ');
    const durak = await makeDurakFixture(workspace, 'durak', { git: false, secrets: false });
    const report = await analyzeSources({ projectPath: workspace, sources: [durak, join(workspace, 'нет')] });
    expect(report.integration.recommendation.action).toBe('defer');
    expect(report.integration.recommendation.confidence).toBe('LOW');
    expect(report.integration.recommendation.reasons.map((item) => item.code)).toContain('source-unavailable');
  });

  it('одинаковое имя пакета в двух источниках объявлено коллизией', async () => {
    const workspace = await makeTempDir('vcm sources collision ');
    const first = await makeDicePokerFixture(workspace, 'первый', { secrets: false });
    const second = await makeDicePokerFixture(workspace, 'второй', { secrets: false });
    expect(second).not.toBe(first);
    const matrix = (await analyzeSources({ projectPath: workspace, sources: [first, second] })).integration;
    expect(matrix.collisions).toContainEqual({ kind: 'package-name', value: 'dice-poker', sources: ['второй', 'первый'] });
  });
});

describe('Phase 4: детерминизм и CLI', () => {
  it('повторный анализ неизменного дерева даёт побайтово тот же отчёт', async () => {
    const workspace = await makeTempDir('vcm sources determinism ');
    const durak = await makeDurakFixture(workspace);
    const dice = await makeDicePokerFixture(workspace);
    const first = await analyzeSources({ projectPath: workspace, sources: [durak, dice] });
    const second = await analyzeSources({ projectPath: workspace, sources: [dice, durak] });
    expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2));
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('команда sources требует хотя бы один --source и объявлена в справке', async () => {
    const usage = collect();
    expect(await runMaestroCli(['sources'], usage.io)).toBe(2);
    expect(usage.stderr()).toContain('--source');

    const help = collect();
    expect(await runMaestroCli(['--help'], help.io)).toBe(0);
    expect(help.stdout()).toContain('sources');
    expect(help.stdout()).toContain('--write');
  });

  it('флаги записи недоступны другим командам', async () => {
    const cli = collect();
    expect(await runMaestroCli(['doctor', '--write'], cli.io)).toBe(2);
    expect(cli.stderr()).toContain('sources');
  });

  it('человекочитаемый вывод называет ownership, рекомендацию и отсутствие записи', async () => {
    const workspace = await makeTempDir('vcm sources human ');
    const durak = await makeDurakFixture(workspace);
    const dice = await makeDicePokerFixture(workspace);
    const cli = collect();
    expect(await runMaestroCli(['sources', '--path', workspace, '--source', durak, '--source', dice], cli.io)).toBe(0);
    const text = cli.stdout();
    expect(text).toContain('READ_ONLY_SOURCE');
    expect(text.toLowerCase()).toContain('ничего не записано');
    expect(text).toContain('PROPOSAL');
  });
});
