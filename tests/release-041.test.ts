import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { formatTokens, tokensWord } from '../src/cli/context-run.js';
import { measureContext, projectLogDirName } from '../src/core/context.js';
import { initProject } from '../src/core/init.js';
import { findSecrets, HANDOVER_PATH, INTERNAL_PATHS, packProject, passportGaps } from '../src/core/pack.js';
import { crc32, readZip } from '../src/core/zip.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, sha256 } from './helpers.js';

const execFileAsync = promisify(execFile);
afterEach(cleanupTempDirs);
// Тесты не зависят от сессии Claude Code, в которой их запустили.
delete process.env.CLAUDE_CODE_SESSION_ID;

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd })).stdout.trim();

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, stdout: () => out.join('\n'), stderr: () => err.join('\n') };
}

const FILLED_PASSPORT = `# Паспорт проекта

## Репозиторий

- Адрес: github.com/example/shop (закрытый)
- Основная ветка: main
- Тег сдачи: v1.0.0

## Где работает

- Хостинг: Vercel, проект shop, регион fra1
- Адрес в интернете: https://shop.example.com

## Домен и DNS

- shop.example.com, DNS у регистратора, запись CNAME на Vercel

## Данные, базы, резервные копии

- не применимо

## Внешние сервисы и чей аккаунт

- Stripe — аккаунт заказчика

## Переменные окружения

- STRIPE_SECRET_KEY — панель Vercel

## Расписания и фоновые задачи

- не применимо

## Как запустить, обновить, откатить

- Запустить: npm ci && npm run build
- Обновить: push в main
- Откатить: Redeploy предыдущей сборки в Vercel
`;

async function write(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** Проект с кодом, заполненным паспортом и тегом сдачи v1.0.0. */
async function deliveredProject(extra: Record<string, string> = {}): Promise<string> {
  const root = join(await makeTempDir('pack-'), 'Магазин');
  expect((await initProject({ target: root, name: 'Магазин', startingPoint: 'idea', git: true, now: FIXED_NOW })).ok).toBe(true);
  await write(root, 'wiki/passport.md', FILLED_PASSPORT);
  await write(root, 'src/index.js', 'console.log("магазин");\n');
  await write(root, 'docs/для-заказчика.md', '# Как пользоваться\n');
  await write(root, 'scripts/run.sh', '#!/bin/sh\necho run\n');
  await execFileAsync('chmod', ['+x', join(root, 'scripts/run.sh')]).catch(() => undefined);
  for (const [path, content] of Object.entries(extra)) await write(root, path, content);
  await git(root, 'add', '-A');
  // Секрет, который всё-таки попал в Git: .gitignore его бы не пустил.
  for (const path of Object.keys(extra)) await git(root, 'add', '-f', path);
  await git(root, 'commit', '-qm', 'сдача');
  await git(root, 'tag', '-a', 'v1.0.0', '-m', 'Сдача');
  return root;
}

describe('0.4.1: zip без зависимостей', () => {
  it('crc32 совпадает с эталоном', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });
});

describe('0.4.1: паспорт перед упаковкой', () => {
  it('шаблон паспорта не готов к сдаче, заполненный — готов', async () => {
    const template = await readFile(join(process.cwd(), 'templates/project/wiki/passport.md'), 'utf8');
    expect(passportGaps(template)).toHaveLength(8);
    expect(passportGaps(FILLED_PASSPORT)).toEqual([]);
    expect(passportGaps(FILLED_PASSPORT.replace('## Домен и DNS', '## Домен'))).toEqual(['Домен и DNS']);
  });
});

