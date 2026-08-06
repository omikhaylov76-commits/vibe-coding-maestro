/**
 * Опознание экосистем, конфигураций и способностей источника (Planning Gate, Phase 4).
 *
 * Правило одно: вывод либо подтверждён путём в дереве или полем разрешённого
 * манифеста, либо не делается вовсе. Способность без доказательства объявляется
 * `UNKNOWN`, а не «вероятно есть». Содержимое читается только у `package.json` и
 * только по именам полей: значения скриптов и переменных в отчёт не переносятся.
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { compareText } from './model.js';
import type { AnalyzeLimits, SourceCapability, SourceEcosystem } from './model.js';
import type { ScanResult } from './scan.js';

/** Больше десяти путей не доказывают ничего нового и раздувают артефакт. */
export const EVIDENCE_LIMIT = 10;

export interface PackageManifest {
  name: string | null;
  dependencies: string[];
  scripts: string[];
}

const PACKAGE_JSON = 'package.json';
const SAFE_TOKEN = /^[@A-Za-z0-9][\w@./-]{0,80}$/;

function safeTokens(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).filter((key) => SAFE_TOKEN.test(key)).sort(compareText);
}

/** Читает единственный разрешённый манифест с жёстким ограничением размера. */
export async function readPackageManifest(root: string, scan: ScanResult, limits: AnalyzeLimits): Promise<PackageManifest | null> {
  const entry = scan.files.find((file) => file.path === PACKAGE_JSON);
  if (entry === undefined || entry.size > limits.maxFileBytes) return null;
  let text: string;
  try {
    const handle = await open(join(root, PACKAGE_JSON), 'r');
    try {
      const buffer = Buffer.alloc(entry.size);
      await handle.read(buffer, 0, entry.size, 0);
      text = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const name = typeof record.name === 'string' && SAFE_TOKEN.test(record.name) ? record.name : null;
    return {
      name,
      dependencies: [...new Set([...safeTokens(record.dependencies), ...safeTokens(record.devDependencies)])].sort(compareText),
      scripts: safeTokens(record.scripts),
    };
  } catch {
    return null;
  }
}

/** Сортирует и ограничивает evidence, честно помечая усечение. */
export function capEvidence(evidence: readonly string[]): string[] {
  const unique = [...new Set(evidence)].sort(compareText);
  if (unique.length <= EVIDENCE_LIMIT) return unique;
  return [...unique.slice(0, EVIDENCE_LIMIT), `TRUNCATED:+${unique.length - EVIDENCE_LIMIT}`];
}

interface Rule {
  id: string;
  /** Совпадение по имени файла на любой глубине обхода. */
  basenames?: readonly string[];
  /** Совпадение по точному относительному пути. */
  paths?: readonly string[];
  /** Совпадение по расширению имени файла. */
  extensions?: readonly string[];
  dirs?: readonly string[];
  dependencies?: readonly string[];
  scripts?: readonly string[];
}

const ECOSYSTEMS: readonly Rule[] = [
  { id: 'node', basenames: [PACKAGE_JSON] },
  { id: 'python', basenames: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] },
  { id: 'go', basenames: ['go.mod'] },
  { id: 'rust', basenames: ['Cargo.toml'] },
  { id: 'java-maven', basenames: ['pom.xml'] },
  { id: 'java-gradle', basenames: ['build.gradle', 'build.gradle.kts'] },
  { id: 'ruby', basenames: ['Gemfile'] },
  { id: 'php', basenames: ['composer.json'] },
  { id: 'dotnet', extensions: ['.csproj', '.sln'] },
  { id: 'docker', basenames: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml'] },
  { id: 'static-web', basenames: ['index.html'] },
];

const ENTRYPOINTS: readonly string[] = [
  'index.html', 'index.js', 'index.ts', 'server.js', 'server.ts', 'main.py', 'app.py', 'main.go',
  'src/main.ts', 'src/main.tsx', 'src/main.js', 'src/main.jsx', 'src/main.rs',
  'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/App.tsx', 'src/app.ts',
  'app/page.tsx', 'pages/index.tsx', 'cmd/main.go',
];

const BUILD_FILES: readonly string[] = [
  'Makefile', 'Dockerfile', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'webpack.config.js',
  'rollup.config.js', 'esbuild.config.js', 'next.config.js', 'next.config.mjs', 'Cargo.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'pyproject.toml', 'setup.py', 'CMakeLists.txt',
];

const TEST_FILES: readonly string[] = [
  'vitest.config.ts', 'vitest.config.js', 'jest.config.js', 'jest.config.ts', 'playwright.config.ts',
  'cypress.config.ts', 'pytest.ini', 'tox.ini', 'karma.conf.js', 'phpunit.xml',
];

const TEST_DIRS: readonly string[] = ['tests', 'test', '__tests__', 'spec'];

/**
 * Deployment опознаётся только по специализированным файлам.
 *
 * Каталог с именем `deploy` доказательством не считается: он встречается и там,
 * где никакого независимого deployment нет, а ложный «YES» в матрице границ
 * дороже честного «UNKNOWN».
 */
const DEPLOY_FILES: readonly string[] = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'Procfile',
  'vercel.json', 'netlify.toml', 'fly.toml', 'render.yaml', 'app.yaml', 'railway.json', 'Chart.yaml',
];

