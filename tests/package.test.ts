import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('npm package entrypoints', () => {
  it('package.json указывает на существующие исходные bin-entrypoints', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { bin: Record<string, string> };
    expect(pkg.bin['create-vibe-maestro']).toBe('dist/bin/create-vibe-maestro.js');
    expect(pkg.bin['vibe-maestro']).toBe('dist/bin/vibe-maestro.js');
    expect(existsSync(join(process.cwd(), 'src/bin/create-vibe-maestro.ts'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'src/bin/vibe-maestro.ts'))).toBe(true);
  });
});
