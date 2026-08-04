import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { REQUIRED_GITIGNORE_ENTRIES } from '../src/core/gitignore.js';
import { CHECKSUMS_PATH } from '../src/core/manifest.js';
import {
  cleanupTempDirs,
  FIXED_DATE,
  FIXED_NOW,
  isDir,
  listFiles,
  makeTempDir,
  readJson,
  readUtf8,
  sha256,
  snapshotTree,
} from './helpers.js';

afterEach(async () => {
  await cleanupTempDirs();
});

/** Общий вызов: git отключён, чтобы изолировать файловую логику от Git. */
async function init(target: string, overrides: Record<string, unknown> = {}) {
  return initProject({
    target,
    name: 'Тестовый проект',
    startingPoint: 'idea',
    git: false,
    now: FIXED_NOW,
    ...overrides,
  } as Parameters<typeof initProject>[0]);
}

describe('initProject: пустая папка', () => {
  it('создаёт минимальное дерево и сообщает об успехе', async () => {
    const target = await makeTempDir();
    const result = await init(target);

    expect(result.ok).toBe(true);
    expect(result.createdFiles.length).toBeGreaterThan(0);

    const files = await listFiles(target);
    for (const expected of [
      '.maestro/manifest.json',
      '.maestro/checksums.json',
      '.gitignore',
      'CLAUDE.md',
      'AGENTS.md',
      'wiki/hot.md',
      'wiki/index.md',
      'wiki/log.md',
      'wiki/roadmap.md',
      'wiki/concepts/discovery.md',
      'maestro/inbox/README.md',
    ]) {
      expect(files).toContain(expected);
    }
  });

  it('создаёт ленивые каталоги с .gitkeep, чтобы они не считались сиротами', async () => {
    const target = await makeTempDir();
    await init(target);

    for (const dir of [
      'maestro/sources',
      'maestro/runbooks',
      'wiki/progress',
      'wiki/decisions',
      'wiki/audits',
      'wiki/handoffs',
      'wiki/attic',
    ]) {
      expect(await isDir(join(target, dir))).toBe(true);
      expect(existsSync(join(target, dir, '.gitkeep'))).toBe(true);
    }
  });

  it('подставляет название проекта и дату только во frontmatter', async () => {
    const target = await makeTempDir();
    await init(target);

    const hot = await readUtf8(target, 'wiki/hot.md');
    expect(hot).toContain('Тестовый проект');
    expect(hot).toContain(FIXED_DATE);
    expect(hot).not.toContain('ГГГГ-ММ-ДД');

    // В журнале документированный формат в теле обязан сохраниться.
    const log = await readUtf8(target, 'wiki/log.md');
    expect(log).toContain('ГГГГ-ММ-ДД');
    expect(log.split('---')[1]).not.toContain('ГГГГ-ММ-ДД');
  });

  it('пишет файлы в UTF-8 без BOM и с LF', async () => {
    const target = await makeTempDir();
    await init(target);

    const raw = await readFile(join(target, 'wiki/hot.md'));
    expect(raw[0]).not.toBe(0xef);
    expect(raw.includes(Buffer.from('\r\n'))).toBe(false);
    expect(raw.toString('utf8')).toContain('Тестовый проект');
  });

  it('берёт название из имени папки, если --name не задан', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'мой-проект');
    const result = await initProject({
      target,
      startingPoint: 'idea',
      git: false,
      now: FIXED_NOW,
    });

    expect(result.ok).toBe(true);
    const manifest = await readJson<{ project: { name: string } }>(target, '.maestro/manifest.json');
    expect(manifest.project.name).toBe('мой-проект');
  });
});

describe('initProject: несуществующая папка', () => {
  it('создаёт папку вместе с промежуточными уровнями', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'a', 'b', 'новый проект');
    expect(existsSync(target)).toBe(false);

    const result = await init(target);

    expect(result.ok).toBe(true);
    expect(await isDir(target)).toBe(true);
    expect(existsSync(join(target, 'CLAUDE.md'))).toBe(true);
  });
});

