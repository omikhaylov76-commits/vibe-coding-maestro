import { describe, expect, it } from 'vitest';
import { createRenderer, type RendererOptions } from '../src/cli/renderer.js';

function render(options: Partial<RendererOptions> = {}) {
  const chunks: string[] = [];
  const renderer = createRenderer((text) => chunks.push(text), {
    isTty: true, columns: 80, env: {}, unicode: true, ...options,
  });
  return { renderer, text: () => chunks.join('') };
}

const ansi = /\x1b\[[0-9;]*m/g;

function visibleWidth(text: string): number {
  return [...text.replace(ansi, '')].reduce((width, char) => width + (/\p{Extended_Pictographic}/u.test(char) ? 2 : 1), 0);
}

describe('Guided First Run renderer', () => {
  it('рисует просторную рамку шириной 88 колонок с ровным правым краем', () => {
    const r = render({ columns: 100, env: { NO_COLOR: '1' } });
    r.renderer.welcome();
    const framed = r.text().split('\n').filter((line) => /^[╭│╰]/u.test(line));
    expect(framed.length).toBeGreaterThan(3);
    expect(framed.every((line) => visibleWidth(line) === 88)).toBe(true);
    for (const line of framed.filter((value) => value.startsWith('│') && value.trim() !== '││')) {
      expect(line.match(/\s+│$/u)?.[0].length ?? 0).toBeGreaterThanOrEqual(5);
    }
  });

  it('считает emoji по видимой ширине и сохраняет ровную рамку', () => {
    const r = render({ columns: 100, env: { NO_COLOR: '1' } });
    r.renderer.warning('готово 🚀');
    r.renderer.success({ action: 'check', target: '/tmp/Проект-🚀', doctorOk: true });
    const framed = r.text().split('\n').filter((line) => /^[╭│╰]/u.test(line));
    expect(framed.every((line) => visibleWidth(line) === 88)).toBe(true);
  });

  it('welcome одним экраном объясняет назначение, три шага, Desktop и управление', () => {
    const r = render();
    r.renderer.welcome();
    const text = r.text();
    for (const phrase of ['VIBE CODING MAESTRO', 'проект', 'Рабочем столе', '↑/↓', 'Enter', 'трёх']) expect(text).toContain(phrase);
  });

  it('цвет включён только в TTY без NO_COLOR', () => {
    const colored = render(); colored.renderer.welcome();
    expect(colored.text()).toMatch(ansi);
    const nonTty = render({ isTty: false }); nonTty.renderer.welcome();
    expect(nonTty.text()).not.toMatch(ansi);
  });

  it.each([{ NO_COLOR: '1' }, { NO_COLOR: '' }])('NO_COLOR=$NO_COLOR полностью убирает ANSI', (env) => {
    const r = render({ env });
    r.renderer.welcome();
    r.renderer.preview({ action: 'create', name: 'Demo', target: '/tmp/Demo', usedDesktopDefault: false });
    r.renderer.success({ action: 'create', name: 'Demo', target: '/tmp/Demo', doctorOk: true });
    expect(r.text()).not.toMatch(ansi);
    expect(r.text()).toContain('OK');
  });

  it('на узком терминале не рисует рамку и скрывает второстепенный текст', () => {
    const r = render({ columns: 40 });
    r.renderer.welcome();
    expect(r.text()).not.toMatch(/[╭╮╰╯│─]/);
    expect(r.text()).toContain('VIBE CODING MAESTRO');
    for (const line of r.text().split('\n')) expect(line.replace(ansi, '').length).toBeLessThanOrEqual(40);
  });

  it('success выделяет полный путь и следующие действия, не полагаясь только на цвет', () => {
    const target = '/Users/DaddyCool/Desktop/Новый проект Маестро';
    const r = render({ env: { NO_COLOR: '1' } });
    r.renderer.success({ action: 'create', name: 'Новый проект Маестро', target, doctorOk: true });
    const text = r.text();
    expect(text).toContain('OK');
    expect(text).toContain('ПРОЕКТ ГОТОВ');
    expect(text).toContain(target);
    expect(text).toContain('wiki/hot.md');
    expect(text).toContain('maestro/inbox');
    expect(text).toContain('cowork-discovery.md');
  });

  it('preview сообщает Desktop-default до записи, а failure не выглядит успехом', () => {
    const r = render({ env: { NO_COLOR: '1' } });
    r.renderer.preview({ action: 'create', name: 'Demo', target: '/Users/me/Desktop/Demo', usedDesktopDefault: true });
    r.renderer.failure('Doctor нашёл проблему.');
    const text = r.text();
    expect(text).toContain('Рабочем столе');
    expect(text).toContain('/Users/me/Desktop/Demo');
    expect(text).toContain('X');
    expect(text).not.toContain('ПРОЕКТ ГОТОВ');
  });
});
