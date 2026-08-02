import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const createCli = join(root, 'dist/bin/create-vibe-maestro.js');
const maestroCli = join(root, 'dist/bin/vibe-maestro.js');
const tempRoot = await mkdtemp(join(tmpdir(), 'maestro acceptance '));
const target = join(tempRoot, 'project with spaces');

function run(command, args, cwd = root, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: options.shell === true });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function npm(args, cwd = root) {
  if (process.platform !== 'win32') return run('npm', args, cwd);
  // npm is a .cmd wrapper on Windows. Quote internally generated arguments only
  // when required, so paths with spaces stay intact but npm sees plain `pack`.
  const quote = (value) => /^[A-Za-z0-9_./:=\\-]+$/.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;
  const command = `npm ${args.map(quote).join(' ')}`;
  return run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command], cwd);
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

  const packDir = join(tempRoot, 'pack');
  const installDir = join(tempRoot, 'installed');
  await import('node:fs/promises').then(({ mkdir }) => Promise.all([mkdir(packDir), mkdir(installDir)]));
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]));
  const filename = packed[0]?.filename;
  assert.ok(filename, 'npm pack --json must return filename');
  const tarball = join(packDir, filename);
  await writeFile(join(installDir, 'package.json'), '{"private":true}\n', 'utf8');
  npm(['install', '--ignore-scripts', tarball], installDir);

  const installedRoot = join(installDir, 'node_modules/create-vibe-maestro');
  const installedCreate = join(installedRoot, 'dist/bin/create-vibe-maestro.js');
  const installedMaestro = join(installedRoot, 'dist/bin/vibe-maestro.js');
  await access(join(installedRoot, 'templates/project/wiki/hot.md'));
  await access(join(installedRoot, 'schemas/manifest.schema.json'));
  run(process.execPath, [installedCreate, '--help'], installDir);
  run(process.execPath, [installedMaestro, '--version'], installDir);
  run(process.execPath, [installedCreate, '--yes', '--no-git', '--target', './packed project', '--start', 'idea'], installDir);
  run(process.execPath, [installedMaestro, 'doctor', '--path', './packed project'], installDir);

  console.log('CI acceptance passed (source + packed install)');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