const DEPLOY_DIRS: readonly string[] = ['.github/workflows', '.gitlab-ci', 'k8s/base'];

const CAPABILITIES: readonly Rule[] = [
  {
    id: 'ui',
    dependencies: ['react', 'react-dom', 'vue', 'svelte', 'next', '@angular/core', 'solid-js', 'preact', 'phaser', 'pixi.js', 'three'],
    paths: ['index.html'],
    dirs: ['src/components', 'public'],
  },
  {
    id: 'realtime',
    dependencies: ['socket.io', 'socket.io-client', 'ws', 'uWebSockets.js', 'colyseus', '@colyseus/core', '@microsoft/signalr', 'pusher-js', 'ably', 'centrifuge', 'phoenix'],
  },
  {
    id: 'auth',
    dependencies: ['passport', 'jsonwebtoken', 'next-auth', '@auth/core', 'bcrypt', 'bcryptjs', 'argon2', 'oidc-client-ts', '@clerk/nextjs', 'lucia', 'firebase-admin'],
  },
  {
    id: 'persistence',
    dependencies: ['pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3', 'mongoose', 'mongodb', 'prisma', '@prisma/client', 'redis', 'ioredis', 'typeorm', 'sequelize', 'knex', 'drizzle-orm', 'lowdb'],
    paths: ['prisma/schema.prisma'],
    dirs: ['migrations'],
  },
  {
    id: 'assets',
    dirs: ['assets', 'public', 'static', 'images', 'img', 'sounds', 'audio', 'sprites', 'fonts'],
    extensions: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp3', '.ogg', '.wav'],
  },
];

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function matchRule(rule: Rule, scan: ScanResult, manifest: PackageManifest | null): string[] {
  const evidence: string[] = [];
  const paths = scan.files.map((file) => file.path);
  if (rule.paths !== undefined) evidence.push(...paths.filter((path) => rule.paths!.includes(path)));
  if (rule.basenames !== undefined) evidence.push(...paths.filter((path) => rule.basenames!.includes(basename(path))));
  if (rule.extensions !== undefined) {
    evidence.push(...paths.filter((path) => rule.extensions!.some((extension) => path.toLowerCase().endsWith(extension))));
  }
  if (rule.dirs !== undefined) evidence.push(...scan.dirs.filter((dir) => rule.dirs!.includes(dir)));
  if (rule.dependencies !== undefined && manifest !== null) {
    for (const dependency of manifest.dependencies) {
      if (rule.dependencies.includes(dependency)) evidence.push(`${PACKAGE_JSON}#dependencies.${dependency}`);
    }
  }
  if (rule.scripts !== undefined && manifest !== null) {
    for (const script of manifest.scripts) {
      if (rule.scripts.includes(script)) evidence.push(`${PACKAGE_JSON}#scripts.${script}`);
    }
  }
  return evidence;
}

export function detectEcosystems(scan: ScanResult, manifest: PackageManifest | null): SourceEcosystem[] {
  return ECOSYSTEMS
    .map((rule) => ({ id: rule.id, evidence: capEvidence(matchRule(rule, scan, manifest)) }))
    .filter((item) => item.evidence.length > 0)
    .sort((left, right) => compareText(left.id, right.id));
}

export function detectCapabilities(scan: ScanResult, manifest: PackageManifest | null): SourceCapability[] {
  return CAPABILITIES
    .map((rule) => {
      const evidence = capEvidence(matchRule(rule, scan, manifest));
      return { id: rule.id, state: evidence.length > 0 ? 'DETECTED' as const : 'UNKNOWN' as const, evidence };
    })
    .sort((left, right) => compareText(left.id, right.id));
}

const pathsOf = (scan: ScanResult, wanted: readonly string[]): string[] =>
  scan.files.map((file) => file.path).filter((path) => wanted.includes(path));

const script = (manifest: PackageManifest | null, name: string): string[] =>
  manifest !== null && manifest.scripts.includes(name) ? [`${PACKAGE_JSON}#scripts.${name}`] : [];

export function detectEntrypoints(scan: ScanResult): string[] {
  return capEvidence(pathsOf(scan, ENTRYPOINTS));
}

export function detectBuildConfig(scan: ScanResult, manifest: PackageManifest | null): string[] {
  return capEvidence([...pathsOf(scan, BUILD_FILES), ...script(manifest, 'build')]);
}

export function detectTestConfig(scan: ScanResult, manifest: PackageManifest | null): string[] {
  return capEvidence([
    ...pathsOf(scan, TEST_FILES),
    ...scan.dirs.filter((dir) => TEST_DIRS.includes(dir)),
    ...script(manifest, 'test'),
  ]);
}

export function detectDeployConfig(scan: ScanResult, manifest: PackageManifest | null): string[] {
  return capEvidence([
    ...pathsOf(scan, DEPLOY_FILES),
    ...scan.files.map((file) => file.path).filter((path) => DEPLOY_DIRS.some((dir) => path.startsWith(`${dir}/`))),
    ...scan.dirs.filter((dir) => DEPLOY_DIRS.includes(dir)),
  ]);
}