describe('initProject: непустая чужая папка', () => {
  it.each(['foreign-product', 'incomplete-inventory'] as const)('не принимает structurally-valid подложный manifest: %s', async (variant) => {
    const canonical = await makeTempDir('canonical-source-');
    await init(canonical);
    const manifest = await readJson<any>(canonical, '.maestro/manifest.json');

    const target = await makeTempDir(`forged-${variant}-`);
    await writeFile(join(target, 'app.ts'), 'export const foreign = true;\n', 'utf8');
    await mkdir(join(target, '.maestro'), { recursive: true });
    if (variant === 'foreign-product') manifest.product.name = 'not-maestro';
    else {
      manifest.managed = manifest.managed.slice(0, 1);
      manifest.inventory = manifest.inventory.slice(0, 1);
    }
    await writeFile(join(target, '.maestro/manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const before = await snapshotTree(target);

    const result = await init(target, { force: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не является каноническим проектом/i);
    expect(await snapshotTree(target)).toEqual(before);
  });

  it('не принимает скопированный canonical manifest при неполном фактическом дереве и одинаковом basename', async () => {
    const canonicalParent = await makeTempDir('canonical-copy-source-');
    const canonical = join(canonicalParent, 'same-project');
    await init(canonical);
    const manifest = await readJson<any>(canonical, '.maestro/manifest.json');

    const targetParent = await makeTempDir('forged-complete-manifest-');
    const target = join(targetParent, 'same-project');
    await mkdir(join(target, '.maestro'), { recursive: true });
    await writeFile(join(target, 'app.ts'), 'export const foreign = true;\n', 'utf8');
    await writeFile(join(target, '.maestro/manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const before = await snapshotTree(target);

    const result = await init(target, { force: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не является каноническим проектом|неполное.*дерево/i);
    expect(await snapshotTree(target)).toEqual(before);
  });
  it('ничего не меняет и возвращает понятную ошибку', async () => {
    const target = await makeTempDir();
    await writeFile(join(target, 'важное.txt'), 'мои данные\n', 'utf8');
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');

    const before = await snapshotTree(target);
    const result = await init(target);
    const after = await snapshotTree(target);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не является каноническим проектом/i);
    expect(after).toEqual(before);
    expect(existsSync(join(target, '.maestro'))).toBe(false);
  });

  it('--force не обходит каноническую границу и не пишет ни байта', async () => {
    const target = await makeTempDir();
    await writeFile(join(target, 'важное.txt'), 'мои данные\n', 'utf8');
    const before = await snapshotTree(target);

    const result = await init(target, { force: true });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не является каноническим проектом/i);
    expect(await snapshotTree(target)).toEqual(before);
    expect(existsSync(join(target, '.maestro'))).toBe(false);
  });

  it('игнорирует .git и .DS_Store при проверке пустоты', async () => {
    const target = await makeTempDir();
    await mkdir(join(target, '.git'), { recursive: true });
    await writeFile(join(target, '.DS_Store'), 'x', 'utf8');

    const result = await init(target);
    expect(result.ok).toBe(true);
  });
});

describe('initProject: повторный запуск', () => {
  it('принимает canonical manifest старой product.version и обновляет его текущей версией', async () => {
    const target = await makeTempDir();
    await init(target);
    const manifest = await readJson<any>(target, '.maestro/manifest.json');
    manifest.product.version = '0.1.0-old';
    await writeFile(join(target, '.maestro/manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    const result = await init(target);

    expect(result.ok).toBe(true);
    const updated = await readJson<any>(target, '.maestro/manifest.json');
    expect(updated.product.version).not.toBe('0.1.0-old');
    expect(updated.project.id).toBe(manifest.project.id);
    expect(updated.project.depth).toBe(manifest.project.depth);
  });

  it('идемпотентен на неизменённом проекте', async () => {
    const target = await makeTempDir();
    await init(target);
    const before = await snapshotTree(target);

    const second = await init(target);

    expect(second.ok).toBe(true);
    expect(await snapshotTree(target)).toEqual(before);
    expect(second.createdFiles).toEqual([]);
  });

  it('не перезаписывает изменённый managed-файл и сообщает о сохранении', async () => {
    const target = await makeTempDir();
    await init(target);

    const myContent = '# Мои правки, которые нельзя терять\n';
    await writeFile(join(target, 'wiki/hot.md'), myContent, 'utf8');

    const second = await init(target);

    expect(second.ok).toBe(true);
    expect(await readUtf8(target, 'wiki/hot.md')).toBe(myContent);
    expect(second.preservedFiles).toContain('wiki/hot.md');
  });

  it('не удаляет пользовательские файлы внутри дерева проекта', async () => {
    const target = await makeTempDir();
    await init(target);
    await writeFile(join(target, 'wiki/progress/feature-1.md'), 'мой прогресс\n', 'utf8');
    await writeFile(join(target, 'my-code.ts'), 'const a = 1;\n', 'utf8');

    await init(target);

    expect(await readUtf8(target, 'wiki/progress/feature-1.md')).toBe('мой прогресс\n');
    expect(await readUtf8(target, 'my-code.ts')).toBe('const a = 1;\n');
  });

  it('не достраивает неполное canonical-дерево и не пишет ни байта', async () => {
    const target = await makeTempDir();
    await init(target);
    await rm(join(target, 'wiki/index.md'));
    const before = await snapshotTree(target);

    const second = await init(target);

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/не является каноническим проектом|неполное.*дерево/i);
    expect(existsSync(join(target, 'wiki/index.md'))).toBe(false);
    expect(await snapshotTree(target)).toEqual(before);
  });

  it('даже с --force сохраняет изменённый пользователем managed-файл', async () => {
    const target = await makeTempDir();
    await init(target);
    await writeFile(join(target, 'CLAUDE.md'), 'мои инструкции\n', 'utf8');

    const second = await init(target, { force: true });

    expect(second.ok).toBe(true);
    expect(await readUtf8(target, 'CLAUDE.md')).toBe('мои инструкции\n');
    expect(second.preservedFiles).toContain('CLAUDE.md');
  });
});

describe('initProject: .gitignore', () => {
  it('создаёт .gitignore с обязательными записями', async () => {
    const target = await makeTempDir();
    await init(target);

    const lines = (await readUtf8(target, '.gitignore')).split('\n');
    for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
      expect(lines).toContain(entry);
    }
  });


  it('не меняет .gitignore при повторном init', async () => {
    const target = await makeTempDir();
    await init(target);
    const first = await readUtf8(target, '.gitignore');

    await init(target);

    expect(await readUtf8(target, '.gitignore')).toBe(first);
  });
});

describe('initProject: сложные пути', () => {
  it('работает с пробелами в пути', async () => {
    const target = await makeTempDir('vcm тест с пробелами ');
    const result = await init(target);
    expect(result.ok).toBe(true);
    expect(existsSync(join(target, '.maestro/manifest.json'))).toBe(true);
  });

  it('работает с кириллицей в пути', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'проекты', 'мой проект №1');
    const result = await init(target);
    expect(result.ok).toBe(true);
    const manifest = await readJson<{ project: { name: string } }>(target, '.maestro/manifest.json');
    expect(manifest.project.name).toBe('мой проект №1');
  });

  it('отказывается работать, если цель — существующий файл, а не папка', async () => {
    const parent = await makeTempDir();
    const target = join(parent, 'файл.txt');
    await writeFile(target, 'данные', 'utf8');

    const result = await init(target);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/не папка|файл/i);
    expect(await readUtf8(parent, 'файл.txt')).toBe('данные');
  });
});
