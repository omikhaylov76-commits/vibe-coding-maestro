import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import type { InteractiveAnswers, PromptAdapter } from '../src/cli/prompt.js';
import { cleanupTempDirs, makeTempDir } from './helpers.js';

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

function adapter(answers: InteractiveAnswers): PromptAdapter {
  return { ask: vi.fn().mockResolvedValue(answers) };
}

afterEach(cleanupTempDirs);

describe('этап 7: интерактивный create-vibe-maestro', () => {
  it('в TTY получает максимум три ответа через внедрённый adapter и создаёт проект', async () => {
    const target = `${await makeTempDir()}/new-project`;
    const prompt = adapter({ action: 'create', target, name: 'Новый проект', startingPoint: 'materials', usedDesktopDefault: false });
    const c = collect();

    const code = await runCreateCli([], c.io, { isTty: true, prompt });

    expect(code).toBe(0);
    expect(prompt.ask).toHaveBeenCalledTimes(1);
    expect(c.stdout()).toContain('Проект подготовлен');
  });

  it('подключает непустой существующий проект, не заставляя UI проникать в init core', async () => {
    const target = await makeTempDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${target}/app.ts`, 'export {};\n');
    const prompt = adapter({ action: 'connect', target, name: 'Existing', startingPoint: 'code', usedDesktopDefault: false });
    const c = collect();

    const code = await runCreateCli([], c.io, { isTty: true, prompt });

    expect(code).toBe(0);
  });

  it('действие check запускает doctor, но не изменяет проект', async () => {
    const target = await makeTempDir();
    const prompt = adapter({ action: 'check', target });
    const c = collect();

    const code = await runCreateCli([], c.io, { isTty: true, prompt });

    expect(code).toBe(1);
    expect(c.stderr()).toContain('найдено проблем');
  });

  it('в non-TTY без --yes немедленно ошибается и советует --yes, даже если target передан', async () => {
    const prompt = adapter({ action: 'create', target: '/never', name: 'never', startingPoint: 'idea', usedDesktopDefault: false });
    const c = collect();

    const code = await runCreateCli(['--target', '/already-supplied'], c.io, { isTty: false, prompt });

    expect(code).toBe(2);
    expect(c.stderr()).toContain('--yes');
    expect(prompt.ask).not.toHaveBeenCalled();
  });

  it('--yes сохраняет неинтерактивный режим и не вызывает prompt', async () => {
    const target = `${await makeTempDir()}/yes-project`;
    const prompt = adapter({ action: 'create', target: '/never', name: 'never', startingPoint: 'idea', usedDesktopDefault: false });
    const c = collect();

    const code = await runCreateCli(['--yes', '--target', target, '--no-git'], c.io, { isTty: true, prompt });

    expect(code).toBe(0);
    expect(prompt.ask).not.toHaveBeenCalled();
  });
});
