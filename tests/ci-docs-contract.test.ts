import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const BETA_VERSION = '0.4.1';

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

/**
 * Имена закрытых проектов и личные имена не должны попадать в публичный репозиторий,
 * поэтому здесь хранятся только их sha256: префиксы слов и слова целиком.
 */
const PRIVATE_PREFIX_SHA256 = new Set([
  '86f519b62f871bd19ae32b24c5c308c9f880fff8225e7b4f6dacf1125b8644ce',
  '63ba01ec9e303fb556f87dba073fe80105e081fedd4a4e9312e8c0314b76e207',
  '359c1e75dc77a82ffb324b6403c5a16fe4ba6618a1ea961b92b4db3ffc07de59',
  '9870ee936121b619ca68d707e5a0da79cbcc347f6797e1758395b18b0a5bc2f6',
]);
const PRIVATE_WORD_SHA256 = new Set([
  '0fdc8b30e6762a81b9fc9fed803e68aeb27229d7543abae33bf8e39adeb74690',
  '4a7d275272282c234120f88b898c5e0aa472083714d711a0cdc4c59056c7022c',
  '4c934d01fead0e4584cb4956879dd1f4ca4c3dee86d935e8039218f28178546e',
  '5ad59338ab416a5d23a87e7d4fb24c7cf52c20eb6f8cb5eacc5cc71aa5c25a95',
  'd6e22b8f6e589e362c99e7cc16c5d7d0ae151c8b2b0e4fa48bc4bf5a60762e4d',
]);
const PREFIX_LENGTHS = [7, 8, 9];

