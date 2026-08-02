import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const createCli = join(root, 'dist/bin/create-vibe-maestro.js');
const maestroCli = join(root, 'dist/bin/vibe-maestro.js');
const tempRoot = await mkdtemp(join(tmpdir(), 'maestro acceptance '));
const target = join(tempRoot, 'project with spaces');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

try {
  run(process.execPath, [createCli, '--yes', '--target', target, '--name', 'CI Acceptance', '--start', 'idea']);
  run(process.execPath, [maestroCli, 'doctor', '--path', target]);
  assert.equal(run('git', ['branch', '--show-current'], target), 'main', 'branch must be main');
  assert.equal(run('git', ['status', '--porcelain'], target), '', 'initial status must be clean');

  const sentinel = join(target, 'sentinel user file.txt');
  await writeFile(sentinel, 'preserve me\n', 'utf8');
  run('git', ['add', 'sentinel user file.txt'], target);
  run('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'Add sentinel'], target);

  run(process.execPath, [createCli, '--yes', '--force', '--target', target, '--name', 'CI Acceptance', '--start', 'idea']);
  await access(sentinel);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve me\n', 'second init must preserve sentinel');
  run(process.execPath, [maestroCli, 'doctor', '--path', target]);
  assert.equal(run('git', ['branch', '--show-current'], target), 'main');
  assert.equal(run('git', ['status', '--porcelain'], target), '', 'status after second init must be clean');
  console.log('CI acceptance passed');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