describe('0.4.1: vibe-maestro pack', () => {
  it('архив тега без папок Maestro, с HANDOVER.md и шагом «смените все пароли и ключи»', async () => {
    const root = await deliveredProject();
    const out = join(await makeTempDir('out-'), 'архив.zip');
    const result = await packProject({ root, tag: 'v1.0.0', out });
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    const entries = readZip(await readFile(out));
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('src/index.js');
    expect(paths).toContain('docs/для-заказчика.md');
    expect(paths).toContain('.gitignore');
    for (const internal of INTERNAL_PATHS) {
      expect(paths.some((path) => (internal.endsWith('/') ? path.startsWith(internal) : path === internal)), internal).toBe(false);
    }
    const handover = entries.find((entry) => entry.path === HANDOVER_PATH)?.data.toString('utf8') ?? '';
    expect(handover).toContain('смените все пароли и ключи');
    expect(handover).toContain('STRIPE_SECRET_KEY');
    expect(handover).toContain('`v1.0.0`');
    expect(handover).not.toMatch(/^# Паспорт проекта$/m);
    expect(entries.find((entry) => entry.path === 'src/index.js')?.data.toString('utf8')).toBe('console.log("магазин");\n');
    if (process.platform !== 'win32') expect(entries.find((entry) => entry.path === 'scripts/run.sh')?.mode).toBe(0o100755);
  });

  it('повторная упаковка того же тега даёт тот же архив, даже после новых правок', async () => {
    const root = await deliveredProject();
    const dir = await makeTempDir('out-');
    const first = await packProject({ root, tag: 'v1.0.0', out: join(dir, 'a.zip') });
    await write(root, 'src/index.js', 'console.log("после сдачи");\n');
    await git(root, 'commit', '-qam', 'после сдачи');
    const later = new Date('2030-01-01T00:00:00Z');
    await utimes(join(root, 'src/index.js'), later, later);
    const second = await packProject({ root, tag: 'v1.0.0', out: join(dir, 'b.zip') });
    expect(second.sha256).toBe(first.sha256);
    expect(sha256(await readFile(join(dir, 'a.zip')))).toBe(sha256(await readFile(join(dir, 'b.zip'))));
    // Тот же путь ещё раз: файл не переписывается, команда говорит, что он совпадает.
    const again = await packProject({ root, tag: 'v1.0.0', out: join(dir, 'a.zip') });
    expect(again.ok).toBe(true);
    expect(again.reused).toBe(true);
  });

  it('отказ при секрете: по имени файла и по содержимому, значение не печатается', async () => {
    const key = `sk-ant-${'a1B2'.repeat(10)}`;
    const root = await deliveredProject({ '.env.production': 'X=1\n', 'src/config.js': `export const key = "${key}";\n` });
    const out = join(await makeTempDir('out-'), 'a.zip');
    const result = await packProject({ root, tag: 'v1.0.0', out });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'pack-secret', path: '.env.production' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'pack-secret', path: 'src/config.js' }));
    expect(JSON.stringify(result)).not.toContain(key);
    expect(existsSync(out)).toBe(false);
  });

  it('.env.example секретом не считается', async () => {
    const root = await deliveredProject({ '.env.example': 'STRIPE_SECRET_KEY=\n' });
    const result = await packProject({ root, tag: 'v1.0.0', out: join(await makeTempDir('out-'), 'a.zip') });
    expect(result.findings).toEqual([]);
  });

  it('отказ при служебной папке агента внутри продукта', async () => {
    const root = await deliveredProject({ 'app/.claude/settings.json': '{}\n' });
    const result = await packProject({ root, tag: 'v1.0.0', out: join(await makeTempDir('out-'), 'a.zip') });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'pack-internal-path', path: 'app/.claude/settings.json' }));
  });

  it('отказ при неполном паспорте называет пустые разделы', async () => {
    const root = join(await makeTempDir('pack-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: true, now: FIXED_NOW })).ok).toBe(true);
    await git(root, 'tag', 'v0.1.0');
    const result = await packProject({ root, tag: 'v0.1.0', out: join(await makeTempDir('out-'), 'a.zip') });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.code).toBe('pack-passport-incomplete');
    expect(result.findings[0]?.message).toContain('«Домен и DNS»');
  });

  it('неизвестный тег — понятный отказ со списком тегов', async () => {
    const root = await deliveredProject();
    const result = await packProject({ root, tag: 'v9', out: join(await makeTempDir('out-'), 'a.zip') });
    expect(result.findings[0]?.code).toBe('pack-tag-missing');
    expect(result.findings[0]?.message).toContain('v1.0.0');
  });

  it('другой файл по пути архива не перезаписывается', async () => {
    const root = await deliveredProject();
    const out = join(await makeTempDir('out-'), 'a.zip');
    await writeFile(out, 'чужое');
    const result = await packProject({ root, tag: 'v1.0.0', out });
    expect(result.findings[0]?.code).toBe('pack-out-exists');
    expect(await readFile(out, 'utf8')).toBe('чужое');
  });

  it('--out с папкой кладёт архив в неё под именем по умолчанию (ревью 0.4.1)', async () => {
    const root = await deliveredProject();
    const dir = await makeTempDir('out-');
    const result = await packProject({ root, tag: 'v1.0.0', out: dir });
    expect(result.ok).toBe(true);
    expect(result.archive).toBe(join(dir, 'Магазин-v1.0.0.zip'));
    expect(existsSync(join(dir, 'Магазин-v1.0.0.zip'))).toBe(true);
  });

  it('секреты, которые носят обычные проекты, ловятся; публичное и заготовки — нет (ревью 0.4.1)', () => {
    const secret = (text: string, path = 'src/a.js'): boolean => findSecrets(path, Buffer.from(text)).length > 0;
    const telegram = `${'7712345678'}:AA${'H'.repeat(33)}`;
    expect(secret(`const bot = "${telegram}";`)).toBe(true);
    expect(secret('DATABASE_URL=postgresql://postgres:Sup3rS3cret@db.example-host.co:5432/postgres')).toBe(true);
    expect(secret(`token: "sbp_${'a1'.repeat(20)}"`)).toBe(true);
    const payload = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
    const anon = Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase' })).toString('base64url');
    expect(secret(`key = "eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlLXNpZ25hdHVyZQ"`)).toBe(true);
    expect(secret(`key = "eyJhbGciOiJIUzI1NiJ9.${anon}.c2lnbmF0dXJlLXNpZ25hdHVyZQ"`)).toBe(false);
    expect(secret(`id = "ASIA${'Q'.repeat(16)}"`)).toBe(true);
    expect(secret(`aws_secret_access_key = ${'wJalrXUtnFEMIK7MDENGbPxRfiCYzzzzzzzzzz12'}`)).toBe(true);
    expect(secret('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(false);
    expect(secret('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(true);
    expect(secret('{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQ..."}')).toBe(true);
    expect(secret('const password = "Sup3rS3cretValue";')).toBe(true);
    expect(secret('x', '.envrc')).toBe(true);
    expect(secret('x', 'config/secrets.yaml')).toBe(true);
    expect(secret('x', 'data/app.sqlite')).toBe(true);
    // Не секреты.
    expect(secret('aws_access_key_id = AKIAIOSFODNN7EXAMPLE')).toBe(false);
    expect(secret("if (pem.startsWith('-----BEGIN PRIVATE KEY-----')) {")).toBe(false);
    expect(secret('apiKey: "AIzaSyD-public-firebase-browser-key-123456"')).toBe(false);
    expect(secret('DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app')).toBe(false);
    expect(secret('password: "${DB_PASSWORD}"')).toBe(false);
    expect(secret('password: "your-password-here"')).toBe(false);
    expect(secret('x', '.env.example')).toBe(false);
    // UTF-16 тоже читается.
    expect(findSecrets('a.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`k = "sk-ant-${'x'.repeat(30)}"`, 'utf16le')])).length).toBe(1);
  });

  it('--allow пропускает проверенный человеком файл', async () => {
    const root = await deliveredProject({ 'tests/fixture.js': 'const password = "NotARealPass123";\n' });
    const out = join(await makeTempDir('out-'), 'a.zip');
    expect((await packProject({ root, tag: 'v1.0.0', out })).findings[0]?.code).toBe('pack-secret');
    const refused = await packProject({ root, tag: 'v1.0.0', out });
    expect(refused.findings.at(-1)?.message).toContain('--allow');
    const allowed = await packProject({ root, tag: 'v1.0.0', out, allow: ['tests/fixture.js', 'нет/такого.txt'] });
    expect(allowed.ok).toBe(true);
    expect(allowed.notes).toContainEqual(expect.stringContaining('нет/такого.txt'));
  });

  it('файлы агентов глубже корня и ссылки за пределы проекта — отказ; .mcp.json в корне не входит', async () => {
    const root = await deliveredProject({ '.mcp.json': '{}\n', 'src/GEMINI.md': '# агент\n' });
    await execFileAsync('ln', ['-s', '/etc/hosts', join(root, 'hosts-link')]).catch(() => undefined);
    await git(root, 'add', '-A');
    await git(root, 'commit', '-qm', 'ссылка');
    await git(root, 'tag', '-a', 'v1.0.1', '-m', 'x');
    const result = await packProject({ root, tag: 'v1.0.1', out: join(await makeTempDir('out-'), 'a.zip') });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'pack-internal-path', path: 'src/GEMINI.md' }));
    expect(result.findings.map((item) => item.path)).not.toContain('.mcp.json');
    if (process.platform !== 'win32') expect(result.findings).toContainEqual(expect.objectContaining({ code: 'pack-symlink-outside', path: 'hosts-link' }));
  });

  it('тот же тег — те же байты при core.autocrlf и подписи в логе (ревью 0.4.1)', async () => {
    const root = await deliveredProject({ 'src/текст.txt': 'строка\n' });
    const dir = await makeTempDir('out-');
    const plain = await packProject({ root, tag: 'v1.0.0', out: join(dir, 'a.zip') });
    await git(root, 'config', 'core.autocrlf', 'true');
    await git(root, 'config', 'log.showSignature', 'true');
    const tuned = await packProject({ root, tag: 'v1.0.0', out: join(dir, 'b.zip') });
    expect(tuned.sha256).toBe(plain.sha256);
  });

  it('паспорт: обычный текст со словами «пока нет» — запись, заготовка и пустой комментарий — нет', () => {
    const filled = FILLED_PASSPORT.replace('- не применимо\n\n## Внешние', '- Резервных копий пока нет — их настраивает заказчик.\n\n## Внешние');
    expect(passportGaps(filled)).toEqual([]);
    expect(passportGaps(FILLED_PASSPORT.replace('- Stripe — аккаунт заказчика', '<!-- потом -->'))).toEqual(['Внешние сервисы и чей аккаунт']);
    expect(passportGaps(FILLED_PASSPORT.replace('- Stripe — аккаунт заказчика', '- Stripe — аккаунт заказчика\n- Почта: пока нет'))).toEqual(['Внешние сервисы и чей аккаунт']);
  });

  it('CLI: --tag обязателен, вывод называет архив и sha256', async () => {
    const usage = collect();
    expect(await runMaestroCli(['pack', '--path', '.'], usage.io)).toBe(2);
    expect(usage.stderr()).toContain('--tag');

    const root = await deliveredProject();
    const out = join(await makeTempDir('out-'), 'a.zip');
    const cli = collect();
    expect(await runMaestroCli(['pack', '--path', root, '--tag', 'v1.0.0', '--out', out], cli.io)).toBe(0);
    expect(cli.stdout()).toContain(out);
    expect(cli.stdout()).toMatch(/sha256: [0-9a-f]{64}/);
    expect(cli.stdout()).toContain('пароли и ключи');
  });
});

async function writeTranscript(claudeDir: string, root: string, lines: unknown[], name = 'session-1'): Promise<string> {
  const dir = join(claudeDir, 'projects', projectLogDirName(root));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

const assistant = (id: string, input: number, cacheRead: number, output: number, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  sessionId: 's-1',
  ...extra,
  message: { id, model: 'claude', usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, output_tokens: output } },
});

describe('0.4.1: vibe-maestro context', () => {
  it('папка журнала называется так же, как у Claude Code', () => {
    // Всё, кроме латиницы и цифр, становится `-`; на Windows путь начинается с буквы диска.
    if (process.platform === 'win32') expect(projectLogDirName('C:\\Users\\me\\my-app\\.claude\\x_1')).toBe('C--Users-me-my-app--claude-x-1');
    else expect(projectLogDirName('/Users/me/projects/my-app/.claude/worktrees/x_1')).toBe('-Users-me-projects-my-app--claude-worktrees-x-1');
  });

  it('берёт контекст последнего ответа, считает вход за всю сессию и не учитывает субагентов', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    await writeTranscript(claudeDir, root, [
      { type: 'user', message: { content: 'секретный текст переписки' } },
      assistant('m1', 10, 20_000, 500),
      assistant('m1', 10, 20_000, 500),
      assistant('sub', 5, 900_000, 5, { isSidechain: true }),
      assistant('m2', 10, 90_000, 1_000),
    ]);
    const report = await measureContext({ root, claudeDir });
    expect(report.ok).toBe(true);
    expect(report.contextTokens).toBe(91_010);
    expect(report.percent).toBe(46);
    expect(report.level).toBe('finish-slice');
    expect(report.totalInputTokens).toBe(110_020);
    expect(report.requests).toBe(2);
    expect(JSON.stringify(report)).not.toContain('секретный');
  });

  it('пороги 40 и 70 процентов', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    await writeTranscript(claudeDir, root, [assistant('a', 0, 50_000, 0)]);
    expect((await measureContext({ root, claudeDir })).level).toBe('continue');
    await writeTranscript(claudeDir, root, [assistant('a', 0, 150_000, 0)]);
    expect((await measureContext({ root, claudeDir })).level).toBe('new-session');
    expect((await measureContext({ root, claudeDir, budget: 1_000_000 })).level).toBe('continue');
  });

  it('берёт самый свежий журнал папки и находит журнал по рабочей папке, если имя папки другое', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    const old = await writeTranscript(claudeDir, root, [assistant('a', 0, 10_000, 0)], 'old');
    await utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
    await writeTranscript(claudeDir, root, [assistant('b', 0, 30_000, 0)], 'new');
    expect((await measureContext({ root, claudeDir })).contextTokens).toBe(30_000);

    const other = join(await makeTempDir('proj-'), 'Проект с пробелом');
    await mkdir(other);
    const dir = join(claudeDir, 'projects', 'усечённое-имя');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'x.jsonl'), `${JSON.stringify({ ...assistant('c', 0, 7_000, 0), cwd: other })}\n`);
    expect((await measureContext({ root: other, claudeDir })).contextTokens).toBe(7_000);
  });

  it('id сессии из Claude Code выбирает её журнал, даже если другой свежее', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    const mine = await writeTranscript(claudeDir, root, [assistant('a', 0, 12_000, 0)], 'aaaa-1111');
    await utimes(mine, new Date('2020-01-01'), new Date('2020-01-01'));
    await writeTranscript(claudeDir, root, [assistant('b', 0, 99_000, 0)], 'bbbb-2222');
    expect((await measureContext({ root, claudeDir, sessionId: 'aaaa-1111' })).contextTokens).toBe(12_000);
    // Неизвестный id — отказ, а не чужая сессия (ревью 0.4.1).
    const unknown = await measureContext({ root, claudeDir, sessionId: 'zzzz-9999' });
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('zzzz-9999');
    expect((await measureContext({ root, claudeDir })).contextTokens).toBe(99_000);
  });

  it('запись без расхода (<synthetic>) не обнуляет размер; большая сессия — окно 1 000 000 (ревью 0.4.1)', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    await writeTranscript(claudeDir, root, [assistant('a', 0, 250_000, 0), assistant('b', 0, 410_000, 0), assistant('c', 0, 0, 0)]);
    const report = await measureContext({ root, claudeDir });
    expect(report.contextTokens).toBe(410_000);
    expect(report.budget).toBe(1_000_000);
    expect(report.percent).toBe(41);
    expect(report.level).toBe('finish-slice');
    expect((await measureContext({ root, claudeDir, budget: 200_000 })).level).toBe('new-session');
  });

  it('без журнала — понятный отказ', async () => {
    const report = await measureContext({ root: await makeTempDir('proj-'), claudeDir: await makeTempDir('claude-') });
    expect(report.ok).toBe(false);
    expect(report.message).toContain('не найден');
  });

  it('CLI говорит простыми словами и называет пороги гипотезой', async () => {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    await writeTranscript(claudeDir, root, [assistant('a', 0, 150_000, 0)]);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      const cli = collect();
      expect(await runMaestroCli(['context', '--path', root], cli.io)).toBe(0);
      expect(cli.stdout()).toContain('150 000 токенов (75% окна модели в 200 000)');
      expect(cli.stdout()).toContain('Пора в новую сессию');
      expect(cli.stdout()).toContain('гипотеза');
      // Сессия больше 200 000 — окно модели 1 000 000, и CLI это учитывает.
      await writeTranscript(claudeDir, root, [assistant('b', 0, 450_000, 0)]);
      const large = collect();
      expect(await runMaestroCli(['context', '--path', root], large.io)).toBe(0);
      expect(large.stdout()).toContain('450 000 токенов (45% окна модели в 1 000 000)');
      const bad = collect();
      expect(await runMaestroCli(['context', '--window', 'много'], bad.io)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    expect(formatTokens(1234567)).toBe('1 234 567');
    expect([1, 2, 5, 11, 22, 413632, 101].map(tokensWord)).toEqual(['токен', 'токена', 'токенов', 'токенов', 'токена', 'токена', 'токен']);
  });
});
