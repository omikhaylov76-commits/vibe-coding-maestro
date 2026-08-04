import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const BETA_VERSION = '0.2.0-beta.1';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('этапы 12–13: CI и документационные контракты', () => {
  it('package, lock и runtime публикуют одну 0.2 beta версию', async () => {
    const pkg = JSON.parse(await text('package.json'));
    const lock = JSON.parse(await text('package-lock.json'));
    expect(pkg.version).toBe(BETA_VERSION);
    expect(lock.version).toBe(BETA_VERSION);
    expect(lock.packages[''].version).toBe(BETA_VERSION);
  });

  it('CI покрывает три ОС, Node 20/22 и все обязательные gates', async () => {
    const ci = await text('.github/workflows/ci.yml');
    for (const value of ['ubuntu-latest', 'macos-latest', 'windows-latest', '20', '22']) expect(ci).toContain(value);
    for (const command of ['npm ci', 'npm audit --audit-level=low', 'npm test', 'npm run typecheck', 'npm run build', 'npm pack --dry-run --json', 'npm run acceptance']) expect(ci).toContain(command);
  });

  it('acceptance использует Node API и проверяет путь с пробелом, doctor, main, clean и sentinel', async () => {
    const script = await text('scripts/ci-acceptance.mjs');
    expect(script).toMatch(/mkdtemp/);
    expect(script).toMatch(/project with spaces/i);
    for (const value of ['doctor', 'main', 'status', 'sentinel']) expect(script.toLowerCase()).toContain(value);
    expect(script).not.toMatch(/powershell|cmd\.exe|comspec|\/bin\/sh|shell:\s*true/i);
    expect(script).toContain('process.env.npm_execpath');
    expect(script).toMatch(/process\.execPath, \[npmCli, \.\.\.args\]/);
    for (const value of ['light', 'standard', 'advanced', 'reportVersion', '--strict', 'capabilities.v1.json', 'protocols/build.md', 'protocol-contract-missing']) expect(script).toContain(value);
  });

  it('README является публичной входной страницей: проблема → demo → quick start → результат → safety → docs', async () => {
    const readme = (await text('README.md')).toLowerCase();
    for (const value of [
      'keep ai coding context in the repo',
      'docs/assets/quick-demo.gif',
      'quick start from source',
      'git clone',
      'npm ci && npm run build',
      'node dist/bin/create-vibe-maestro.js',
      'what you get',
      'before and after',
      'safety by default',
      'when maestro helps—and when it does not',
      'integration status',
      'docs/user_guide.md',
    ]) expect(readme).toContain(value);
    expect(readme.split('\n').length).toBeLessThan(350);
  });

  it('README честно документирует prerelease, beginner flow и canonical-only beta', async () => {
    const readme = (await text('README.md')).toLowerCase();
    for (const value of [
      'unreleased beta',
      'npm package is not published yet',
      'no more than three decisions',
      'desktop',
      'explicit path',
      'no_color',
      '--yes',
      'idea',
      'materials',
      '/build',
      '/status',
      '/wiki',
      '/handoff',
      'skills',
      '0.2 beta',
      'canonical',
      '--depth',
      'light',
      'standard',
      'advanced',
      'versioned json output',
      '--strict',
      'converter',
    ]) expect(readme).toContain(value);
    expect(readme).toContain('refuses to modify a non-empty, non-canonical directory');
    expect(readme).not.toContain('подключить существующий проект');
    expect(readme).not.toContain('maestro добавляет собственную структуру');
  });

  it('security, migration и contributing docs фиксируют требуемые границы', async () => {
    const threat = (await text('docs/THREAT_MODEL.md')).toLowerCase();
    for (const value of ['не sandbox', 'произвольных shell-команд', 'toctou', 'враждебного локального пользователя', 'не устанавливает skills автоматически', 'не обращается к сети']) expect(threat).toContain(value);
    const migration = (await text('docs/MIGRATION_V1.md')).toLowerCase();
    for (const value of ['read-only', 'converter', 'отложен', 'core', '--force', 'не преобразует', 'не перезаписывает']) expect(migration).toContain(value);
    expect(migration).not.toContain('вручную перенесите');
    const auditRunbook = (await text('templates/project/maestro/runbooks/cowork-audit.md')).toLowerCase();
    for (const value of ['evidence', 'ровно по одному непустому полю', 'status', 'resolution', 'waivers не входят']) expect(auditRunbook).toContain(value);
    const userGuide = (await text('docs/USER_GUIDE.md')).toLowerCase();
    for (const value of ['evidence', 'resolution', 'waived', 'не ремонтирует неполное дерево']) expect(userGuide).toContain(value);
    const contributing = (await text('CONTRIBUTING.md')).toLowerCase();
    for (const value of ['npm ci', 'npm audit --audit-level=low', 'npm test', 'npm run typecheck', 'npm run build', 'npm pack --dry-run --json', 'ci-acceptance']) expect(contributing).toContain(value);
  });
});
