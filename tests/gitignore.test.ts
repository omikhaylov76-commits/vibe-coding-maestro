import { describe, expect, it } from 'vitest';
import { mergeGitignore, REQUIRED_GITIGNORE_ENTRIES } from '../src/core/gitignore.js';

/**
 * Дефект прототипа, который нельзя переносить:
 * .gitignore сравнивался подстрокой и мог «увидеть» node_modules там, где записи нет.
 * Слияние обязано быть построчным.
 */
describe('mergeGitignore', () => {
  it('создаёт файл со всеми обязательными записями, если .gitignore отсутствует', () => {
    const result = mergeGitignore(null, REQUIRED_GITIGNORE_ENTRIES);
    expect(result.created).toBe(true);
    expect(result.changed).toBe(true);
    const lines = result.content.split('\n');
    for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
      expect(lines).toContain(entry);
    }
    expect(result.content.endsWith('\n')).toBe(true);
  });

  it('сохраняет существующие строки байт-в-байт и только дописывает отсутствующие', () => {
    const existing = ['# мои правила', 'node_modules/', 'dist/', '', 'coverage/'].join('\n') + '\n';
    const result = mergeGitignore(existing, ['node_modules/', 'dist/', '.env']);

    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.addedEntries).toEqual(['.env']);
    expect(result.changed).toBe(true);
  });

  it('не считает node_modules присутствующим, если это лишь часть комментария (защита от подстрочного сравнения)', () => {
    const existing = '# node_modules и dist игнорируются где-то ещё\n';
    const result = mergeGitignore(existing, ['node_modules/', 'dist/']);

    expect(result.addedEntries).toEqual(['node_modules/', 'dist/']);
    expect(result.content.startsWith(existing)).toBe(true);
  });

  it('считает node_modules и node_modules/ одной и той же записью', () => {
    const result = mergeGitignore('node_modules\n', ['node_modules/']);
    expect(result.addedEntries).toEqual([]);
    expect(result.changed).toBe(false);
    expect(result.content).toBe('node_modules\n');
  });

  it('идемпотентен: повторное слияние ничего не меняет', () => {
    const first = mergeGitignore(null, REQUIRED_GITIGNORE_ENTRIES);
    const second = mergeGitignore(first.content, REQUIRED_GITIGNORE_ENTRIES);
    expect(second.changed).toBe(false);
    expect(second.addedEntries).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  it('корректно дописывает в файл без завершающего перевода строки', () => {
    const result = mergeGitignore('dist/', ['dist/', '.env']);
    expect(result.content.split('\n')).toContain('.env');
    expect(result.content.startsWith('dist/\n')).toBe(true);
    expect(result.content).not.toContain('dist/.env');
  });

  it('сохраняет стиль переводов строки CRLF', () => {
    const existing = 'dist/\r\nnode_modules/\r\n';
    const result = mergeGitignore(existing, ['dist/', 'node_modules/', '.env']);
    expect(result.content.startsWith(existing)).toBe(true);
    expect(result.content).toContain('.env\r\n');
    expect(result.content.includes('.env\n\r')).toBe(false);
  });

  it('игнорирует различия в отступах при поиске существующей записи', () => {
    const result = mergeGitignore('  dist/  \n', ['dist/']);
    expect(result.addedEntries).toEqual([]);
    expect(result.changed).toBe(false);
  });

  it('обязательный список включает .env и не даёт секретам попасть в Git', () => {
    expect(REQUIRED_GITIGNORE_ENTRIES).toContain('.env');
    expect(REQUIRED_GITIGNORE_ENTRIES).toContain('node_modules/');
  });

  it('помечает добавленный блок понятным заголовком', () => {
    const result = mergeGitignore('dist/\n', ['.env']);
    expect(result.content).toContain('Vibe Coding Maestro');
  });
});
