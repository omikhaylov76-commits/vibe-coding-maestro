import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { scanSkills } from '../src/core/skills.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

afterEach(cleanupTempDirs);

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

async function skill(root: string, relative: string, text: string): Promise<void> {
  const path = join(root, relative, 'SKILL.md');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
}

describe('safe Skill Inventory', () => {
  it('сканирует только два локальных каталога и детерминированно парсит разрешённые поля', async () => {
    const root = await makeTempDir();
    await skill(root, '.agents/skills/zeta', '---\nname: Zeta\ndescription: "Safe skill"\nversion: 1.2.3\nlicense: MIT\nplatforms: [linux, darwin]\nmetadata:\n  tags: [review, safe]\ncommand: rm -rf /\n---\nbody');
    await skill(root, '.claude/skills/alpha', '---\nname: Alpha\nplatforms:\n  - win32\n---\n');
    await skill(root, 'vendor/skills/ignored', '---\nname: Ignore\n---\n');
    const report = await scanSkills(root);
    expect(report.skills.map((s) => s.path)).toEqual(['.agents/skills/zeta/SKILL.md', '.claude/skills/alpha/SKILL.md']);
    expect(report.skills[0]?.frontmatter).toEqual({ name: 'Zeta', description: 'Safe skill', version: '1.2.3', license: 'MIT', platforms: ['linux', 'darwin'], metadata: { tags: ['review', 'safe'] } });
    expect(JSON.stringify(report)).not.toContain('rm -rf');
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it('не следует symlink и не читает linked SKILL.md', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    await skill(outside, 'secret', '---\nname: Secret\n---\nTOP_SECRET');
    await mkdir(join(root, '.claude/skills'), { recursive: true });
    await symlink(join(outside, 'secret'), join(root, '.claude/skills/link'));
    const report = await scanSkills(root);
    expect(report.skills).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('TOP_SECRET');
    expect(JSON.stringify(report)).not.toContain(outside);
  });

  it('ограничивает глубину, размер и число файлов, malformed превращает в warning', async () => {
    const root = await makeTempDir();
    await skill(root, '.agents/skills/000-bad', '---\nname: [broken\n---\n');
    await skill(root, '.claude/skills/a/b/c/d/e', '---\nname: Too deep\n---\n');
    await skill(root, '.agents/skills/001-huge', `---\nname: Huge\n---\n${'x'.repeat(256 * 1024)}`);
    for (let i = 0; i < 205; i += 1) await skill(root, `.agents/skills/zzz-many/${String(i).padStart(3, '0')}`, '---\nname: Many\n---\n');
    const report = await scanSkills(root);
    expect(report.skills.length).toBeLessThanOrEqual(200);
    expect(report.skills.some((s) => s.path.includes('/e/'))).toBe(false);
    expect(report.results.some((r) => r.code === 'frontmatter-malformed')).toBe(true);
    expect(report.results.some((r) => r.code === 'file-too-large')).toBe(true);
    expect(report.results.some((r) => r.code === 'file-limit-reached')).toBe(true);
  });

  it('CLI JSON стабилен, даёт 0-5 рекомендаций из metadata и явно ничего не устанавливает', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.maestro'), { recursive: true });
    await writeFile(join(root, '.maestro/manifest.json'), JSON.stringify({ schemaVersion: 1, product: { name: 'x', version: '1', createdBy: 'x' }, project: { name: 'Demo', startingPoint: 'code', createdAt: '2026-01-01T00:00:00.000Z' }, managed: [{ path: 'x', kind: 'managed' }] }));
    const a = collect();
    const b = collect();
    expect(await runMaestroCli(['skills', '--path', root, '--json'], a.io)).toBe(0);
    expect(await runMaestroCli(['skills', '--path', root, '--json'], b.io)).toBe(0);
    expect(a.out.join('\n')).toBe(b.out.join('\n'));
    const parsed = JSON.parse(a.out.join('\n')) as { installed: boolean; notice: string; recommendations: unknown[]; registryVersion: number };
    expect(parsed.installed).toBe(false);
    expect(parsed.notice).toContain('ничего не установлено');
    expect(parsed.recommendations.length).toBeGreaterThanOrEqual(0);
    expect(parsed.recommendations.length).toBeLessThanOrEqual(5);
    expect(parsed.registryVersion).toBe(1);
  });

  it('trusted registry по умолчанию пуст и не содержит placeholder-источников', async () => {
    const root = await makeTempDir();
    await mkdir(join(root, '.maestro'), { recursive: true });
    await writeFile(join(root, '.maestro/manifest.json'), JSON.stringify({ schemaVersion: 1, product: { name: 'x', version: '1', createdBy: 'x' }, project: { name: 'Demo', startingPoint: 'code', createdAt: '2026-01-01T00:00:00.000Z' }, managed: [{ path: 'x', kind: 'managed' }] }));
    const report = await scanSkills(root);
    expect(report.recommendations).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/example(?:\.com|\/)|placeholder/i);
  });

  it('текстовый CLI явно сообщает, что ничего не установлено', async () => {
    const root = await makeTempDir();
    const c = collect();
    expect(await runMaestroCli(['skills', '--path', root], c.io)).toBe(0);
    expect(c.out.join('\n')).toContain('ничего не установлено');
  });
});
