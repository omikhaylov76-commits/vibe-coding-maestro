import { describe, expect, it } from 'vitest';
import { renderTemplate, splitFrontmatter } from '../src/core/template.js';

const VARS = { projectName: 'Мой Проект', date: '2026-08-02', startingPoint: 'idea' as const };

/**
 * Дефект прототипа: глобальная замена ГГГГ-ММ-ДД портила документированный формат журнала.
 * Правило: человекочитаемый плейсхолдер даты подставляется ТОЛЬКО во frontmatter.
 */
describe('splitFrontmatter', () => {
  it('разделяет frontmatter и тело', () => {
    const parsed = splitFrontmatter('---\ndate: ГГГГ-ММ-ДД\n---\nтело\n');
    expect(parsed.frontmatter).toBe('date: ГГГГ-ММ-ДД');
    expect(parsed.body).toBe('тело\n');
    expect(parsed.hasFrontmatter).toBe(true);
  });

  it('возвращает hasFrontmatter=false, если файл начинается не с ---', () => {
    const parsed = splitFrontmatter('# Заголовок\n---\nне frontmatter\n');
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe('# Заголовок\n---\nне frontmatter\n');
  });
});

describe('renderTemplate', () => {
  it('подставляет дату во frontmatter', () => {
    const out = renderTemplate('---\ndate: ГГГГ-ММ-ДД\nupdated: ГГГГ-ММ-ДД\n---\n\nтекст\n', VARS);
    expect(out).toContain('date: 2026-08-02');
    expect(out).toContain('updated: 2026-08-02');
  });

  it('НЕ подставляет дату в теле документа: документированный формат сохраняется', () => {
    const source = '---\ndate: ГГГГ-ММ-ДД\n---\n\n## ГГГГ-ММ-ДД — что сделано\n\nФормат записи: `ГГГГ-ММ-ДД`.\n';
    const out = renderTemplate(source, VARS);
    expect(out).toContain('date: 2026-08-02');
    expect(out).toContain('## ГГГГ-ММ-ДД — что сделано');
    expect(out).toContain('Формат записи: `ГГГГ-ММ-ДД`.');
    expect(out.match(/2026-08-02/g)).toHaveLength(1);
  });

  it('не трогает дату вообще, если frontmatter отсутствует', () => {
    const out = renderTemplate('Формат: ГГГГ-ММ-ДД\n', VARS);
    expect(out).toBe('Формат: ГГГГ-ММ-ДД\n');
  });

  it('подставляет {{PROJECT_NAME}} и в frontmatter, и в теле', () => {
    const out = renderTemplate('---\nproject: {{PROJECT_NAME}}\n---\n\n# {{PROJECT_NAME}}\n', VARS);
    expect(out).toBe('---\nproject: Мой Проект\n---\n\n# Мой Проект\n');
  });

  it('подставляет явный {{DATE}} где угодно', () => {
    const out = renderTemplate('# {{DATE}}\n', VARS);
    expect(out).toBe('# 2026-08-02\n');
  });

  it('сохраняет кириллицу и emoji без искажений', () => {
    const source = '---\ndate: ГГГГ-ММ-ДД\n---\n\nПривет, мир — тире, «кавычки», 🎯\n';
    const out = renderTemplate(source, VARS);
    expect(out).toContain('Привет, мир — тире, «кавычки», 🎯');
  });

  it('падает с понятной ошибкой на неизвестном плейсхолдере (защита от битых шаблонов)', () => {
    expect(() => renderTemplate('{{НЕИЗВЕСТНО}}\n', VARS)).toThrowError(/НЕИЗВЕСТНО/);
  });
});
