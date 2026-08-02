import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv } from 'ajv';
import { initProject } from '../src/core/init.js';
import { classifyFile, loadManifest, MANIFEST_PATH, CHECKSUMS_PATH } from '../src/core/manifest.js';
import { MANIFEST_SCHEMA_VERSION } from '../src/core/meta.js';
import { schemasDir } from '../src/core/paths.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readJson, sha256 } from './helpers.js';

afterEach(async () => {
  await cleanupTempDirs();
});

async function init(target: string, overrides: Record<string, unknown> = {}) {
  return initProject({
    target,
    name: 'Проект манифеста',
    startingPoint: 'idea',
    git: false,
    now: FIXED_NOW,
    ...overrides,
  } as Parameters<typeof initProject>[0]);
}

interface Manifest {
  schemaVersion: number;
  product: { name: string; version: string; createdBy: string };
  project: { name: string; startingPoint: string; createdAt: string };
  managed: { path: string; kind: string }[];
}

describe('манифест: схема', () => {
  it('созданный manifest.json валиден по JSON Schema', async () => {
    const target = await makeTempDir();
    await init(target);

    const schema = JSON.parse(await readFile(join(schemasDir(), 'manifest.schema.json'), 'utf8'));
    const manifest = await readJson<Manifest>(target, MANIFEST_PATH);

    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const valid = validate(manifest);

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('содержит версию схемы, продукт и параметры проекта', async () => {
    const target = await makeTempDir();
    await init(target, { startingPoint: 'code' });
    const manifest = await readJson<Manifest>(target, MANIFEST_PATH);

    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.product.name).toBe('create-vibe-maestro');
    expect(manifest.project.startingPoint).toBe('code');
    expect(manifest.project.createdAt).toBe(FIXED_NOW.toISOString());
  });

  it('checksums.json содержит sha256 для каждого managed-файла', async () => {
    const target = await makeTempDir();
    await init(target);

    const manifest = await loadManifest(target);
    const checksums = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);

    const managedDocs = manifest.managed.filter((m) => m.kind === 'managed');
    expect(managedDocs.length).toBeGreaterThan(0);

    for (const entry of managedDocs) {
      const actual = sha256(await readFile(join(target, entry.path)));
      expect(checksums.files[entry.path]).toBe(actual);
    }
  });

  it('не включает сам manifest.json и checksums.json в список хешей (нет самоссылки)', async () => {
    const target = await makeTempDir();
    await init(target);
    const checksums = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);

    expect(checksums.files[MANIFEST_PATH]).toBeUndefined();
    expect(checksums.files[CHECKSUMS_PATH]).toBeUndefined();
  });

  it('.gitignore помечен как merged, а не managed: он принадлежит пользователю', async () => {
    const target = await makeTempDir();
    await init(target);
    const manifest = await loadManifest(target);

    const entry = manifest.managed.find((m) => m.path === '.gitignore');
    expect(entry?.kind).toBe('merged');

    const checksums = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);
    expect(checksums.files['.gitignore']).toBeUndefined();
  });
});

describe('различение managed и пользовательских файлов', () => {
  it('classifyFile определяет managed, merged, generated и user', async () => {
    const target = await makeTempDir();
    await init(target);
    const manifest = await loadManifest(target);

    expect(classifyFile(manifest, 'wiki/hot.md')).toBe('managed');
    expect(classifyFile(manifest, '.gitignore')).toBe('merged');
    expect(classifyFile(manifest, MANIFEST_PATH)).toBe('generated');
    expect(classifyFile(manifest, 'wiki/progress/моя-фича.md')).toBe('user');
    expect(classifyFile(manifest, 'src/index.ts')).toBe('user');
  });

  it('изменённый managed-файл определяется по несовпадению checksum', async () => {
    const target = await makeTempDir();
    await init(target);

    const checksumsBefore = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);
    const original = checksumsBefore.files['wiki/index.md'];
    await writeFile(join(target, 'wiki/index.md'), 'изменено пользователем\n', 'utf8');
    const actual = sha256(await readFile(join(target, 'wiki/index.md')));

    expect(actual).not.toBe(original);
  });

  it('повторный init не переписывает checksum изменённого пользователем файла', async () => {
    const target = await makeTempDir();
    await init(target);
    const before = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);

    await writeFile(join(target, 'wiki/index.md'), 'мои правки\n', 'utf8');
    await init(target);

    const after = await readJson<{ files: Record<string, string> }>(target, CHECKSUMS_PATH);
    expect(after.files['wiki/index.md']).toBe(before.files['wiki/index.md']);
  });
});
