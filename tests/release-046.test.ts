import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { GROWTH_MIN_STEPS, GROWTH_STEPS, growthPerStep, measureContext, projectLogDirName } from '../src/core/context.js';
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
