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
