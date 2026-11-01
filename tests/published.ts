import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProjectDepth } from '../src/core/manifest.js';
import { MANIFEST_PATH } from '../src/core/manifest.js';
import { makeTempDir } from './helpers.js';

/** Проект, записанный НАСТОЯЩИМ опубликованным пакетом (команда — в `generatedBy`). */
export interface PublishedFixture {
  generatedBy: string;
  version: string;
  depth: ProjectDepth;
  folder: string;
  files: Record<string, string>;
}

export async function publishedFixture(id: string): Promise<PublishedFixture> {
  return JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/published', `${id}.json`), 'utf8')) as PublishedFixture;
}

/** Раскладывает фикстуру во временную папку; `version` подменяет версию в manifest. */
export async function materializePublished(id: string, version?: string): Promise<{ root: string; data: PublishedFixture }> {
  const data = await publishedFixture(id);
  const root = join(await makeTempDir('published-'), data.folder);
  for (const [path, content] of Object.entries(data.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  if (version !== undefined) {
    const manifest = JSON.parse(data.files[MANIFEST_PATH] as string) as { product: { version: string } };
    manifest.product.version = version;
    await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return { root, data };
}

/** Вывод CLI в память: stdout и stderr отдельно. */
export function collectIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}
