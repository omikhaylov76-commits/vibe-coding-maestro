import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { levelFor, measureContext, projectLogDirName, thresholdsFor } from '../src/core/context.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';
import { collectIo } from './published.js';

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
