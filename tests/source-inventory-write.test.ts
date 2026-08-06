import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { sha256 as hash } from '../src/core/manifest.js';
import {
  analyzeSources,
  ARTIFACT_ID,
  DEFAULT_OUTPUT_PATH,
  writeSourceInventory,
} from '../src/core/sources/index.js';
import type { SourceInventoryArtifact } from '../src/core/sources/index.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';
import { makeDicePokerFixture, makeDurakFixture, treeState } from './source-fixtures.js';

/**
 * Phase 4: запись артефакта в канонический проект.
 *
 * Запись — исключение, а не режим по умолчанию. Тесты держат четыре границы:
 * канонический проект, разрешённый путь, отсутствие молчаливой перезаписи и
 * атомарность. Источник при этом остаётся нетронутым во всех сценариях.
 */

afterEach(cleanupTempDirs);

const GENERATED_AT = '2026-08-06T10:00:00.000Z';
const SOURCE_HASHES_PATH = '.maestro/source-hashes.json';

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

interface Workspace { workspace: string; project: string; durak: string; dice: string }

async function canonicalWorkspace(depth: 'light' | 'standard' | 'advanced' = 'standard'): Promise<Workspace> {
  const workspace = await makeTempDir(`vcm write ${depth} `);
  const project = join(workspace, 'портал');
  const result = await initProject({ target: project, name: 'Портал', startingPoint: 'materials', git: false, now: FIXED_NOW, depth });
  expect(result.ok, result.error).toBe(true);
  return { workspace, project, durak: await makeDurakFixture(workspace), dice: await makeDicePokerFixture(workspace) };
}

async function write(context: Workspace, options: { replace?: boolean; output?: string } = {}): Promise<{
  ok: boolean; findings: { code: string }[]; path: string | null;
}> {
  const report = await analyzeSources({ projectPath: context.project, sources: [context.durak, context.dice] });
  return writeSourceInventory(report, {
    projectPath: context.project,
    generatedAt: GENERATED_AT,
    ...options,
  });
}

async function sourcesDirEntries(project: string): Promise<string[]> {
  return (await readdir(join(project, 'maestro/sources'))).sort();
}

