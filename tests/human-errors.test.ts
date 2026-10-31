import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import { resolveProjectInput } from '../src/cli/desktop.js';
import { runMaestroCli } from '../src/cli/maestro.js';
import { describeFsError } from '../src/core/fs-errors.js';
import { initProject } from '../src/core/init.js';
import { buildPreflight } from '../src/core/preflight.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const locked: string[] = [];
afterEach(async () => {
  // Права возвращаются до уборки, иначе временную папку не удалить.
  for (const dir of locked.splice(0)) await chmod(dir, 0o755).catch(() => undefined);
  await cleanupTempDirs();
});

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

/** Права на запись в POSIX не работают на Windows и не действуют на root. */
const canLockFolders = process.platform !== 'win32' && process.getuid?.() !== 0;

async function readOnlyFolder(): Promise<string> {
  const dir = await makeTempDir('locked-');
  await chmod(dir, 0o555);
  locked.push(dir);
  return dir;
}

describe('ошибки файловой системы человеческими словами', () => {
  it.each([
    ['EACCES', 'Нет прав на запись'],
    ['EPERM', 'Нет прав на запись'],
    ['ENOSPC', 'закончилось место'],
    ['EROFS', 'только для чтения'],
    ['ENOENT', 'Путь не найден'],
    ['ENOTDIR', 'файл, а не папка'],
  ])('%s → «%s»', (code, phrase) => {
    const cause = Object.assign(new Error(`${code}: raw`), { code, path: '/x/y' });
    const message = describeFsError(cause, '/fallback');
    expect(message).toContain(phrase);
    expect(message).toContain('/x/y');
    expect(message).toContain(code);
  });

  it('незнакомая ошибка не теряет исходный текст', () => {
    expect(describeFsError(new Error('что-то странное'), '/x')).toContain('что-то странное');
  });
});

describe.skipIf(!canLockFolders)('create в папке без прав на запись', () => {
  it('initProject возвращает понятный отказ вместо исключения', async () => {
    const parent = await readOnlyFolder();
    const result = await initProject({ target: join(parent, 'проект'), startingPoint: 'idea', git: false, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Нет прав на запись');
  });

  it('пустая папка без прав: совет говорит, что её можно удалить целиком', async () => {
    const target = await readOnlyFolder();
    const result = await initProject({ target, startingPoint: 'idea', git: false, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Нет прав на запись');
    expect(result.error).toContain('можно удалить целиком');
  });

  it('CLI печатает причину без stack trace и возвращает 1', async () => {
    const parent = await readOnlyFolder();
    const cli = collect();
    const code = await runCreateCli(['--yes', '--no-git', '--target', join(parent, 'проект')], cli.io, { isTty: false });
    expect(code).toBe(1);
    expect(cli.stderr()).toContain('Нет прав на запись');
    expect(cli.stderr()).not.toMatch(/\n\s+at /);
  });
});

describe('doctor и preflight называют неверный путь прямо', () => {
  it('doctor CLI на несуществующей папке', async () => {
    const missing = join(await makeTempDir('nowhere-'), 'нет такой');
    const cli = collect();
    expect(await runMaestroCli(['doctor', '--path', missing], cli.io)).toBe(1);
    expect(cli.stderr()).toContain('project-path-missing');
    expect(cli.stderr()).toContain('Папка не найдена');
    expect(cli.stderr()).not.toContain('ENOENT');
  });

  it('preflight на несуществующей папке не отправляет в protocols/plan.md', async () => {
    const missing = join(await makeTempDir('nowhere-'), 'нет такой');
    const decision = await buildPreflight(missing, { scale: 'feature' });
    expect(decision.ok).toBe(false);
    expect(decision.findings.map((item) => item.code)).toEqual(['preflight-path-missing']);

    const cli = collect();
    expect(await runMaestroCli(['preflight', '--path', missing], cli.io)).toBe(1);
    expect(cli.stderr()).toContain('Папка проекта не найдена');
    expect(cli.stderr()).not.toContain('protocols/plan.md');
  });

  it('preflight в папке без Maestro говорит, что это не проект', async () => {
    const dir = await makeTempDir('not-project-');
    await mkdir(join(dir, 'src'));
    const decision = await buildPreflight(dir, { scale: 'feature' });
    expect(decision.findings.map((item) => item.code)).toEqual(['preflight-not-project']);
  });
});

describe('путь, перетащенный в терминал', () => {
  it('на macOS снимает экранирование пробелов и скобок', async () => {
    const result = await resolveProjectInput('/Users/me/Guided\\ Run\\ \\(2\\)', {
      mode: 'check', platform: 'darwin', home: '/Users/me', cwd: '/tmp',
    });
    expect(result.target).toBe('/Users/me/Guided Run (2)');
  });

  it('на Windows обратная косая остаётся разделителем', async () => {
    const result = await resolveProjectInput('C:\\Users\\me\\App', {
      mode: 'check', platform: 'win32', home: 'C:\\Users\\me', cwd: 'C:\\',
    });
    expect(result.target).toBe('C:\\Users\\me\\App');
  });
});
