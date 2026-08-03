import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('этапы 12–13: CI и документационные контракты', () => {
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
  });

  it('README документирует beginner flow и честный prerelease caveat', async () => {
    const readme = (await text('README.md')).toLowerCase();
    for (const value of ['npx create-vibe-maestro', 'три шага', '--yes', 'idea', 'materials', 'spec', 'code', 'cowork', '/build', '/status', '/wiki', '/handoff', 'skills', 'не опубликован']) expect(readme).toContain(value);
  });

  it('security, migration и contributing docs фиксируют требуемые границы', async () => {
    const threat = (await text('docs/THREAT_MODEL.md')).toLowerCase();
    for (const value of ['не sandbox', 'произвольных shell-команд', 'toctou', 'враждебного локального пользователя', 'не устанавливает skills автоматически', 'не обращается к сети']) expect(threat).toContain(value);
    const migration = (await text('docs/MIGRATION_V1.md')).toLowerCase();
    for (const value of ['read-only', 'вручную', 'не перезаписывает']) expect(migration).toContain(value);
    const contributing = (await text('CONTRIBUTING.md')).toLowerCase();
    for (const value of ['npm ci', 'npm audit --audit-level=low', 'npm test', 'npm run typecheck', 'npm run build', 'npm pack --dry-run --json', 'ci-acceptance']) expect(contributing).toContain(value);
  });
});
