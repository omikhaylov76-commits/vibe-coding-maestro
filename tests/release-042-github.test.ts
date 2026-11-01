import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ReadStream, WriteStream } from 'node:tty';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import { createReadlinePrompt } from '../src/cli/prompt.js';
import type { InteractiveAnswers } from '../src/cli/prompt.js';
import { createRenderer } from '../src/cli/renderer.js';
import { doctorProject } from '../src/core/doctor.js';
import { createGithubCopy, defaultGhRunner, githubReady, githubRepoName } from '../src/core/github.js';
import type { GhResult, GhRunner } from '../src/core/github.js';
import { initProject } from '../src/core/init.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

afterEach(cleanupTempDirs);

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout.trim();
const FAKE_GH = join(process.cwd(), 'tests/fixtures/fake-gh.mjs');

type Mode = 'ok' | 'noauth' | 'fail' | 'hang';

/** Поддельный gh через Node: так он запускается и на Windows, где `.cmd` без оболочки не стартует. */
async function fakeGh(mode: Mode): Promise<{ runner: GhRunner; calls: () => Promise<string[][]>; remotes: string }> {
  const dir = await makeTempDir('fake-gh-');
  const log = join(dir, 'calls.log');
  const remotes = join(dir, 'remotes');
  const runner: GhRunner = (args, options) => new Promise<GhResult>((resolve) => {
    execFile(process.execPath, [FAKE_GH, ...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      encoding: 'utf8',
      env: { ...process.env, FAKE_GH_MODE: mode, FAKE_GH_LOG: log, FAKE_GH_REMOTES: remotes },
    }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if ((error as { killed?: boolean }).killed === true) resolve({ code: null, stdout, stderr, failure: 'timeout' });
      else resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
  const calls = async (): Promise<string[][]> => existsSync(log)
    ? (await readFile(log, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[])
    : [];
  return { runner, calls, remotes };
}

const missingGh: GhRunner = async () => ({ code: null, stdout: '', stderr: '', failure: 'missing' });

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out: () => out.join('\n'), err: () => err.join('\n') };
}

async function target(name = 'Мой проект'): Promise<string> {
  return join(await makeTempDir('github-'), name);
}

describe('0.4.2: имя репозитория — латиницей из названия папки', () => {
  it.each([
    ['Мой проект', 'Moy-proekt'],
    ['Щука и Ёжик', 'Shchuka-i-Ezhik'],
    ['Café Été', 'Cafe-Ete'],
    ['my.project_v2', 'my.project_v2'],
    ['  --лендинг 2026!!  ', 'lending-2026'],
    ['Їжак Євген', 'Yizhak-Yevgen'],
  ])('%s → %s', (folder, expected) => {
    expect(githubRepoName(folder, FIXED_NOW)).toBe(expected);
  });

  it('пустое после очистки имя — project-ГГГГММДД; длинное — не длиннее 100', () => {
    expect(githubRepoName('★★★', FIXED_NOW)).toBe(`project-${FIXED_NOW.toISOString().slice(0, 10).replace(/-/g, '')}`);
    expect(githubRepoName('...', FIXED_NOW)).toMatch(/^project-\d{8}$/);
    expect(githubRepoName('а'.repeat(300), FIXED_NOW)).toHaveLength(100);
  });
});

describe('0.4.2: проверка входа в gh', () => {
  it('вход есть — да; входа нет, gh нет, gh завис — нет', async () => {
    expect(await githubReady((await fakeGh('ok')).runner)).toBe(true);
    expect(await githubReady((await fakeGh('noauth')).runner)).toBe(false);
    expect(await githubReady(missingGh)).toBe(false);
    const started = Date.now();
    expect(await githubReady((await fakeGh('hang')).runner, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('спрашивает только github.com', async () => {
    const gh = await fakeGh('ok');
    await githubReady(gh.runner);
    expect(await gh.calls()).toEqual([['auth', 'status', '--hostname', 'github.com']]);
  });

  it.skipIf(process.platform === 'win32')('настоящий запуск находит gh в PATH, а без gh отвечает «нет»', async () => {
    const bin = await makeTempDir('fake-bin-');
    await writeFile(join(bin, 'gh'), `#!/bin/sh\nFAKE_GH_MODE=ok exec "${process.execPath}" "${FAKE_GH}" "$@"\n`, 'utf8');
    await chmod(join(bin, 'gh'), 0o755);
    const path = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${path ?? ''}`;
      expect(await githubReady(defaultGhRunner)).toBe(true);
      process.env.PATH = await makeTempDir('empty-bin-');
      expect(await githubReady(defaultGhRunner)).toBe(false);
      // Ревью L6: git внутри gh не спрашивает логин в терминале.
      await writeFile(join(bin, 'gh'), '#!/bin/sh\n[ "$GIT_TERMINAL_PROMPT" = 0 ] && [ "$GH_PROMPT_DISABLED" = 1 ]\n', 'utf8');
      process.env.PATH = `${bin}:${path ?? ''}`;
      expect(await githubReady(defaultGhRunner)).toBe(true);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('0.4.2: create --github', () => {
  it('после первого коммита заводит закрытый репозиторий, показывает адрес; doctor --strict без замечаний', async () => {
    const gh = await fakeGh('ok');
    const root = await target();
    const cli = collect();
    expect(await runCreateCli(['--yes', '--target', root, '--github'], cli.io, { isTty: false, gh: gh.runner })).toBe(0);
    expect(await gh.calls()).toEqual([['repo', 'create', 'Moy-proekt', '--private', '--source', expect.any(String), '--remote', 'origin', '--push']]);
    // Источник — сама папка проекта; путь сравниваем по диску: временные папки бывают под /private или в коротком имени Windows.
    const source = (await gh.calls())[0]?.[5] as string;
    expect(await realpath(source)).toBe(await realpath(root));
    expect(cli.out()).toContain('Копия в облаке: https://github.com/tester/Moy-proekt');
    expect(await git(root, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('без --github create --yes репозиторий не заводит и gh не зовёт', async () => {
    const gh = await fakeGh('ok');
    const root = await target();
    const cli = collect();
    expect(await runCreateCli(['--yes', '--target', root], cli.io, { isTty: false, gh: gh.runner })).toBe(0);
    expect(await gh.calls()).toEqual([]);
    expect(cli.out()).toContain('Копии в облаке нет — завести её поможет /start.');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([expect.objectContaining({ code: 'git-no-remote', level: 'info' })]);
  });

  it.each([
    ['fail', 'Name already exists on this account'],
    ['hang', 'gh не ответил'],
  ] as const)('сбой gh (%s) — предупреждение, проект создан, код выхода 0, команда на потом', async (mode, reason) => {
    const gh = await fakeGh(mode);
    const root = await target();
    const cli = collect();
    // Таймаут создания в реальной работе — 2 минуты; здесь подменён настоящий gh, но время то же,
    // поэтому зависший вызов обрываем коротким раннером.
    const runner: GhRunner = (args, options) => gh.runner(args, { ...options, timeoutMs: Math.min(options.timeoutMs, 1_000) });
    expect(await runCreateCli(['--yes', '--target', root, '--github'], cli.io, { isTty: false, gh: runner })).toBe(0);
    expect(cli.err()).toContain('Копию на GitHub завести не удалось');
    expect(cli.err()).toContain(reason);
    expect(cli.err()).toContain('Проект создан');
    expect(cli.err()).toContain('gh repo create Moy-proekt --private --source . --remote origin --push');
    expect(cli.out()).toContain('Копии в облаке нет');
    expect(existsSync(join(root, '.maestro/manifest.json'))).toBe(true);
  });

  it('нет gh — понятная причина, проект создан', async () => {
    const root = await target();
    const cli = collect();
    expect(await runCreateCli(['--yes', '--target', root, '--github'], cli.io, { isTty: false, gh: missingGh })).toBe(0);
    expect(cli.err()).toContain('не найдена программа GitHub CLI (gh)');
  });

  it('--github вместе с --no-git — ошибка до создания', async () => {
    const gh = await fakeGh('ok');
    const root = await target();
    const cli = collect();
    expect(await runCreateCli(['--yes', '--target', root, '--github', '--no-git'], cli.io, { isTty: false, gh: gh.runner })).toBe(2);
    expect(cli.err()).toContain('--no-git');
    expect(cli.err()).toContain('Проект не создан');
    expect(existsSync(root)).toBe(false);
    expect(await gh.calls()).toEqual([]);
  });

  it('повторный create готового проекта: --github не применяется, сказано почему', async () => {
    const gh = await fakeGh('ok');
    const root = await target();
    expect(await runCreateCli(['--yes', '--target', root, '--github'], collect().io, { isTty: false, gh: gh.runner })).toBe(0);
    const again = collect();
    expect(await runCreateCli(['--yes', '--target', root, '--github'], again.io, { isTty: false, gh: gh.runner })).toBe(0);
    expect(again.err()).toContain('Копию на GitHub не завожу');
    expect(again.err()).toContain('уже есть');
    // Ревью M5: у готового проекта с remote строка о копии — правдивая.
    expect(again.out()).toContain('Копия в облаке: ');
    expect(again.out()).not.toContain('Копии в облаке нет');
    expect(await gh.calls()).toHaveLength(1);

    const plain = await target('без облака');
    expect(await runCreateCli(['--yes', '--target', plain], collect().io, { isTty: false })).toBe(0);
    const third = collect();
    expect(await runCreateCli(['--yes', '--target', plain, '--github'], third.io, { isTty: false, gh: gh.runner })).toBe(0);
    expect(third.err()).toContain('create не меняет готовый проект');
    expect(await gh.calls()).toHaveLength(1);
  });

  it('JSON-отчёт называет итог шага с облаком', async () => {
    const root = await target();
    const cli = collect();
    expect(await runCreateCli(['--yes', '--json', '--target', root, '--github'], cli.io, { isTty: false, gh: missingGh })).toBe(0);
    const report = JSON.parse(cli.out()) as { github: { status: string; reason: string } };
    expect(report.github).toMatchObject({ status: 'failed', reason: 'не найдена программа GitHub CLI (gh)' });
  });

  it('createGithubCopy без адреса в выводе gh берёт адрес из remote', async () => {
    const root = await target();
    expect((await initProject({ target: root, startingPoint: 'idea', git: true, now: FIXED_NOW })).ok).toBe(true);
    const silent: GhRunner = async () => {
      await git(root, 'remote', 'add', 'origin', 'git@github.com:tester/Moy-proekt.git');
      return { code: 0, stdout: '', stderr: '' };
    };
    expect(await createGithubCopy(root, 'Moy-proekt', silent)).toEqual({ ok: true, url: 'git@github.com:tester/Moy-proekt.git' });
  });
});

/** Поддельный терминал: только то, что читает мастер. */
class FakeInput extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
class FakeOutput extends PassThrough {
  isTTY = true; columns = 100; private chunks: string[] = [];
  override write(chunk: unknown): boolean { this.chunks.push(String(chunk)); return true; }
  text(): string { return this.chunks.join(''); }
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('0.4.2: мастер — GitHub вариантом в первом вопросе', () => {
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  async function firstQuestion(detectGithub: () => Promise<boolean>): Promise<{ text: string; answer: Promise<InteractiveAnswers>; input: FakeInput; output: FakeOutput }> {
    process.env.NO_COLOR = '1';
    const input = new FakeInput();
    const output = new FakeOutput();
    const answer = createReadlinePrompt(input as unknown as ReadStream, output as unknown as WriteStream, { detectGithub }).ask();
    await waitFor(() => output.text().includes('Что вы хотите сделать?'), 'первый вопрос');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { text: output.text(), answer, input, output };
  }

  it('gh и вход есть — третий вариант последним; «1» и «2» прежние; шагов по-прежнему три', async () => {
    const { text, answer, input, output } = await firstQuestion(async () => true);
    expect(text).toContain('1. Создать новый проект');
    expect(text).toContain('2. Проверить canonical project');
    expect(text).toContain('3. Создать новый проект и закрытую копию на GitHub');
    input.write('3');
    await waitFor(() => output.text().includes('Как назовём проект?'), 'второй вопрос');
    input.write('Demo\n');
    await waitFor(() => output.text().includes('С чего вы начинаете?'), 'третий вопрос');
    input.write('1');
    const result = await answer;
    expect(result).toMatchObject({ action: 'create', name: 'Demo', github: true });
  });

  it('по умолчанию выбран «Создать новый проект» без облака', async () => {
    const { answer, input, output } = await firstQuestion(async () => true);
    input.write('\r');
    await waitFor(() => output.text().includes('Как назовём проект?'), 'второй вопрос');
    input.write('Demo\n');
    await waitFor(() => output.text().includes('С чего вы начинаете?'), 'третий вопрос');
    input.write('1');
    expect(await answer).toMatchObject({ action: 'create', github: false });
  });

  it.each([
    ['входа нет', async () => githubReady((await fakeGh('noauth')).runner)],
    ['gh нет', async () => githubReady(missingGh)],
    ['gh завис', async () => githubReady((await fakeGh('hang')).runner, 500)],
  ])('%s — варианта нет', async (_label, detect) => {
    const { text, input, answer } = await firstQuestion(detect);
    expect(text).not.toContain('закрытую копию на GitHub');
    input.emit('close');
    await expect(answer).rejects.toThrow('поток ввода закрыт');
  });

  it('выбор из мастера доходит до create: копия заведена', async () => {
    const gh = await fakeGh('ok');
    const root = await target();
    const prompt = { ask: vi.fn(async (): Promise<InteractiveAnswers> => ({ action: 'create', target: root, name: 'Мой проект', startingPoint: 'idea', usedDesktopDefault: false, github: true })) };
    expect(await runCreateCli([], collect().io, { isTty: true, prompt, gh: gh.runner })).toBe(0);
    expect((await gh.calls())[0]?.slice(0, 4)).toEqual(['repo', 'create', 'Moy-proekt', '--private']);
  });
});

describe('0.4.2: экран после создания называет копию в облаке', () => {
  it.each([
    ['https://github.com/tester/demo', 'Копия в облаке: https://github.com/tester/demo'],
    [null, 'Копии в облаке нет — завести её поможет /start.'],
  ])('%s', (cloud, line) => {
    const lines: string[] = [];
    createRenderer((text) => lines.push(text), { isTty: false, columns: 120, env: { NO_COLOR: '1' }, unicode: false })
      .success({ action: 'create', target: '/tmp/demo', doctorOk: true, cloud });
    expect(lines.join('')).toContain(line);
  });
});

describe('0.4.2: doctor — копия в облаке по локальным данным git', () => {
  async function project(): Promise<string> {
    const root = await target('проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: true, now: FIXED_NOW })).ok).toBe(true);
    return root;
  }
  const commit = async (root: string, file: string): Promise<void> => {
    await writeFile(join(root, file), `${file}\n`, 'utf8');
    await git(root, 'add', file);
    await git(root, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', file);
  };

  it('нет remote — info git-no-remote; обычная проверка и --strict зелёные', async () => {
    const root = await project();
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([expect.objectContaining({ code: 'git-no-remote', level: 'info' })]);
    expect(report.findings[0]?.message).toContain('`/start`');
  });

  it('remote есть, upstream нет — info git-no-upstream с командой первой отправки', async () => {
    const root = await project();
    await git(root, 'remote', 'add', 'origin', join(await makeTempDir('bare-'), 'x.git'));
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([expect.objectContaining({ code: 'git-no-upstream', level: 'info' })]);
    expect(report.findings[0]?.message).toContain('git push -u origin main');
  });

  it('коммиты впереди upstream — info git-unpushed с числом и оговоркой о последней синхронизации', async () => {
    const root = await project();
    const bare = join(await makeTempDir('bare-'), 'x.git');
    await git(root, 'init', '-q', '--bare', bare);
    await git(root, 'remote', 'add', 'origin', bare);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    await commit(root, 'a.txt');
    await commit(root, 'b.txt');
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([expect.objectContaining({ code: 'git-unpushed', level: 'info' })]);
    expect(report.findings[0]?.message).toContain(': 2');
    expect(report.findings[0]?.message).toContain('по данным последней синхронизации');
  });

  it('remote на несуществующий адрес: проверка не ходит в сеть и отвечает сразу', async () => {
    const root = await project();
    await git(root, 'remote', 'add', 'origin', 'https://nonexistent.invalid/никого/нет.git');
    await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(root, 'branch', '--set-upstream-to=origin/main', 'main');
    await commit(root, 'a.txt');
    const started = Date.now();
    const report = await doctorProject(root, { strict: true });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report.findings.map((item) => item.code)).toEqual(['git-unpushed']);
  });

  it('проект без git — ни одного сообщения о копии', async () => {
    const root = await target('без git');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('doctor о копии зовёт только локальные команды git — ни fetch, ни ls-remote (ревью L9)', async () => {
    // Комментарии не в счёт: в них честно сказано, что `git fetch` не запускается.
    const source = (await readFile(join(process.cwd(), 'src/core/doctor/git.ts'), 'utf8'))
      .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
    const commands = [...source.matchAll(/gitAnswer\(root, \['([a-z-]+)'/g)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(['remote', 'symbolic-ref', 'rev-parse', 'rev-list'], command).toContain(command);
    for (const network of ['fetch', 'ls-remote', 'pull', "'update'", "'show'"]) expect(source, network).not.toContain(network);
  });

  it('git-no-upstream называет настоящий remote, а не всегда origin (ревью L5)', async () => {
    const root = await project();
    await git(root, 'remote', 'add', 'backup', join(await makeTempDir('bare-'), 'x.git'));
    const finding = (await doctorProject(root)).findings.find((item) => item.code === 'git-no-upstream');
    expect(finding?.message).toContain('git push -u backup main');
  });

  it('число проблем в выводе doctor не считает пометки info (ревью L3)', async () => {
    const root = await project();
    await writeFile(join(root, 'protocols/status.md'), 'правка\n', 'utf8');
    const { runMaestroCli } = await import('../src/cli/maestro.js');
    const cli = collect();
    expect(await runMaestroCli(['doctor', '--path', root], cli.io)).toBe(1);
    const report = await doctorProject(root);
    const problems = report.findings.filter((item) => item.level !== 'info').length;
    expect(problems).toBeLessThan(report.findings.length);
    expect(cli.err()).toContain(`найдено проблем — ${problems}.`);
    expect(cli.err()).toContain('git-no-remote');
  });
});

describe('0.4.2: адрес копии печатается без пароля (ревью N1)', () => {
  it('логин и токен из адреса remote не попадают в вывод create', async () => {
    const root = await target('с токеном');
    expect(await runCreateCli(['--yes', '--target', root], collect().io, { isTty: false })).toBe(0);
    await git(root, 'remote', 'add', 'origin', 'https://oleg:ghp_FAKEFAKEFAKE1234567890@github.com/oleg/local.git');
    const again = collect();
    expect(await runCreateCli(['--yes', '--target', root], again.io, { isTty: false })).toBe(0);
    expect(again.out()).toContain('Копия в облаке: https://github.com/oleg/local.git');
    expect(`${again.out()}\n${again.err()}`).not.toContain('ghp_');
  });
});
