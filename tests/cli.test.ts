import { describe, expect, it } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import { runMaestroCli } from '../src/cli/maestro.js';
import { PRODUCT_NAME, VERSION } from '../src/core/meta.js';

/**
 * Этап 1: CLI-каркас.
 * Ядро CLI тестируется как функция, а не через процесс: аргументы + writer на вход,
 * exit code на выход. Терминал не требуется.
 */
function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

describe('create-vibe-maestro CLI', () => {
  it('печатает версию по --version и завершается с кодом 0', async () => {
    const c = collect();
    const code = await runCreateCli(['--version'], c.io);
    expect(code).toBe(0);
    expect(c.stdout().trim()).toBe(VERSION);
  });

  it('печатает справку по --help с кодом 0 и упоминает имя продукта', async () => {
    const c = collect();
    const code = await runCreateCli(['--help'], c.io);
    expect(code).toBe(0);
    expect(c.stdout()).toContain(PRODUCT_NAME);
    expect(c.stdout()).toContain('--target');
    expect(c.stdout()).toContain('--force');
  });

  it('на неизвестный флаг возвращает код 2 и пишет ошибку в stderr', async () => {
    const c = collect();
    const code = await runCreateCli(['--нетакогофлага'], c.io);
    expect(code).toBe(2);
    expect(c.stderr()).toContain('--нетакогофлага');
    expect(c.stdout()).toBe('');
  });

  it('требует --target в неинтерактивном режиме', async () => {
    const c = collect();
    const code = await runCreateCli(['--yes'], c.io);
    expect(code).toBe(2);
    expect(c.stderr()).toContain('--target');
  });
});

describe('vibe-maestro CLI', () => {
  it('печатает версию по --version', async () => {
    const c = collect();
    const code = await runMaestroCli(['--version'], c.io);
    expect(code).toBe(0);
    expect(c.stdout().trim()).toBe(VERSION);
  });

  it('печатает справку и перечисляет команду doctor', async () => {
    const c = collect();
    const code = await runMaestroCli(['--help'], c.io);
    expect(code).toBe(0);
    expect(c.stdout()).toContain('doctor');
  });

  it('на неизвестную команду возвращает код 2', async () => {
    const c = collect();
    const code = await runMaestroCli(['залечи'], c.io);
    expect(code).toBe(2);
    expect(c.stderr()).toContain('залечи');
  });

  it('без команды показывает справку и возвращает код 2', async () => {
    const c = collect();
    const code = await runMaestroCli([], c.io);
    expect(code).toBe(2);
    expect(c.stderr()).not.toBe('');
  });
});
