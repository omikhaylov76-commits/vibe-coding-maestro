import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { executeUpgradeCommand } from '../src/cli/upgrade-run.js';
import { countChars } from '../src/core/archive/limits.js';
import { levelFor, measureContext, projectLogDirName, thresholdsFor } from '../src/core/context.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { planBodyDigest } from '../src/core/plan.js';
import { STAGING_DIR, upgradeProject } from '../src/core/upgrade/index.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';
import { collectIo, materializePublished } from './published.js';

const execFileAsync = promisify(execFile);
afterEach(cleanupTempDirs);
// Тесты не зависят от сессии Claude Code, в которой их запустили.
delete process.env.CLAUDE_CODE_SESSION_ID;

describe('0.4.5: context считает пороги в токенах', () => {
  /** Проект с журналом из одного ответа модели. */
  async function session(model: string, tokens: number): Promise<{ root: string; claudeDir: string }> {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    const dir = join(claudeDir, 'projects', projectLogDirName(root));
    await mkdir(dir, { recursive: true });
    const usage = { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 0 };
    await writeFile(join(dir, 'session-1.jsonl'), `${JSON.stringify({ type: 'assistant', sessionId: 's-1', message: { id: 'm1', model, usage } })}\n`);
    return { root, claudeDir };
  }

  it('окно 1 000 000: границы 400 000 и 600 000', async () => {
    for (const [tokens, level] of [[399_999, 'continue'], [400_000, 'finish-slice'], [599_999, 'finish-slice'], [600_000, 'new-session']] as const) {
      const report = await measureContext(await session('claude-opus-5-5', tokens));
      expect([tokens, report.budget, report.level]).toEqual([tokens, 1_000_000, level]);
      expect([report.finishSliceTokens, report.newSessionTokens]).toEqual([400_000, 600_000]);
    }
  });

  it('окно 200 000: прежние 80 000 и 140 000', async () => {
    for (const [tokens, level] of [[79_999, 'continue'], [80_000, 'finish-slice'], [139_999, 'finish-slice'], [140_000, 'new-session']] as const) {
      const report = await measureContext(await session('claude-haiku-4-5', tokens));
      expect([tokens, report.budget, report.level]).toEqual([tokens, 200_000, level]);
      expect([report.finishSliceTokens, report.newSessionTokens]).toEqual([80_000, 140_000]);
    }
  });

  it('--window работает по тому же правилу', async () => {
    for (const [tokens, level] of [[119_999, 'continue'], [120_000, 'finish-slice'], [209_999, 'finish-slice'], [210_000, 'new-session']] as const) {
      const report = await measureContext({ ...await session('claude-opus-5-5', tokens), budget: 300_000 });
      expect([tokens, report.windowSource, report.level]).toEqual([tokens, 'option', level]);
    }
    expect(thresholdsFor(300_000)).toEqual({ finishSliceTokens: 120_000, newSessionTokens: 210_000 });
    // Больше окна — те же 400 000 и 600 000; порог не растёт вслед за окном.
    expect(thresholdsFor(2_000_000)).toEqual({ finishSliceTokens: 400_000, newSessionTokens: 600_000 });
    // Каждый порог — своё меньшее из двух.
    expect(thresholdsFor(900_000)).toEqual({ finishSliceTokens: 360_000, newSessionTokens: 600_000 });
    expect(levelFor(360_000, 900_000)).toBe('finish-slice');
  });

  it('незнакомая модель — окно как раньше, по размеру сессии', async () => {
    const small = await measureContext(await session('claude-nova-1', 100_000));
    expect([small.budget, small.windowSource, small.level]).toEqual([200_000, 'unknown-model', 'finish-slice']);
    const large = await measureContext(await session('claude-nova-1', 450_000));
    expect([large.budget, large.windowSource, large.level]).toEqual([1_000_000, 'unknown-model', 'finish-slice']);
  });

  it('поля отчёта прежние, строка CLI называет настоящие пороги', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      const large = await session('claude-opus-5-5', 450_000);
      process.env.CLAUDE_CONFIG_DIR = large.claudeDir;
      const cli = collectIo();
      expect(await runMaestroCli(['context', '--path', large.root], cli.io)).toBe(0);
      expect(cli.stdout()).toContain('450 000 токенов (45% окна модели в 1 000 000).');
      expect(cli.stdout()).toContain('Пороги 400 000 и 600 000 токенов — гипотеза; их уточнит замер.');

      const small = await session('claude-haiku-4-5', 100_000);
      process.env.CLAUDE_CONFIG_DIR = small.claudeDir;
      const narrow = collectIo();
      expect(await runMaestroCli(['context', '--path', small.root], narrow.io)).toBe(0);
      expect(narrow.stdout()).toContain('Пороги 80 000 и 140 000 токенов — гипотеза; их уточнит замер.');

      const json = collectIo();
      expect(await runMaestroCli(['context', '--path', small.root, '--json'], json.io)).toBe(0);
      const report = JSON.parse(json.stdout()) as Record<string, unknown>;
      expect(report).toMatchObject({ reportVersion: 1, percent: 50, budget: 200_000, level: 'finish-slice', finishSliceTokens: 80_000, newSessionTokens: 140_000 });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

describe('0.4.5: doctor видит отставшую память', () => {
  const PLAN = 'wiki/plans/0002-work.md';
  const HANDOFF = 'wiki/handoffs/2026-11-01-work.md';
  const git = async (cwd: string, ...args: string[]): Promise<string> =>
    (await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd })).stdout.trim();

  async function commitAll(root: string, message: string): Promise<void> {
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '--allow-empty', '-m', message);
  }

  /** Проект в git с активным планом и порцией; `handoff` — закоммичена ли передача. */
  async function project(options: { slice?: string; handoff?: string | null } = {}): Promise<string> {
    const root = join(await makeTempDir('lag-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await git(root, 'init', '-q');
    const slice = options.slice ?? '01-vhod';
    const plan = ['---', 'type: plan', 'title: Работа', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension',
      'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', 'sources: []', 'supersedes: null', 'approved_by: Человек',
      'approved_at: 2026-11-01', 'active_phase: null', 'blocking_questions: 0', 'spec_delta: none', `current_slice: ${slice}`, '---', '', '# Работа', ''].join('\n');
    await writeFile(join(root, PLAN), plan.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${planBodyDigest(plan)}`), 'utf8');
    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-work.md'), 'utf8');
    if (options.handoff !== null) await writeFile(join(root, options.handoff ?? HANDOFF), '# Передача\n', 'utf8');
    await commitAll(root, 'начало');
    return root;
  }

  async function codeCommits(root: string, count: number, from = 0): Promise<void> {
    await mkdir(join(root, 'src'), { recursive: true });
    for (let index = from; index < from + count; index += 1) {
      await writeFile(join(root, 'src/a.txt'), `${index}\n`, 'utf8');
      await commitAll(root, `код ${index}`);
    }
  }

  async function codes(root: string): Promise<string[]> {
    const report = await doctorProject(root);
    return report.findings.filter((item) => item.code === 'memory-hot-behind' || item.code === 'memory-handoff-behind').map((item) => item.code);
  }

  /** Maestro в папке с прошлой историей: create пишет только в пустую папку. */
  async function addMaestro(root: string): Promise<void> {
    const made = join(await makeTempDir('lag-'), 'проект');
    expect((await initProject({ target: made, startingPoint: 'code', git: false, now: FIXED_NOW })).ok).toBe(true);
    await cp(made, root, { recursive: true });
  }

  async function setCurrentSlice(root: string, value: string): Promise<void> {
    await writeFile(join(root, PLAN), (await readUtf8(root, PLAN)).replace(/^current_slice: .*$/m, `current_slice: ${value}`), 'utf8');
  }

  it('memory-hot-behind: порция, три коммита кода, wiki/hot.md её не называет', async () => {
    const root = await project();
    await codeCommits(root, 2);
    expect(await codes(root)).toEqual([]);
    await codeCommits(root, 1, 2);
    expect(await codes(root)).toEqual(['memory-hot-behind']);
    const finding = (await doctorProject(root)).findings.find((item) => item.code === 'memory-hot-behind');
    expect(finding).toMatchObject({ level: 'info', path: 'wiki/hot.md' });
    expect(finding?.message).toContain('01-vhod');
    expect(finding?.message).toContain('сверь `git log` и запиши передачу');
  });

  it('memory-hot-behind молчит при current_slice: null и когда порция названа', async () => {
    const root = await project();
    await codeCommits(root, 4);
    await setCurrentSlice(root, 'null');
    await commitAll(root, 'план');
    expect(await codes(root)).toEqual([]);

    await setCurrentSlice(root, '01-vhod');
    await writeFile(join(root, 'wiki/hot.md'), `${await readUtf8(root, 'wiki/hot.md')}\nПорция 01-vhod идёт.\n`, 'utf8');
    await commitAll(root, 'память');
    expect(await codes(root)).toEqual([]);
  });

  it('имя порции с точкой и дефисом — граница слова', async () => {
    const root = await project({ slice: '1.6a' });
    await codeCommits(root, 3);
    await writeFile(join(root, 'wiki/hot.md'), `${await readUtf8(root, 'wiki/hot.md')}\nПорция 1.6ab и 11.6a идут, версия 1x6a.\n`, 'utf8');
    await commitAll(root, 'память');
    expect(await codes(root)).toEqual(['memory-hot-behind']);
    await writeFile(join(root, 'wiki/hot.md'), `${await readUtf8(root, 'wiki/hot.md')}\nПорция «1.6a» идёт.\n`, 'utf8');
    await commitAll(root, 'память 2');
    expect(await codes(root)).toEqual([]);
  });

  it('memory-handoff-behind: 9 молчит, 10 есть; коммиты только в wiki/ не считаются', async () => {
    const root = await project();
    await writeFile(join(root, 'wiki/hot.md'), `${await readUtf8(root, 'wiki/hot.md')}\nПорция 01-vhod.\n`, 'utf8');
    await commitAll(root, 'память');
    await codeCommits(root, 9);
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(root, 'wiki/log.md'), `${await readUtf8(root, 'wiki/log.md')}\nзапись ${index}\n`, 'utf8');
      await commitAll(root, `журнал ${index}`);
    }
    expect(await codes(root)).toEqual([]);
    await codeCommits(root, 1, 9);
    expect(await codes(root)).toEqual(['memory-handoff-behind']);
    expect((await doctorProject(root)).findings.find((item) => item.code === 'memory-handoff-behind')?.message).toContain('10 при ориентире 10');
  });

  it('передач нет — счёт от коммита с manifest, история до него не считается', async () => {
    const root = join(await makeTempDir('lag-'), 'проект');
    await mkdir(root, { recursive: true });
    await git(root, 'init', '-q');
    await mkdir(join(root, 'src'));
    for (let index = 0; index < 12; index += 1) {
      await writeFile(join(root, 'src/old.txt'), `${index}\n`, 'utf8');
      await commitAll(root, `старое ${index}`);
    }
    await addMaestro(root);
    await commitAll(root, 'Maestro');
    expect(await codes(root)).toEqual([]);
    await codeCommits(root, 10);
    expect(await codes(root)).toEqual(['memory-handoff-behind']);
    expect((await doctorProject(root)).findings.find((item) => item.code === 'memory-handoff-behind')?.message).toContain('передач ещё не было, а коммитов кода с подключения Maestro: 10 при ориентире 10');
  });

  it('manifest не закоммичен, нет .git — молчит', async () => {
    const bare = join(await makeTempDir('lag-'), 'проект');
    expect((await initProject({ target: bare, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    expect(await codes(bare)).toEqual([]);

    const root = join(await makeTempDir('lag-'), 'проект');
    await mkdir(join(root, 'src'), { recursive: true });
    await git(root, 'init', '-q');
    await codeCommits(root, 12);
    await addMaestro(root);
    expect(await codes(root)).toEqual([]);
  });

  it('имя передачи без даты находится; поправленная ссылка в старой передаче счёт не сбрасывает', async () => {
    const root = await project({ handoff: 'wiki/handoffs/HANDOFF_2026-10-17_work.md' });
    await codeCommits(root, 3);
    expect(await codes(root)).toEqual(['memory-hot-behind']);
    await writeFile(join(root, 'wiki/handoffs/HANDOFF_2026-10-17_work.md'), '# Передача\n\n[план](../plans/archive/0002-work.md)\n', 'utf8');
    await commitAll(root, 'archive: поправлены ссылки');
    expect(await codes(root)).toEqual(['memory-hot-behind']);
    await writeFile(join(root, 'wiki/handoffs/2026-11-02-next.md'), '# Передача\n', 'utf8');
    await commitAll(root, 'передача');
    expect(await codes(root)).toEqual([]);
  });

  it('файл во вложенной папке передач передачей не считается', async () => {
    const root = await project();
    await codeCommits(root, 3);
    await mkdir(join(root, 'wiki/handoffs/old'));
    await writeFile(join(root, 'wiki/handoffs/old/x.md'), '# Старое\n', 'utf8');
    await commitAll(root, 'старое');
    expect(await codes(root)).toEqual(['memory-hot-behind']);
  });

  it('незакоммиченная свежая передача — молчит; старая неотслеживаемая — не глушит', async () => {
    const root = await project();
    await codeCommits(root, 3);
    const fresh = join(root, 'wiki/handoffs/2026-11-05-fresh.md');
    await writeFile(fresh, '# Передача\n', 'utf8');
    expect(await codes(root)).toEqual([]);
    await git(root, 'add', '--', 'wiki/handoffs/2026-11-05-fresh.md');
    expect(await codes(root)).toEqual([]);
    await git(root, 'reset', '-q', '--', 'wiki/handoffs/2026-11-05-fresh.md');
    await utimes(fresh, new Date('2020-01-01'), new Date('2020-01-01'));
    expect(await codes(root)).toEqual(['memory-hot-behind']);
  });

  it('мелкий клон и отказ git — молчит', async () => {
    const root = await project();
    await codeCommits(root, 12);
    expect(await codes(root)).toEqual(['memory-hot-behind', 'memory-handoff-behind'].sort());

    const shallow = join(await makeTempDir('lag-'), 'проект');
    await execFileAsync('git', ['clone', '-q', '--depth', '5', pathToFileURL(root).href, shallow]);
    expect(await codes(shallow)).toEqual([]);

    await rm(join(root, '.git/HEAD'));
    await writeFile(join(root, '.git/HEAD'), 'мусор\n', 'utf8');
    expect(await codes(root)).toEqual([]);
  });

  it('--strict и preflight не падают; порядок находок стабилен', async () => {
    const root = await project();
    await codeCommits(root, 12);
    const strict = await doctorProject(root, { strict: true });
    expect(strict.findings.filter((item) => item.level !== 'info')).toEqual([]);
    expect(strict.ok).toBe(true);
    const again = await doctorProject(root, { strict: true });
    expect(again.findings).toEqual(strict.findings);
    const cli = collectIo();
    expect(await runMaestroCli(['preflight', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).not.toContain('memory-');
  });
});

describe('0.4.5: upgrade честно говорит о неудачном откате', () => {
  const ID = '0.3.0-beta.3-standard';
  /** Сбой на последнем файле; `lose` — потерять backup уже опубликованного файла, тогда откат не удастся. */
  const failing = (root: string, lose: boolean) => ({
    beforeCommit: async (path: string): Promise<void> => {
      if (path !== '.maestro/checksums.json') return;
      if (lose) await rm(join(root, STAGING_DIR, 'backup', 'protocols', 'plan.md'), { force: true });
      throw new Error('сбой');
    },
  });

  it('откат не удался — первая строка не обещает «изменений нет», в --json partial: true', async () => {
    const { root } = await materializePublished(ID);
    const cli = collectIo();
    expect(await executeUpgradeCommand({ path: root, json: false, apply: true, hooks: failing(root, true) }, cli.io)).not.toBe(0);
    expect(cli.stderr().split('\n')[0]).toBe('Vibe Coding Maestro upgrade: обновление прервано, и откатить удалось не всё: проект изменён частично.');
    expect(cli.stderr()).not.toContain('изменений на диске нет');

    const other = await materializePublished(ID);
    const json = collectIo();
    expect(await executeUpgradeCommand({ path: other.root, json: true, apply: true, hooks: failing(other.root, true) }, json.io)).not.toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ ok: false, applied: false, rolledBack: false, partial: true });
  });

  it('откат удался и блокер — прежний текст; в --json partial: false', async () => {
    const { root } = await materializePublished(ID);
    const cli = collectIo();
    expect(await executeUpgradeCommand({ path: root, json: false, apply: true, hooks: failing(root, false) }, cli.io)).not.toBe(0);
    expect(cli.stderr().split('\n')[0]).toBe('Vibe Coding Maestro upgrade: обновление не выполнено (изменений на диске нет).');

    const other = await materializePublished(ID);
    const json = collectIo();
    expect(await executeUpgradeCommand({ path: other.root, json: true, apply: true, hooks: failing(other.root, false) }, json.io)).not.toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ ok: false, applied: false, rolledBack: true, partial: false });

    const blocked = await materializePublished(ID);
    await writeFile(join(blocked.root, 'protocols/plan.md'), 'подмена\n', 'utf8');
    const refused = collectIo();
    expect(await executeUpgradeCommand({ path: blocked.root, json: false, apply: true }, refused.io)).not.toBe(0);
    expect(refused.stderr().split('\n')[0]).toBe('Vibe Coding Maestro upgrade: обновление не выполнено (изменений на диске нет).');
  });
});

describe('0.4.5: договор текстов', () => {
  const template = (path: string): Promise<string> => readFile(join(process.cwd(), 'templates/project', path), 'utf8');
  /** Правила Maestro, которые агент читает: `protocols`, `.claude`, образцы, README и шаблон планов. */
  async function ruleFiles(): Promise<string[]> {
    const inDir = async (dir: string): Promise<string[]> => (await readdir(join(process.cwd(), 'templates/project', dir))).filter((name) => name.endsWith('.md')).map((name) => `${dir}/${name}`);
    return [
      ...await inDir('protocols'), '.claude/rules/maestro.md', ...await inDir('maestro/templates'),
      'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md', ...await inDir('.claude/commands'), ...await inDir('.claude/agents'),
    ];
  }

  it('бюджет: текст правил в сумме не растёт', async () => {
    const files = await ruleFiles();
    expect(files).toHaveLength(23);
    let total = 0;
    for (const path of files) total += countChars(await template(path));
    expect(total).toBeLessThanOrEqual(68_968);
  });

  it('одно правило об отчёте: в протоколе, образце отчёта и образце передачи', async () => {
    const audit = await template('protocols/audit.md');
    expect(audit).toContain('Проверяющий возвращает все находки. Автор пишет отчёт после круга');
    expect(audit).toContain('В отчёт — только critical, high и открытые');
    expect(audit).toContain('От закрытых medium и low остаются числа и коммиты исправлений');
    expect(audit).toContain('Записанное не вычищается; отчёт из Cowork импортируется целиком');
    expect(audit).toContain('Закрытая medium или low в отчёте (импорт из Cowork) — в `resolution` чем подтверждено');
    expect(audit).toContain('Аудит плана — та же строка в разделе «Утверждение» плана');
    expect(await template('maestro/templates/audit.md')).toContain('В отчёт — только critical, high и открытые');
    const line = 'Находки: critical N, high N, medium N, low N; открыто N.';
    expect(audit).toContain(line);
    const handoff = await template('maestro/templates/handoff.md');
    const checks = handoff.slice(handoff.indexOf('## Проверки'), handoff.indexOf('## Решения'));
    expect(checks).toContain(line);
    expect(handoff).not.toContain('находок нет');
    // Ревьюер и импорт из Cowork не меняются: проверяющий по-прежнему возвращает всё.
    expect(await template('.claude/agents/code-reviewer.md')).not.toContain('только critical');
    expect(await template('maestro/runbooks/cowork-audit.md')).not.toContain('только critical');
  });

  it('честность проверки: таблица в передаче и в завершении, «со слов»', async () => {
    const handoff = await template('maestro/templates/handoff.md');
    const checks = handoff.slice(handoff.indexOf('## Проверки'), handoff.indexOf('## Решения'));
    expect(checks).toContain('| Пункт | Чем проверено | Результат |');
    expect(checks).toContain('«со слов: кого»');
    const completion = await template('protocols/completion.md');
    expect(completion).toContain('таблицей `| Пункт | Чем проверено | Результат |`');
    expect(completion).toContain('никогда «прошло» без него');
    expect(completion).toContain('Статус в документах не сильнее таблицы шага 1');
  });

  it('«Что мешало в работе» — перед «Следующий шаг» и только в образце передачи', async () => {
    const handoff = await template('maestro/templates/handoff.md');
    expect(handoff.indexOf('## Что мешало в работе')).toBeGreaterThan(handoff.indexOf('## Риски и открытые вопросы'));
    expect(handoff.indexOf('## Что мешало в работе')).toBeLessThan(handoff.indexOf('## Следующий шаг'));
    for (const path of await ruleFiles()) {
      if (path !== 'maestro/templates/handoff.md') expect(await template(path), path).not.toContain('Что мешало');
    }
  });

  it('строка о проверках на сервере — только в build.md, с условием', async () => {
    const phrase = 'сколько проверок на сервере запускал и зачем';
    for (const path of await ruleFiles()) {
      if (path !== 'protocols/build.md') expect(await template(path), path).not.toContain(phrase);
    }
    expect(await template('protocols/build.md')).toContain(`есть копия в облаке — в итоге порции строка: ${phrase}`);
  });

  it('размер сессии проверяют и посреди порции', async () => {
    const rules = await template('.claude/rules/maestro.md');
    expect(rules).toContain('Посреди порции запускай `context` после коммита: ответ «пора в новую сессию» — передача дел сейчас.');
    expect(rules.split('\n').length).toBeLessThanOrEqual(45);
    expect(await template('protocols/handoff.md')).toContain('Сообщения `memory-…` — подсказка, что сократить или догнать');
  });

  it.each(['light', 'standard', 'advanced'] as const)('свежий проект %s: doctor --strict зелёный', async (depth) => {
    const root = join(await makeTempDir('fresh-045-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', depth, git: false, now: FIXED_NOW })).ok).toBe(true);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });
});

describe('0.4.5: переход в git с каждой опубликованной версии', () => {
  const ALL = [
    '0.3.0-beta.2-standard', '0.3.0-beta.3-light', '0.3.0-beta.3-standard', '0.3.0-beta.3-advanced', '0.3.0-beta.4-standard', '0.3.0-standard',
    '0.3.1-light', '0.3.1-standard', '0.3.1-advanced', '0.4.0-light', '0.4.0-standard', '0.4.0-advanced', '0.4.1-light', '0.4.1-standard', '0.4.1-advanced',
    '0.4.2-light', '0.4.2-standard', '0.4.2-advanced', '0.4.3-light', '0.4.3-standard', '0.4.3-advanced', '0.4.4-light', '0.4.4-standard', '0.4.4-advanced',
  ];
  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd });
  };

  it.each(ALL)('%s: --apply, коммит, doctor --strict зелёный', async (id) => {
    const { root } = await materializePublished(id);
    await git(root, 'init', '-q');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'до перехода');
    expect((await upgradeProject(root, { apply: true })).applied).toBe(true);
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'Maestro 0.4.5');
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(true);
    expect(report.findings.filter((item) => item.level !== 'info')).toEqual([]);
    expect(report.findings.filter((item) => item.code.startsWith('memory-'))).toEqual([]);
  });
});
