import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const exec = promisify(execFile);
afterEach(cleanupTempDirs);

async function git(target: string, args: string[]) {
  return (await exec('git', args, { cwd: target })).stdout.trim();
}

describe('Git bootstrap', () => {
  it('создаёт main, один стартовый commit и чистое дерево', async () => {
    const target = await makeTempDir('vcm git ');
    const result = await initProject({ target, name: 'Git Project', startingPoint: 'idea', git: true, now: FIXED_NOW });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(await git(target, ['branch', '--show-current'])).toBe('main');
    expect(await git(target, ['rev-list', '--count', 'HEAD'])).toBe('1');
    expect(await git(target, ['status', '--porcelain'])).toBe('');
  });
});

describe('Git bootstrap в существующем репозитории', () => {
  /**
   * Регрессия: в чужом репозитории нельзя делать git add -A и commit.
   * Незакоммиченная работа пользователя — не наша, её нельзя ни индексировать, ни фиксировать.
   */
  async function existingRepo(): Promise<string> {
    const target = await makeTempDir('vcm existing ');
    await exec('git', ['init', '-b', 'main'], { cwd: target });
    await exec('git', ['config', 'user.name', 'Пользователь'], { cwd: target });
    await exec('git', ['config', 'user.email', 'user@example.com'], { cwd: target });
    await writeFile(join(target, 'README.md'), '# чужой проект\n', 'utf8');
    await exec('git', ['add', 'README.md'], { cwd: target });
    await exec('git', ['commit', '-m', 'чужой первый commit'], { cwd: target });
    return target;
  }

  it('не создаёт commit, если репозиторий уже существовал', async () => {
    const target = await existingRepo();
    const before = await git(target, ['rev-list', '--count', 'HEAD']);

    const result = await initProject({
      target,
      name: 'Existing',
      startingPoint: 'idea',
      force: true,
      git: true,
      now: FIXED_NOW,
    });

    expect(result.ok).toBe(true);
    expect(await git(target, ['rev-list', '--count', 'HEAD'])).toBe(before);
  });

  it('не индексирует чужой незакоммиченный WIP', async () => {
    const target = await existingRepo();
    await writeFile(join(target, 'wip.txt'), 'моя незаконченная работа\n', 'utf8');
    await writeFile(join(target, 'README.md'), '# чужой проект, правки в работе\n', 'utf8');

    const result = await initProject({
      target,
      name: 'Existing',
      startingPoint: 'idea',
      force: true,
      git: true,
      now: FIXED_NOW,
    });

    expect(result.ok).toBe(true);

    // wip.txt обязан остаться неотслеживаемым, README.md — изменённым, но не в индексе.
    const status = await git(target, ['status', '--porcelain']);
    expect(status).toContain('?? wip.txt');
    expect(status).toMatch(/^ M README\.md$/m);

    const staged = await git(target, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean)).not.toContain('wip.txt');
    expect(staged.split('\n').filter(Boolean)).not.toContain('README.md');
  });

  it('индексирует созданные Maestro пути и предупреждает, что commit не сделан', async () => {
    const target = await existingRepo();

    const result = await initProject({
      target,
      name: 'Existing',
      startingPoint: 'idea',
      force: true,
      git: true,
      now: FIXED_NOW,
    });

    const staged = (await git(target, ['diff', '--cached', '--name-only'])).split('\n').filter(Boolean);
    expect(staged).toContain('CLAUDE.md');
    expect(staged).toContain('.maestro/manifest.json');

    expect(result.warnings.join('\n')).toMatch(/commit/i);
  });
});
