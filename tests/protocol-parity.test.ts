import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from '../src/core/init.js';
import { loadChecksums, loadManifest } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

const adapters = ['AGENTS.md', 'CLAUDE.md', '.claude/commands/build.md', '.claude/commands/status.md', '.claude/commands/wiki.md', '.claude/commands/handoff.md'] as const;

async function fresh(depth: 'light' | 'standard' | 'advanced') {
  const target = await makeTempDir(`protocol-${depth}-`);
  const result = await initProject({ target, name: depth, startingPoint: 'idea', depth, git: false, now: FIXED_NOW });
  expect(result.ok).toBe(true);
  return target;
}

describe('Phase 3: protocol installation and adapter parity', () => {
  afterEach(cleanupTempDirs);

  it('устанавливает полную canonical protocol library во всех depth с managed checksums', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      const target = await fresh(depth);
      const manifest = await loadManifest(target);
      const checksums = await loadChecksums(target);
      expect(manifest.managed).toContainEqual({ path: 'protocols/build.md', kind: 'managed' });
      expect(checksums?.files['protocols/build.md']).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.inventory).toContainEqual({ path: 'protocols/lessons.md', ownership: 'managed' });
    }
  });

  it('depth inventory остаётся строго аддитивным', async () => {
    const inventory = async (depth: 'light' | 'standard' | 'advanced') => {
      const manifest = await loadManifest(await fresh(depth));
      return new Set(manifest.inventory.map((entry) => entry.path));
    };
    const light = await inventory('light');
    const standard = await inventory('standard');
    const advanced = await inventory('advanced');
    for (const path of Array.from(light)) expect(standard).toContain(path);
    for (const path of Array.from(standard)) expect(advanced).toContain(path);
    expect(standard.size).toBeGreaterThan(light.size);
    expect(advanced.size).toBeGreaterThan(standard.size);
  });

  it('adapters являются тонкими ссылками на canonical protocols', async () => {
    const target = await fresh('advanced');
    for (const path of adapters) {
      const text = await readFile(join(target, path), 'utf8');
      expect(text.split('\n').length, path).toBeLessThanOrEqual(18);
      expect(text, path).toMatch(/protocols\/.+\.md/);
      expect(text, path).not.toContain('NEEDS CLARIFICATION');
      expect(text, path).not.toContain('Constitution Check');
    }
  });

  it('Claude reviewer adapter сохраняет discoverable frontmatter', async () => {
    const target = await fresh('standard');
    const text = await readFile(join(target, '.claude/agents/code-reviewer.md'), 'utf8');
    expect(text).toMatch(/^---\nname: code-reviewer\ndescription: .+\n---\n/);
    expect(text).toContain('protocols/audit.md');
  });
});
