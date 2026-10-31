import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { formatTokens } from '../src/cli/context-run.js';
import { measureContext, projectLogDirName } from '../src/core/context.js';
import { initProject } from '../src/core/init.js';
import { HANDOVER_PATH, INTERNAL_PATHS, packProject, passportGaps } from '../src/core/pack.js';
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
    expect(projectLogDirName('/Users/me/projects/my-app/.claude/worktrees/x_1')).toBe('-Users-me-projects-my-app--claude-worktrees-x-1');
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
    expect((await measureContext({ root, claudeDir, sessionId: 'нет-такой' })).contextTokens).toBe(99_000);
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
      expect(cli.stdout()).toContain('150 000 токенов (75% от 200 000)');
      expect(cli.stdout()).toContain('Пора в новую сессию');
      expect(cli.stdout()).toContain('гипотеза');
      const bad = collect();
      expect(await runMaestroCli(['context', '--window', 'много'], bad.io)).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
    expect(formatTokens(1234567)).toBe('1 234 567');
  });
});
