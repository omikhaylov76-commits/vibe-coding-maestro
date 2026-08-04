import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { parsePorcelainV1Z } from '../src/core/doctor/git.js';
import { initProject } from '../src/core/init.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, sha256 } from './helpers.js';

/**
 * Регрессионные контракты по дефектам базовой линии D1–D5.
 *
 * Изначально каждый блок содержал парный тест «текущее поведение», фиксировавший баг.
 * Продуктовые исправления применены, поэтому характеризация багов удалена: остались
 * только контракты желаемого поведения, которые защищают исправления от регрессии.
 */

const exec = promisify(execFile);

afterEach(cleanupTempDirs);

type Report = Awaited<ReturnType<typeof doctorProject>>;

const codes = (report: Report): string[] => report.findings.map((finding) => finding.code);
const blockingFindings = (report: Report): Report['findings'] =>
  report.findings.filter((finding) => finding.level === 'critical' || finding.level === 'error');

async function init(target: string, options: { force?: boolean; git?: boolean } = {}) {
  return initProject({
    target,
    name: 'Phase 0',
    startingPoint: 'idea',
    force: options.force ?? false,
    git: options.git ?? false,
    now: FIXED_NOW,
  });
}

async function gitOut(target: string, args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: target })).stdout;
}

describe('D2: Git-контроль канонического проекта', () => {
  it('не переусердствовать: отслеживаемая правка управляемого документа остаётся git-managed-dirty', async () => {
    const target = await makeTempDir('vcm phase0 dirty tracked ');
    expect((await init(target, { git: true })).ok).toBe(true);
    // Инициализация с git создаёт чистый первый commit, где wiki/index.md отслеживается.
    expect(await gitOut(target, ['status', '--porcelain'])).toBe('');
    expect(await gitOut(target, ['ls-files', '--error-unmatch', 'wiki/index.md'])).toMatch(/wiki\/index\.md/);

    await writeFile(join(target, 'wiki/index.md'), `${await readUtf8(target, 'wiki/index.md')}\nправка в рабочем дереве\n`, 'utf8');
    expect(await gitOut(target, ['status', '--porcelain'])).toMatch(/^ M wiki\/index\.md$/m);

    const report = await doctorProject(target);

    expect(report.findings).toContainEqual(
      expect.objectContaining({ level: 'error', code: 'git-managed-dirty', path: 'wiki/index.md' }),
    );
    expect(report.ok).toBe(false);
  });
});