describe('Phase 4: запись артефакта в канонический проект', () => {
  it.each(['light', 'standard', 'advanced'] as const)('глубина %s: артефакт записан, hashes обновлены, doctor строго зелёный', async (depth) => {
    const context = await canonicalWorkspace(depth);
    const before = await treeState(context.durak);

    const result = await write(context);
    expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    expect(result.path).toBe(DEFAULT_OUTPUT_PATH);

    const raw = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');
    const artifact = JSON.parse(raw) as SourceInventoryArtifact;
    expect(artifact.artifact).toBe(ARTIFACT_ID);
    expect(artifact.provenance.generatedAt).toBe(GENERATED_AT);
    expect(artifact.provenance.humanIntent).toBe('create');
    expect(artifact.provenance.replaces).toBeNull();
    expect(artifact.provenance.inputs).toEqual(['../dice poker', '../durak']);
    expect(artifact.report.sources.map((item) => item.id)).toEqual(['dice-poker', 'durak']);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).not.toContain(context.workspace);

    const hashes = JSON.parse(await readFile(join(context.project, SOURCE_HASHES_PATH), 'utf8')) as { files: Record<string, string> };
    expect(hashes.files[DEFAULT_OUTPUT_PATH]).toBe(hash(Buffer.from(raw, 'utf8')));

    const report = await doctorProject(context.project, { strict: true });
    expect(report.findings, JSON.stringify(report.findings)).toEqual([]);
    expect(await treeState(context.durak)).toEqual(before);
  });

  it('повторный запуск не перезаписывает артефакт молча', async () => {
    const context = await canonicalWorkspace();
    expect((await write(context)).ok).toBe(true);
    const first = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');

    const second = await write(context);
    expect(second.ok).toBe(false);
    expect(second.findings.map((item) => item.code)).toContain('write-output-exists');
    expect(await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8')).toBe(first);
    expect(await sourcesDirEntries(context.project)).toEqual(['.gitkeep', 'source-inventory.json']);
    expect((await doctorProject(context.project, { strict: true })).ok).toBe(true);
  });

  it('--replace заменяет только собственный артефакт и записывает провенанс замены', async () => {
    const context = await canonicalWorkspace();
    expect((await write(context)).ok).toBe(true);
    const previous = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');

    const replaced = await write(context, { replace: true });
    expect(replaced.ok, JSON.stringify(replaced.findings)).toBe(true);
    const artifact = JSON.parse(await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8')) as SourceInventoryArtifact;
    expect(artifact.provenance.humanIntent).toBe('replace');
    expect(artifact.provenance.replaces).toBe(hash(Buffer.from(previous, 'utf8')));
    expect((await doctorProject(context.project, { strict: true })).ok).toBe(true);
  });

  it('--replace отказывается затирать чужой файл', async () => {
    const context = await canonicalWorkspace();
    const foreign = '{"важные":"данные"}\n';
    await writeFile(join(context.project, DEFAULT_OUTPUT_PATH), foreign, 'utf8');

    const result = await write(context, { replace: true });
    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toContain('write-output-foreign');
    expect(await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8')).toBe(foreign);
  });

  it('запись с фиксированными часами детерминирована побайтово', async () => {
    const context = await canonicalWorkspace();
    expect((await write(context)).ok).toBe(true);
    const first = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');
    expect((await write(context, { replace: true })).ok).toBe(true);
    const second = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');
    const withoutProvenance = (text: string): string => JSON.stringify((JSON.parse(text) as SourceInventoryArtifact).report);
    expect(withoutProvenance(second)).toBe(withoutProvenance(first));
  });
});

describe('Phase 4: границы записи', () => {
  it('неканонический проект не получает артефакт', async () => {
    const workspace = await makeTempDir('vcm write foreign ');
    const project = join(workspace, 'чужой');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'app.ts'), 'export const foreign = true;\n', 'utf8');
    const durak = await makeDurakFixture(workspace);
    const before = await treeState(project);

    const report = await analyzeSources({ projectPath: project, sources: [durak] });
    const result = await writeSourceInventory(report, { projectPath: project, generatedAt: GENERATED_AT });
    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toContain('write-not-canonical-project');
    expect(await treeState(project)).toEqual(before);
  });

  it('вывод вне maestro/sources отклоняется до любой записи', async () => {
    const context = await canonicalWorkspace();
    const before = await treeState(context.project);
    for (const output of ['wiki/hot.md', '../побег.json', 'maestro/sources/../../побег.json', 'maestro/sources/snapshot.md', '/tmp/побег.json']) {
      const result = await write(context, { output });
      expect(result.ok, output).toBe(false);
      expect(result.findings.map((item) => item.code), output).toContain('write-output-not-allowed');
    }
    expect(await treeState(context.project)).toEqual(before);
  });

  it('разрешённый вложенный путь внутри maestro/sources принимается', async () => {
    const context = await canonicalWorkspace();
    const output = 'maestro/sources/game-platform/inventory.json';
    expect((await write(context, { output })).ok).toBe(true);
    expect(existsSync(join(context.project, output))).toBe(true);
    expect((await doctorProject(context.project, { strict: true })).ok).toBe(true);
  });

  it('после отказа во временных файлах ничего не остаётся', async () => {
    const context = await canonicalWorkspace();
    expect((await write(context)).ok).toBe(true);
    expect((await write(context)).ok).toBe(false);
    expect(await sourcesDirEntries(context.project)).toEqual(['.gitkeep', 'source-inventory.json']);
    expect((await readdir(join(context.project, '.maestro'))).sort())
      .toEqual(['checksums.json', 'manifest.json', 'source-hashes.json']);
  });

  it('повреждённый source-hashes останавливает запись до изменения дерева', async () => {
    const context = await canonicalWorkspace();
    await writeFile(join(context.project, SOURCE_HASHES_PATH), 'не json\n', 'utf8');
    const before = await treeState(context.project);
    const result = await write(context);
    expect(result.ok).toBe(false);
    expect(result.findings.map((item) => item.code)).toContain('write-hashes-invalid');
    expect(await treeState(context.project)).toEqual(before);
  });
});

describe('Phase 4: CLI записи', () => {
  it('--write печатает путь артефакта и оставляет проект зелёным', async () => {
    const context = await canonicalWorkspace();
    const cli = collect();
    const code = await runMaestroCli(
      ['sources', '--path', context.project, '--source', context.durak, '--source', context.dice, '--write'],
      cli.io,
    );
    expect(code, cli.stderr()).toBe(0);
    expect(cli.stdout()).toContain(DEFAULT_OUTPUT_PATH);
    expect(existsSync(join(context.project, DEFAULT_OUTPUT_PATH))).toBe(true);
    expect((await doctorProject(context.project, { strict: true })).ok).toBe(true);
  });

  it('повторный --write без --replace завершается кодом 1 и не трогает файл', async () => {
    const context = await canonicalWorkspace();
    const first = collect();
    expect(await runMaestroCli(['sources', '--path', context.project, '--source', context.durak, '--write'], first.io)).toBe(0);
    const written = await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8');

    const second = collect();
    expect(await runMaestroCli(['sources', '--path', context.project, '--source', context.durak, '--write'], second.io)).toBe(1);
    expect(second.stderr()).toContain('--replace');
    expect(await readFile(join(context.project, DEFAULT_OUTPUT_PATH), 'utf8')).toBe(written);
  });

  it('--replace без --write не разрешён', async () => {
    const context = await canonicalWorkspace();
    const cli = collect();
    expect(await runMaestroCli(['sources', '--path', context.project, '--source', context.durak, '--replace'], cli.io)).toBe(2);
    expect(cli.stderr()).toContain('--write');
  });
});