function privateWords(content: string): string[] {
  const found: string[] = [];
  for (const word of content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hit = PRIVATE_WORD_SHA256.has(hash(word)) || PREFIX_LENGTHS.some((length) => word.length >= length && PRIVATE_PREFIX_SHA256.has(hash(word.slice(0, length))));
    if (hit && !found.includes(word)) found.push(word);
  }
  return found;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const TEXT_FILE = /\.(md|ts|mjs|js|json|ya?ml)$/;

/** Все текстовые файлы, которые доходят до пользователя или агента: код, шаблоны, документация. */
async function shippedTextFiles(): Promise<string[]> {
  const files = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md'];
  for (const dir of ['src', 'templates', 'docs', 'registry', 'scripts']) {
    const entries = await readdir(new URL(`../${dir}`, import.meta.url), { recursive: true });
    for (const entry of entries) if (TEXT_FILE.test(entry)) files.push(`${dir}/${entry.split('\\').join('/')}`);
  }
  return files;
}

describe('этапы 12–13: CI и документационные контракты', () => {
  it('package, lock и runtime публикуют одну 0.3 beta версию', async () => {
    const pkg = JSON.parse(await text('package.json'));
    const lock = JSON.parse(await text('package-lock.json'));
    expect(pkg.version).toBe(BETA_VERSION);
    expect(lock.version).toBe(BETA_VERSION);
    expect(lock.packages[''].version).toBe(BETA_VERSION);
  });

  it('каждая команда npx тянет только пакет create-vibe-maestro, а не чужое имя', async () => {
    // `vibe-maestro` — bin внутри create-vibe-maestro, а не пакет. `npx vibe-maestro`
    // скачал бы того, кто первым займёт это имя в npm.
    const invocation = /\bnpx\s+(?:(?:--package|-p)[=\s]+)?([^\s`'"]+)/g;
    const packages = new Set<string>();
    let checked = 0;
    for (const file of await shippedTextFiles()) {
      for (const match of (await text(file)).matchAll(invocation)) {
        const spec = match[1] as string;
        const name = spec.replace(/(?<=.)@[^@/]*$/, '');
        packages.add(`${name} (${file})`);
        expect(['create-vibe-maestro', '${CREATE_COMMAND}'], `${file}: npx ${spec}`).toContain(name);
        checked += 1;
      }
    }
    expect(checked, [...packages].join('\n')).toBeGreaterThan(5);
  });

  it('CI покрывает три ОС, Node 20/22 и все обязательные gates', async () => {
    const ci = await text('.github/workflows/ci.yml');
    for (const value of ['ubuntu-latest', 'macos-latest', 'windows-latest', '20', '22']) expect(ci).toContain(value);
    for (const command of ['npm ci', 'npm audit --audit-level=low', 'npm run check', 'npm pack --dry-run --json', 'npm run acceptance']) expect(ci).toContain(command);
    // npm run check — это и есть test + typecheck + build; его же запускает prepack.
    const pkg = JSON.parse(await text('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.check).toBe('npm test && npm run typecheck && npm run build');
    expect(pkg.scripts.prepack).toBe('npm run check');
  });

  it('CI экономный: отмена устаревших прогонов, одна быстрая проверка на ветке, матрица на PR и main', async () => {
    // На Windows checkout может отдать CRLF: проверяем смысл, а не переводы строк.
    const ci = (await text('.github/workflows/ci.yml')).replace(/\r\n/g, '\n');
    expect(ci).toMatch(/^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}$/m);
    // Ветка: ровно один job без матрицы.
    const quick = ci.slice(ci.indexOf('  quick:'), ci.indexOf('  full:'));
    expect(quick).toContain("if: github.event_name == 'push' && github.ref != 'refs/heads/main'");
    expect(quick).not.toContain('matrix');
    expect(quick).toContain('npm run check');
    // Полная матрица и audit — только pull request и main.
    const full = ci.slice(ci.indexOf('  full:'), ci.indexOf('  audit:'));
    const audit = ci.slice(ci.indexOf('  audit:'));
    for (const job of [full, audit]) expect(job).toContain("if: github.event_name == 'pull_request' || github.ref == 'refs/heads/main'");
    expect(full).toContain('matrix:');
    expect(audit).not.toContain('matrix');
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
      '## quick start',
      'npx create-vibe-maestro@latest',
      'npx --package create-vibe-maestro@latest vibe-maestro doctor --path .',
      'updating a project',
      'vibe-maestro upgrade --path .',
      'what you get',
      'before and after',
      'safety by default',
      'when maestro helps—and when it does not',
      'integration status',
      'docs/user_guide.md',
    ]) expect(readme).toContain(value);
    expect(readme.split('\n').length).toBeLessThan(350);
  });

  it('README и руководство ведут только через npx: без сборки из исходников и скрытых ошибок', async () => {
    for (const path of ['README.md', 'docs/USER_GUIDE.md']) {
      const doc = await text(path);
      expect(doc, path).not.toContain('node dist/');
      expect(doc, path).not.toContain('git clone');
      expect(doc, path).not.toContain('2>/dev/null');
      expect(doc, path).not.toContain('папки исходников');
    }
    // Сборка из исходников живёт там, где её ищут разработчики.
    const contributing = await text('CONTRIBUTING.md');
    for (const value of ['git clone', 'npm ci', 'npm run build']) expect(contributing).toContain(value);
  });

  it('документация не обещает, что агент не может проставить утверждение', async () => {
    for (const path of ['README.md', 'docs/USER_GUIDE.md']) {
      const doc = (await text(path)).toLowerCase();
      expect(doc, path).not.toContain('агент не утверждает план за вас');
      expect(doc, path).not.toContain('агент не имеет права утвердить план за вас');
      expect(doc, path).toContain('не может');
    }
  });

  it('публичный план развития есть и не содержит деталей закрытых проектов', async () => {
    const roadmap = await text('docs/ROADMAP.md');
    for (const value of ['0.3.0-beta.4', '0.3.0', '0.4', 'Не делаем']) expect(roadmap).toContain(value);
    expect(privateWords(roadmap)).toEqual([]);
    expect(roadmap).not.toMatch(/\/users\/|~\/projects/i);
    expect(await text('README.md')).toContain('docs/ROADMAP.md');
  });

  it('ни один публикуемый текст не содержит деталей закрытых проектов и личных путей', async () => {
    const files = [...await shippedTextFiles(), 'packages/vibe-maestro/README.md', 'packages/vibe-maestro/package.json'];
    // Пример `/Users/me/…` в руководстве допустим; личные пути — нет.
    for (const file of files) {
      const content = await text(file);
      expect(privateWords(content), file).toEqual([]);
      expect(content, file).not.toMatch(/~\/projects/i);
    }
  });

  it('README честно документирует prerelease, beginner flow и canonical-only beta', async () => {
    const readme = (await text('README.md')).toLowerCase();
    for (const value of [
      'published on npm',
      'npx create-vibe-maestro@latest',
      'no more than three decisions',
      'desktop',
      'explicit path',
      'no_color',
      '--yes',
      'idea',
      'materials',
      '/build',
      '/status',
      '/plan',
      '/wiki',
      '/handoff',
      'skills',
      'level in 0.3',
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
    for (const stale of ['unreleased', 'not published yet', 'still unpublished']) expect(readme).not.toContain(stale);
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
    for (const value of ['npm ci', 'npm audit --audit-level=low', 'npm run check', 'npm pack --dry-run --json', 'npm run acceptance']) expect(contributing).toContain(value);
  });
});
