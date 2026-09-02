import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { listFiles, sha256 } from './helpers.js';

const execFileAsync = promisify(execFile);

/** Значение, которого не должно быть ни в одном артефакте инвентаризации. */
export const SECRET_VALUE = 'super-secret-token-value-42';

export async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = join(root, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}

/** Секреты кладутся после коммита и всегда игнорируются Git: источник остаётся чистым. */
async function addSecrets(root: string): Promise<void> {
  await writeFixtureFile(root, '.env', `API_TOKEN=${SECRET_VALUE}\n`);
  await writeFixtureFile(root, '.env.local', `DB_PASSWORD=${SECRET_VALUE}\n`);
  await writeFixtureFile(root, 'deploy/id_rsa', `-----BEGIN PRIVATE KEY-----\n${SECRET_VALUE}\n`);
  await writeFixtureFile(root, 'deploy/service-account.json', `{"private_key":"${SECRET_VALUE}"}\n`);
}

export interface GitFixtureOptions {
  remote?: string;
  dirty?: boolean;
  branch?: string;
}

export async function initFixtureGit(root: string, options: GitFixtureOptions = {}): Promise<void> {
  const git = (args: string[]): Promise<{ stdout: string }> => execFileAsync('git', args, { cwd: root, encoding: 'utf8' });
  await git(['-c', `init.defaultBranch=${options.branch ?? 'main'}`, 'init', '--quiet']);
  await git(['add', '-A']);
  await git([
    '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'fixture',
  ]);
  if (options.remote !== undefined) await git(['remote', 'add', 'origin', options.remote]);
  if (options.dirty === true) await writeFixtureFile(root, 'README.md', 'изменено после коммита\n');
}

export interface FixtureOptions {
  git?: GitFixtureOptions | false;
  secrets?: boolean;
}

/** Игра «Дурак»: Node + UI + realtime + сборка + deployment, Git с credential-remote. */
export async function makeDurakFixture(parent: string, name = 'durak', options: FixtureOptions = {}): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, '.gitignore', '.env\n.env.*\ndeploy/id_rsa\ndeploy/service-account.json\n');
  await writeFixtureFile(root, 'README.md', '# Дурак\n');
  await writeFixtureFile(root, 'package.json', `${JSON.stringify({
    name: 'durak',
    version: '1.0.0',
    scripts: { build: 'vite build', test: 'vitest run', deploy: 'echo нет' },
    dependencies: { react: '^18.3.1', 'socket.io': '^4.7.5', 'jsonwebtoken': '^9.0.2' },
    devDependencies: { vite: '^6.0.0' },
  }, null, 2)}\n`);
  await writeFixtureFile(root, 'index.html', '<!doctype html><html lang="ru"></html>\n');
  await writeFixtureFile(root, 'vite.config.ts', 'export default {};\n');
  await writeFixtureFile(root, 'Dockerfile', 'FROM node:20\n');
  await writeFixtureFile(root, 'src/main.tsx', 'export const main = () => null;\n');
  await writeFixtureFile(root, 'assets/card.png', 'PNG\n');
  await writeFixtureFile(root, 'node_modules/left-pad/index.js', 'module.exports = 1;\n');
  if (options.secrets !== false) await addSecrets(root);
  if (options.git !== false) {
    await initFixtureGit(root, options.git ?? { remote: 'https://oleg:ghp_secrettoken@github.com/example/durak.git?token=zzz' });
  }
  return root;
}

/** «Кубики-покер»: Node без realtime, с персистентностью, без Git. */
export async function makeDicePokerFixture(parent: string, name = 'dice poker', options: FixtureOptions = {}): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, 'package.json', `${JSON.stringify({
    name: 'dice-poker',
    version: '0.4.0',
    scripts: { build: 'tsc -p .', test: 'node --test' },
    dependencies: { 'better-sqlite3': '^11.0.0' },
  }, null, 2)}\n`);
  await writeFixtureFile(root, 'index.html', '<!doctype html><html lang="ru"></html>\n');
  await writeFixtureFile(root, 'src/index.ts', 'export const roll = (): number => 6;\n');
  await writeFixtureFile(root, 'tsconfig.json', '{"compilerOptions":{}}\n');
  if (options.secrets !== false) await addSecrets(root);
  if (options.git !== undefined && options.git !== false) await initFixtureGit(root, options.git);
  return root;
}

/** Источник без Node и без Git: только Python-манифест. */
export async function makePythonFixture(parent: string, name = 'сервис-статистики'): Promise<string> {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFixtureFile(root, 'pyproject.toml', '[project]\nname = "stats"\n');
  await writeFixtureFile(root, 'main.py', 'print("ок")\n');
  return root;
}

/** Снимок дерева с содержимым и временем изменения: доказывает отсутствие записи. */
export async function treeState(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const relative of await listFiles(root, { includeGit: true })) {
    const absolute = join(root, relative);
    const info = await lstat(absolute);
    const content = info.isSymbolicLink() ? 'symlink' : sha256(await readFile(absolute));
    state[relative] = `${content}:${info.size}:${info.mtimeMs}`;
  }
  return state;
}

export async function gitStatus(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' });
  return stdout;
}

/** Symlink может быть недоступен без прав (Windows): тест тогда честно пропускается. */
export async function trySymlink(target: string, path: string, type: 'file' | 'dir'): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}
