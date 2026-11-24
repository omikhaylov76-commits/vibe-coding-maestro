import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { GROWTH_MIN_STEPS, GROWTH_STEPS, growthPerStep, measureContext, projectLogDirName } from '../src/core/context.js';
import { parseAudit } from '../src/core/audits.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { sha256 } from '../src/core/manifest.js';
import { planBodyDigest } from '../src/core/plan.js';
import { buildPreflight } from '../src/core/preflight.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';
import { collectIo } from './published.js';

afterEach(cleanupTempDirs);
// Тесты не зависят от сессии Claude Code, в которой их запустили.
delete process.env.CLAUDE_CODE_SESSION_ID;

async function newProject(prefix = 'r046-'): Promise<string> {
  const root = join(await makeTempDir(prefix), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

describe('0.4.6: preflight блокирует только открытую правку границы', () => {
  const PLAN = 'wiki/plans/0002-work.md';

  /** Утверждённый объявленный мини-план; `specDelta: null` — поле не объявлено. */
  async function project(specDelta: string | null): Promise<string> {
    const root = await newProject();
    const plan = ['---', 'type: plan', 'title: Работа', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension',
      'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', 'sources: []', 'supersedes: null', 'approved_by: Человек',
      'approved_at: 2026-11-01', 'active_phase: null', 'blocking_questions: 0', ...(specDelta === null ? [] : [`spec_delta: ${specDelta}`]), 'current_slice: 01-vhod', '---', '', '# Работа', ''].join('\n');
    await writeFile(join(root, PLAN), plan.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${planBodyDigest(plan)}`), 'utf8');
    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-work.md'), 'utf8');
    return root;
  }

  it('resolved — разрешено, строка info советует вернуть none', async () => {
    const decision = await buildPreflight(await project('resolved'), { scale: 'quick' });
    expect([decision.ok, decision.route, decision.slice]).toEqual([true, 'build', '01-vhod']);
    const note = decision.findings.find((item) => item.code === 'preflight-spec-delta-resolved');
    expect(note).toMatchObject({ level: 'info', path: PLAN });
    expect(note?.message).toContain('none');
    expect(decision.findings.filter((item) => item.level === 'block')).toEqual([]);
  });

  it('open — блок, как раньше, и код выхода CLI не ноль', async () => {
    const root = await project('open');
    const decision = await buildPreflight(root, { scale: 'quick' });
    expect([decision.ok, decision.slice]).toEqual([false, null]);
    expect(decision.findings.map((item) => [item.level, item.code])).toEqual([['block', 'preflight-spec-delta']]);
    const cli = collectIo();
    expect(await runMaestroCli(['preflight', '--path', root], cli.io)).not.toBe(0);
    expect(cli.stderr()).toContain('preflight-spec-delta');
  });

  it('none — разрешено без лишних строк; поле не объявлено — блок, как раньше', async () => {
    const clean = await buildPreflight(await project('none'), { scale: 'quick' });
    expect(clean.ok).toBe(true);
    expect(clean.findings.map((item) => item.code)).toEqual(['preflight-slice-selected']);

    const undeclared = await buildPreflight(await project(null), { scale: 'quick' });
    expect(undeclared.ok).toBe(false);
    expect(undeclared.findings.map((item) => item.code)).toEqual(['preflight-gate-fields-missing']);
  });

  it('resolved рядом с настоящим блоком блок не снимает', async () => {
    const root = await project('resolved');
    await writeFile(join(root, PLAN), (await readUtf8(root, PLAN)).replace('blocking_questions: 0', 'blocking_questions: 2'), 'utf8');
    const decision = await buildPreflight(root, { scale: 'quick' });
    expect(decision.ok).toBe(false);
    expect(decision.findings.map((item) => item.code)).toEqual(['preflight-blocking-questions']);
  });
});

describe('0.4.6: source-hash-missing говорит, что делать', () => {
  it('код и уровень прежние; текст называет sources --write и maestro/inbox/', async () => {
    const root = await newProject();
    await mkdir(join(root, 'maestro/sources'), { recursive: true });
    await writeFile(join(root, 'maestro/sources/снимок.txt'), 'one', 'utf8');
    await writeFile(join(root, 'maestro/sources/материал.txt'), 'x\n', 'utf8');
    await writeFile(join(root, '.maestro/source-hashes.json'), JSON.stringify({ files: { 'maestro/sources/снимок.txt': sha256('one') } }), 'utf8');
    const found = (await doctorProject(root)).findings.filter((item) => item.code.startsWith('source-'));
    expect(found.map((item) => [item.level, item.code, item.path])).toEqual([['critical', 'source-hash-missing', 'maestro/sources/материал.txt']]);
    expect(found[0]?.message).toContain('vibe-maestro sources --write');
    expect(found[0]?.message).toContain('maestro/inbox/');
  });
});

describe('0.4.6: context говорит, сколько шагов до порога', () => {
  /** Проект с журналом: по одному ответу модели на каждое число из `sizes`. */
  async function session(model: string, sizes: readonly number[], repeat = 1): Promise<{ root: string; claudeDir: string }> {
    const claudeDir = await makeTempDir('claude-');
    const root = join(await makeTempDir('proj-'), 'app');
    await mkdir(root);
    const dir = join(claudeDir, 'projects', projectLogDirName(root));
    await mkdir(dir, { recursive: true });
    const lines = sizes.flatMap((tokens, index) => Array.from({ length: repeat }, () => JSON.stringify({
      type: 'assistant', sessionId: 's-1',
      message: { id: `m${index}`, model, usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 0 } },
    })));
    await writeFile(join(dir, 'session-1.jsonl'), `${lines.join('\n')}\n`);
    return { root, claudeDir };
  }
  /** `count` шагов, последний — размером `last`, каждый больше прошлого на `step`. */
  const growing = (last: number, step: number, count: number): number[] => Array.from({ length: count }, (_, index) => last - step * (count - 1 - index));

  async function cliText(where: { root: string; claudeDir: string }, ...extra: string[]): Promise<string> {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = where.claudeDir;
      const cli = collectIo();
      expect(await runMaestroCli(['context', '--path', where.root, ...extra], cli.io)).toBe(0);
      return cli.stdout();
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  }

  it('уровень «закончить порцию»: оценка шагов и совет проверить не позже половины', async () => {
    const where = await session('claude-opus-5-5', growing(450_000, 5_000, 40));
    const report = await measureContext(where);
    expect([report.level, report.growthPerStep, report.stepsToNewSession]).toEqual(['finish-slice', 5_000, 30]);
    const text = await cliText(where);
    expect(text).toContain('Порцию лучше закончить в этой сессии');
    expect(text).toContain('Сейчас сессия растёт примерно на 5 000 токенов за шаг: до порога 600 000 осталось примерно 30 шагов. Оценка грубая — проверьте размер снова не позже чем через 15 шагов.');
  });

  it('уровни «продолжать» и «пора в новую сессию» — строки и полей нет', async () => {
    for (const [last, level] of [[300_000, 'continue'], [650_000, 'new-session']] as const) {
      const where = await session('claude-opus-5-5', growing(last, 5_000, 40));
      const report = await measureContext(where);
      expect([report.level, report.growthPerStep, report.stepsToNewSession]).toEqual([level, undefined, undefined]);
      expect(await cliText(where)).not.toContain('за шаг');
    }
  });

  it('шагов мало для оценки или сессия не растёт — строки нет', async () => {
    const few = await session('claude-opus-5-5', growing(450_000, 5_000, GROWTH_MIN_STEPS));
    expect((await measureContext(few)).growthPerStep).toBeUndefined();
    expect(await cliText(few)).not.toContain('за шаг');
    const enough = await session('claude-opus-5-5', growing(450_000, 5_000, GROWTH_MIN_STEPS + 1));
    expect((await measureContext(enough)).growthPerStep).toBe(5_000);
    const flat = await session('claude-opus-5-5', Array.from({ length: 40 }, () => 450_000));
    expect((await measureContext(flat)).growthPerStep).toBeUndefined();
    expect(growthPerStep([])).toBeNull();
    expect(growthPerStep([450_000])).toBeNull();
  });

  it('рост — по последним шагам; после сжатия сессии — только по шагам после него', () => {
    // Ранний быстрый рост не считается: в расчёте последние GROWTH_STEPS шагов.
    const early = Array.from({ length: 20 }, (_, index) => 100_000 + index * 15_000);
    const late = Array.from({ length: GROWTH_STEPS + 1 }, (_, index) => 400_000 + index * 2_000);
    expect(growthPerStep([...early, ...late])).toBe(2_000);
    // Сжатие: размер упал больше чем вдвое, счёт начинается с шага после него.
    const before = Array.from({ length: 20 }, (_, index) => 500_000 + index * 9_000);
    const after = Array.from({ length: 12 }, (_, index) => 150_000 + index * 4_000);
    expect(growthPerStep([...before, ...after])).toBe(4_000);
    expect(growthPerStep([...before, ...after.slice(0, GROWTH_MIN_STEPS)])).toBeNull();
  });

  it('окно 200 000 — от его порога 140 000; один шаг до порога — свой текст', async () => {
    const small = await session('claude-haiku-4-5', growing(100_000, 2_000, 30));
    const report = await measureContext(small);
    expect([report.budget, report.level, report.newSessionTokens, report.growthPerStep, report.stepsToNewSession]).toEqual([200_000, 'finish-slice', 140_000, 2_000, 20]);
    expect(await cliText(small)).toContain('до порога 140 000 осталось примерно 20 шагов. Оценка грубая — проверьте размер снова не позже чем через 10 шагов.');

    const close = await session('claude-opus-5-5', growing(595_000, 4_000, 30));
    expect((await measureContext(close)).stepsToNewSession).toBe(1);
    expect(await cliText(close)).toContain('до порога 600 000 остался примерно один шаг. Проверьте размер сразу после него.');
    const three = await session('claude-opus-5-5', growing(588_000, 4_000, 30));
    expect(await cliText(three)).toContain('осталось примерно 3 шага. Оценка грубая — проверьте размер снова не позже чем через 1 шаг.');
  });

  it('ответ, записанный несколькими строками, — один шаг', async () => {
    const where = await session('claude-opus-5-5', growing(450_000, 5_000, 40), 3);
    const report = await measureContext(where);
    expect([report.requests, report.growthPerStep, report.stepsToNewSession]).toEqual([40, 5_000, 30]);
  });

  it('--json: два новых поля, прежние не меняются', async () => {
    const where = await session('claude-opus-5-5', growing(450_000, 5_000, 40));
    const report = JSON.parse(await cliText(where, '--json')) as Record<string, unknown>;
    expect(report).toMatchObject({
      reportVersion: 1, ok: true, sessionId: 's-1', contextTokens: 450_000, budget: 1_000_000, model: 'claude-opus-5-5', windowSource: 'model', percent: 45,
      level: 'finish-slice', finishSliceTokens: 400_000, newSessionTokens: 600_000, requests: 40, growthPerStep: 5_000, stepsToNewSession: 30,
    });
    expect(Object.keys(report).sort()).toEqual([
      'budget', 'contextTokens', 'finishSliceTokens', 'growthPerStep', 'level', 'model', 'newSessionTokens', 'ok', 'percent', 'reportVersion', 'requests',
      'sessionId', 'stepsToNewSession', 'totalInputTokens', 'transcript', 'windowSource',
    ]);
    const calm = JSON.parse(await cliText(await session('claude-opus-5-5', growing(300_000, 5_000, 40)), '--json')) as Record<string, unknown>;
    expect(Object.keys(calm)).not.toContain('growthPerStep');
    expect(Object.keys(calm)).not.toContain('stepsToNewSession');
  });
});

describe('0.4.6: договор текстов', () => {
  const template = async (path: string): Promise<string> => (await readFile(join(process.cwd(), 'templates/project', path), 'utf8')).replace(/\r\n/g, '\n');
  /** Раздел протокола от заголовка до следующего заголовка или якоря. */
  const section = (text: string, heading: string): string => {
    const from = text.indexOf(heading);
    expect(from, heading).toBeGreaterThan(-1);
    const next = text.slice(from + heading.length).search(/\n(?:## |<a id=)/);
    return next === -1 ? text.slice(from) : text.slice(from, from + heading.length + next);
  };

  it('лёгкое чтение на старте: капсула и план по частям, капсула старого вида — начало и последние по дате записи', async () => {
    const build = await template('protocols/build.md');
    const pipeline = section(build, '## Deterministic context pipeline');
    expect(pipeline).toContain('На старте читай по частям: из капсулы — цель с критериями, открытое и «где остановились», без хода работы и черновиков');
    // Живой прогон на копии рабочего проекта: свежие записи старой капсулы бывают в середине файла, а не в конце.
    expect(pipeline).toContain('капсула старого вида — начало и последние по дате записи');
    expect(pipeline).toContain('из плана — шапку, «Как проверим», «Где правим», строку порции и её правку');
    // Порядок чтения и чтение открытых отчётов прежние; проверки на старте сессии не тронуты.
    expect(pipeline).toContain('`wiki/hot.md` → capsule → active spec/plan → открытые audits → только нужные source-фрагменты');
    expect(build).toContain('Каждая сессия начинается одинаково: `wiki/hot.md` → `git log --oneline -10` и `git status` → прогон проверок проекта (тесты и `doctor`) до новой работы.');
  });

  it('капсула — карточка: правило в build.md и четыре раздела образца покрывают прежние восемь пунктов', async () => {
    const capsule = section(await template('protocols/build.md'), '## Task Context Capsule');
    expect(capsule).toContain('Ход работы в капсулу не пиши — он в передачах; черновик правки плана после переноса в план замени ссылкой.');
    const sample = await template('maestro/templates/progress.md');
    expect(sample).toMatch(/^---\ntype: progress\nstatus: active\nplan: none\nupdated: YYYY-MM-DD\n---\n/);
    expect([...sample.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual(['Цель и готово', 'Границы', 'Открыто', 'Где остановились']);
    expect(sample).toContain('критерии — списком из плана, меняет его только правка плана');
    expect(sample).toContain('карточка, а не журнал');
    expect(sample).toContain('active_progress: progress/слаг.md');
  });

  it('сверка с целью: счёт по доказательству, две передачи без роста, побочное дело, закрытие порции', async () => {
    const build = await template('protocols/build.md');
    const goal = section(build, '## Сверка с целью');
    expect(build.indexOf('## Сверка с целью')).toBeGreaterThan(build.indexOf('## Quality gate'));
    for (const phrase of [
      'нумерованный список в капсуле, при её старте — из плана: её пункты в «Как проверим» и «Где правим» и стоп-гейт; у `QUICK` — пункт «проверка» мини-плана',
      'Список меняет только правка плана.',
      'Передача посреди порции — счёт: доказано N из M; в прошлой передаче K.',
      'Доказано — вывод команды, тест или то, что видно; не ощущение.',
      'Две передачи порции подряд без роста счёта — ты топчешься: тот же подход и те же проверки не повторяй',
      'смени подход и скажи человеку одной строкой',
      'нужно для цели — доделай; нет — доведи до целого или откати и запиши в `wiki/icebox.md` с состоянием',
      'Новое не начинай, пока начатое не доведено.',
      'Порция закрыта, только когда критерии выполнены и ревью, где оно положено, пройдено.',
      '«Да» человека выполненных критериев не заменяет.',
    ]) expect(goal, phrase).toContain(phrase);
    // Вопроса человеку сверка не добавляет.
    expect(goal).not.toContain('?');
    expect(goal).not.toMatch(/спроси/i);
  });

  it('образец передачи: «Решил сам» в итоге, счёт цели в состоянии; разделы и их порядок прежние', async () => {
    const handoff = await template('maestro/templates/handoff.md');
    expect([...handoff.matchAll(/^## (.+)$/gm)].map((match) => match[1])).toEqual(['Итог для человека', 'Состояние', 'Проверки', 'Решения', 'Риски и открытые вопросы', 'Что мешало в работе', 'Следующий шаг']);
    const summary = handoff.slice(handoff.indexOf('## Итог для человека'), handoff.indexOf('## Состояние'));
    expect(summary).toContain('- Решил сам: до трёх решений, которые человек заметит, или «нет». Отступление от утверждённого — правка плана, вопрос до неё.');
    const state = handoff.slice(handoff.indexOf('## Состояние'), handoff.indexOf('## Проверки'));
    expect(state).toContain('- Посреди порции — счёт по «Сверке с целью» (`build.md`): `Цель: доказано N из M; в прошлой передаче K.` Первая — без K.');
    expect(handoff).toContain('Находки: critical N, high N, medium N, low N; открыто N.');
    expect(await template('.claude/rules/maestro.md')).toContain('что сделано, что проверено, что решил сам, что осталось и почему');
  });

  it('передача: открытое не теряется, короткая запись журнала, перенос из капсулы до архива', async () => {
    const handoff = await template('protocols/handoff.md');
    const step = (number: number): string => handoff.slice(handoff.indexOf(`\n${number}. `), handoff.indexOf(`\n${number + 1}. `));
    for (const phrase of [
      'В раздел «Открытые вопросы» — что ждёт человека и видимые дефекты; находку — с её ID.',
      'Незакрытую строку не удаляй, даже чужую; `hot.md` длинен — выноси справочное.',
      'В `wiki/icebox.md` — только «на потом»: на старте его не читают.',
      'Капсула старого вида — поставь наверх критерии из плана, «Открыто» и «Где остановились».',
    ]) expect(step(3), phrase).toContain(phrase);
    expect(step(4)).toContain('Добавь одну запись в конец `wiki/log.md`: что сделано — одной строкой и ссылка на передачу.');
    const five = step(5);
    expect(five).toContain('открытое из капсулы перенеси в `wiki/hot.md`, «на потом» человека — в `wiki/icebox.md`; сменился этап — поправь `wiki/roadmap.md`');
    expect(five.indexOf('открытое из капсулы перенеси')).toBeLessThan(five.indexOf('--apply'));
    expect(five).toContain('Правки плана называешь ты, `--section`: только те, все порции которых закрыты.');
    expect(step(6)).toContain('Запусти `doctor` и покажи вывод; в передачу — только новое в нём.');
    expect(handoff).toContain('открытые находки и то, что решили не исправлять, — одной фразой его словами');
    // Образец журнала нового проекта говорит то же, что шаг 4.
    const log = await template('wiki/log.md');
    expect(log).toContain('- **Что сделано** — факт, а не намерение, одной строкой.');
    expect(log).toContain('- **Ссылка на передачу** — «почему» и «что дальше» записаны в ней.');
    // Названия разделов wiki/hot.md, которые читает хаб, прежние.
    const hot = await template('wiki/hot.md');
    for (const heading of ['## Сейчас в работе', '## Открытые вопросы', '## Следующий шаг']) expect(hot).toContain(heading);
  });

  it('«не исправляем» закрывается во всех местах сразу и не пропадает из слов человеку', async () => {
    const audit = await template('protocols/audit.md');
    expect(audit).toContain('В отчёт — только critical, high и открытые, а также «не исправляем».');
    expect(audit).toContain('Medium и low, которые решили не исправлять, закрываются: `status: resolved` с `resolution: не исправляем — причина; где записано`. Строка в следующей порции или в `wiki/icebox.md` обязательна.');
    expect(audit).toContain('Открытые находки и то, что решили не исправлять, попадают в передачу порции (раздел «Риски и открытые вопросы») и в итог [завершения](completion.md) («что осталось»).');
    expect(audit).not.toContain('остаются `status: open`');
    expect(await template('maestro/runbooks/cowork-audit.md')).toContain('Medium/low, которые решили не исправлять, закрываются: `resolved` с `resolution: не исправляем — причина; где записано`.');
    expect(await template('maestro/runbooks/cowork-audit.md')).not.toContain('остаются `open`');
    const handoff = await template('maestro/templates/handoff.md');
    expect(handoff.slice(handoff.indexOf('## Риски и открытые вопросы'), handoff.indexOf('## Что мешало в работе'))).toContain('Открытые находки проверок и то, что решили не исправлять: почему и где записано');
    expect(await template('protocols/completion.md')).toContain('что осталось открытым — открытые отчёты (`wiki/audits/`) и находки проверок «не исправляем» (`wiki/icebox.md` или следующая порция)');
    expect(await template('wiki/icebox.md')).toContain('находки проверок, которые решили не исправлять');

    // Образец отчёта: «не исправляем» закрыта, шапка open — из-за непроверенного исправления; закроют его — отчёт можно закрыть целиком.
    const sample = await template('maestro/templates/audit.md');
    expect(sample).toMatch(/^---\naudit_id: AUD-YYYY-MM-DD-slug\nstatus: open\n---\n/);
    expect(parseAudit(sample)).toEqual({ malformed: false, closed: false, blocking: [] });
    const closed = sample.replace('status: open\n---', 'status: resolved\n---').replace('- status: open\n- resolution: исправлено в <коммит>, не проверено', '- status: resolved\n- resolution: исправлено в <коммит>; проверка исправления: тест');
    expect(parseAudit(closed)).toEqual({ malformed: false, closed: true, blocking: [] });
  });

  it('пороги сессии и правило посреди порции не менялись; совет о новой сессии — в правилах, протоколы ссылаются', async () => {
    const rules = await template('.claude/rules/maestro.md');
    expect(rules).toContain('Посреди порции запускай `context` после коммита: ответ «пора в новую сессию» — передача дел сейчас.');
    expect(rules.split('\n').length).toBeLessThanOrEqual(45);
    const { FINISH_SLICE_TOKENS, NEW_SESSION_TOKENS } = await import('../src/core/context.js');
    expect([FINISH_SLICE_TOKENS, NEW_SESSION_TOKENS]).toEqual([400_000, 600_000]);
    for (const path of ['protocols/build.md', 'protocols/handoff.md', 'protocols/plan.md']) {
      expect(await template(path), path).toMatch(/[Пп]ора ли в новую сессию — по выводу `context` \(`\.claude\/rules\/maestro\.md`\)\./);
    }
  });

  it('новых файлов Maestro и удалений нет: состав шаблона тот же, что в 0.4.5', async () => {
    const { canonicalOwnershipInventory } = await import('../src/core/inventory.js');
    const { publishedFixture } = await import('./published.js');
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      const before = JSON.parse((await publishedFixture(`0.4.5-${depth}`)).files['.maestro/manifest.json'] as string) as { inventory: { path: string; ownership: string }[] };
      expect(canonicalOwnershipInventory(depth), depth).toEqual(Object.fromEntries(before.inventory.map((item) => [item.path, item.ownership])));
    }
  });
});
