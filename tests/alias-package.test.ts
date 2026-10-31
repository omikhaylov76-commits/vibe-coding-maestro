import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `vibe-maestro` — отдельный npm-пакет с одним bin. Он занимает имя, чтобы
 * `npx vibe-maestro` не скачал чужой код, и запускает bin из create-vibe-maestro.
 */
const ALIAS_DIR = join(process.cwd(), 'packages/vibe-maestro');

interface Manifest {
  name: string;
  version: string;
  license: string;
  type?: string;
  engines?: { node?: string };
  bin: Record<string, string>;
  files?: string[];
  exports?: unknown;
  dependencies?: Record<string, string>;
  repository?: { url?: string; directory?: string };
}

async function manifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Manifest;
}

describe('пакет-обёртка vibe-maestro', () => {
  it('называется vibe-maestro и даёт ровно один bin vibe-maestro', async () => {
    const alias = await manifest(ALIAS_DIR);
    expect(alias.name).toBe('vibe-maestro');
    expect(Object.keys(alias.bin)).toEqual(['vibe-maestro']);
    expect(existsSync(join(ALIAS_DIR, alias.bin['vibe-maestro'] as string))).toBe(true);
  });

  it('зависит только от create-vibe-maestro по тегу latest и совпадает с ним по Node и лицензии', async () => {
    const [alias, product] = await Promise.all([manifest(ALIAS_DIR), manifest(process.cwd())]);
    expect(alias.dependencies).toEqual({ [product.name]: 'latest' });
    expect(alias.engines?.node).toBe(product.engines?.node);
    expect(alias.license).toBe(product.license);
    expect(alias.type).toBe('module');
    expect(alias.repository?.url).toBe(product.repository?.url);
    expect(alias.repository?.directory).toBe('packages/vibe-maestro');
  });

  it('запускает тот bin, который create-vibe-maestro действительно публикует', async () => {
    const [alias, product] = await Promise.all([manifest(ALIAS_DIR), manifest(process.cwd())]);
    const source = await readFile(join(ALIAS_DIR, alias.bin['vibe-maestro'] as string), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const imported = /import '([^']+)';/.exec(source)?.[1];
    expect(imported).toBe(`${product.name}/${product.bin['vibe-maestro']}`);
    // Глубокий импорт работает, пока в create-vibe-maestro нет поля exports
    // и dist входит в опубликованные файлы.
    expect(product.exports).toBeUndefined();
    expect(product.files).toContain('dist');
  });

  it('не попадает в архив create-vibe-maestro', async () => {
    const product = await manifest(process.cwd());
    expect(product.files?.some((path) => path === 'packages' || path.startsWith('packages/'))).toBe(false);
  });
});
