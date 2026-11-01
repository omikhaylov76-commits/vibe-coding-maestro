import { describe, expect, it } from 'vitest';
import { diffLines, diffText, formatHunk, splitLines } from '../src/core/text-diff.js';
import type { DiffHunk } from '../src/core/text-diff.js';

/** Применяет куски к прежнему тексту: показ правок обязан давать ровно новый текст. */
function applyHunks(before: string, hunks: readonly DiffHunk[]): string[] {
  const source = splitLines(before);
  const out: string[] = [];
  let next = 0; // индекс следующей непрочитанной строки прежнего текста
  for (const hunk of hunks) {
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1;
    out.push(...source.slice(next, start));
    next = start;
    for (const line of hunk.lines) {
      if (line.kind === 'add') { out.push(line.text); continue; }
      expect(source[next], 'строка куска совпадает с прежним текстом').toBe(line.text);
      if (line.kind === 'same') out.push(line.text);
      next += 1;
    }
  }
  out.push(...source.slice(next));
  return out;
}

/** Детерминированный генератор: тест повторяется на любой машине одинаково. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('построчное сравнение', () => {
  it('одинаковые тексты: правок нет', () => {
    expect(diffText('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0, hunks: [] });
    expect(diffText('a\r\nb\r\n', 'a\nb\n').hunks, 'CRLF и LF — одно и то же').toEqual([]);
  });

  it('замена строки — убранная и добавленная, с общими строками вокруг', () => {
    const diff = diffText('1\n2\n3\n4\n5\n', '1\n2\nтри\n4\n5\n', 1);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks.map(formatHunk)).toEqual([['@@ -2,3 +2,3 @@', ' 2', '-3', '+три', ' 4']]);
  });

  it('новый файл — один кусок от нулевой строки, удалённый — наоборот', () => {
    expect(diffText('', 'a\nb\n').hunks.map(formatHunk)).toEqual([['@@ -0,0 +1,2 @@', '+a', '+b']]);
    expect(diffText('a\nb\n', '').hunks.map(formatHunk)).toEqual([['@@ -1,2 +0,0 @@', '-a', '-b']]);
  });

  it('далёкие правки — отдельные куски, близкие — один', () => {
    const before = Array.from({ length: 30 }, (_, i) => `строка ${i + 1}`).join('\n');
    const far = before.replace('строка 2\n', 'вторая\n').replace('строка 28\n', 'двадцать восьмая\n');
    expect(diffText(before, far).hunks).toHaveLength(2);
    const near = before.replace('строка 2\n', 'вторая\n').replace('строка 6\n', 'шестая\n');
    expect(diffText(before, near).hunks).toHaveLength(1);
  });

  it('на случайных текстах: обе стороны восстанавливаются, куски дают новый текст', () => {
    const next = random(7);
    const words = ['альфа', 'бета', 'гамма', 'дельта', ''];
    for (let round = 0; round < 200; round += 1) {
      const make = (): string[] => Array.from({ length: Math.floor(next() * 25) }, () => words[Math.floor(next() * words.length)] as string);
      const before = make();
      const after = make();
      const lines = diffLines(before, after);
      expect(lines.filter((line) => line.kind !== 'add').map((line) => line.text)).toEqual(before);
      expect(lines.filter((line) => line.kind !== 'remove').map((line) => line.text)).toEqual(after);
      const text = (list: string[]): string => list.map((line) => `${line}\n`).join('');
      const diff = diffText(text(before), text(after), Math.floor(next() * 4));
      expect(applyHunks(text(before), diff.hunks)).toEqual(after);
    }
  });

  it('общая часть находится наибольшей: лишних «убрать — добавить» нет', () => {
    const lines = diffLines(['a', 'b', 'c', 'd'], ['b', 'c', 'x', 'd']);
    expect(lines.filter((line) => line.kind === 'same').map((line) => line.text)).toEqual(['b', 'c', 'd']);
  });

  it('огромная середина показывается заменой целиком и всё равно точна', () => {
    const before = Array.from({ length: 2100 }, (_, i) => `старая ${i}`);
    const after = Array.from({ length: 2100 }, (_, i) => `новая ${i}`);
    const lines = diffLines(before, after);
    expect(lines.filter((line) => line.kind === 'remove')).toHaveLength(2100);
    expect(lines.filter((line) => line.kind === 'add')).toHaveLength(2100);
  });
});