describe('D3: обычная работа с wiki/hot.md и wiki/log.md', () => {
  /** Правки строго в рамках документированного контракта: frontmatter не нарушен, log.md только дописан. */
  async function projectAfterNormalEditing(prefix: string): Promise<string> {
    const target = await makeTempDir(prefix);
    expect((await init(target)).ok).toBe(true);

    const hot = await readUtf8(target, 'wiki/hot.md');
    await writeFile(
      join(target, 'wiki/hot.md'),
      hot.replace('- Пока ничего. Первый шаг — заполнить `wiki/roadmap.md`.', '- Готовим первый этап.'),
      'utf8',
    );

    const log = await readUtf8(target, 'wiki/log.md');
    await writeFile(join(target, 'wiki/log.md'), `${log}\n## 2026-08-02 — первая запись\n\n- **Что сделано** — проект создан.\n`, 'utf8');

    return target;
  }

  it('желаемое поведение: содержательные правки wiki не считаются повреждением', async () => {
    const target = await projectAfterNormalEditing('vcm phase0 edit desired ');

    const report = await doctorProject(target);

    expect(report.findings.filter((finding) => finding.code === 'managed-modified')).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('D4: разбор git status --porcelain=v1 -z для переименований', () => {
  /**
   * В формате -z переименование занимает две NUL-записи: «R  <новый>» и «<старый>».
   * Вторая запись — чистый путь без XY-префикса, поэтому наивный срез первых трёх символов
   * превращал `ab/wiki/hot.md` в `wiki/hot.md` и попадал в managed docs.
   */
  async function repoWithRenamedNeighbour(prefix: string): Promise<string> {
    const target = await makeTempDir(prefix);
    expect((await init(target, { git: true })).ok).toBe(true);
    expect(await gitOut(target, ['status', '--porcelain'])).toBe('');

    const decoyDir = join(target, 'ab', 'wiki');
    await mkdir(decoyDir, { recursive: true });
    await writeFile(join(decoyDir, 'hot.md'), '# чужой файл в подкаталоге ab/wiki\n', 'utf8');
    await exec('git', ['add', 'ab/wiki/hot.md'], { cwd: target });
    await exec('git', ['commit', '-m', 'файл-обманка'], { cwd: target });
    await exec('git', ['mv', 'ab/wiki/hot.md', 'ab/wiki/hot-renamed.md'], { cwd: target });

    return target;
  }

  it('желаемое поведение: переименование чужого файла не пачкает управляемый документ', async () => {
    const target = await repoWithRenamedNeighbour('vcm phase0 rename desired ');

    // Фикстура: сам wiki/hot.md закоммичен и чист, а переименование видно в porcelain.
    const porcelain = await gitOut(target, ['status', '--porcelain']);
    expect(porcelain).not.toMatch(/wiki\/hot\.md$/m);
    expect(porcelain).toMatch(/^R {2}ab\/wiki\/hot\.md -> ab\/wiki\/hot-renamed\.md$/m);

    const report = await doctorProject(target);

    expect(report.findings.filter((finding) => finding.code === 'git-managed-dirty')).toEqual([]);
    expect(report.ok).toBe(true);
  });

  describe('parsePorcelainV1Z', () => {
    it('переименование занимает две записи: путь-источник не становится отдельной записью', () => {
      const output = 'R  ab/wiki/hot-renamed.md\0ab/wiki/hot.md\0';

      expect(parsePorcelainV1Z(output)).toEqual([
        { status: 'R ', path: 'ab/wiki/hot-renamed.md', originalPath: 'ab/wiki/hot.md' },
      ]);
    });

    it('копирование разбирается так же, как переименование', () => {
      const output = 'C  wiki/copy.md\0wiki/index.md\0';

      expect(parsePorcelainV1Z(output)).toEqual([
        { status: 'C ', path: 'wiki/copy.md', originalPath: 'wiki/index.md' },
      ]);
    });

    it('обычные и неотслеживаемые записи разбираются по одной, статус сохраняется', () => {
      const output = ' M wiki/index.md\0?? wiki/новый.md\0MM CLAUDE.md\0 D wiki/log.md\0';

      expect(parsePorcelainV1Z(output)).toEqual([
        { status: ' M', path: 'wiki/index.md' },
        { status: '??', path: 'wiki/новый.md' },
        { status: 'MM', path: 'CLAUDE.md' },
        { status: ' D', path: 'wiki/log.md' },
      ]);
    });

    it('смешанный вывод: записи после переименования не сдвигаются', () => {
      const output = ' M wiki/index.md\0R  ab/wiki/hot-renamed.md\0ab/wiki/hot.md\0?? maestro/sources/input.txt\0';

      expect(parsePorcelainV1Z(output)).toEqual([
        { status: ' M', path: 'wiki/index.md' },
        { status: 'R ', path: 'ab/wiki/hot-renamed.md', originalPath: 'ab/wiki/hot.md' },
        { status: '??', path: 'maestro/sources/input.txt' },
      ]);
    });

    it('пустой вывод даёт пустой список', () => {
      expect(parsePorcelainV1Z('')).toEqual([]);
      expect(parsePorcelainV1Z('\0')).toEqual([]);
    });
  });
});

describe('D5: удаление .maestro/source-hashes.json после регистрации sources', () => {
  const METADATA = '.maestro/source-hashes.json';

  /** Проект с зарегистрированным source: metadata существовала и была валидной. */
  async function projectWithRegisteredSource(prefix: string): Promise<string> {
    const target = await makeTempDir(prefix);
    expect((await init(target)).ok).toBe(true);
    await writeFile(join(target, 'maestro/sources/input.txt'), 'исходный материал', 'utf8');
    await writeFile(
      join(target, METADATA),
      `${JSON.stringify({ files: { 'maestro/sources/input.txt': sha256('исходный материал') } }, null, 2)}\n`,
      'utf8',
    );
    expect(codes(await doctorProject(target))).not.toContain('source-hash-mismatch');
    return target;
  }

  it('желаемое поведение: пропавшая metadata sources — это ошибка, а не отключение проверки', async () => {
    const target = await projectWithRegisteredSource('vcm phase0 sources desired ');
    await rm(join(target, METADATA));

    const report = await doctorProject(target);

    expect(blockingFindings(report).map((finding) => finding.path)).toContain(METADATA);
    expect(report.ok).toBe(false);
  });
});
