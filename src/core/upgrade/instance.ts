import { normalizeEol } from '../manifest.js';
import type { StartingPoint } from '../meta.js';
import { renderTemplate } from '../template.js';
import type { TemplateVars } from '../template.js';

/**
 * Доказательство того, что файл на диске — это буквально прошлый канонический
 * шаблон, а не похожий на него текст.
 *
 * Прямое сравнение контрольных сумм здесь невозможно: шаблон рендерится с
 * подстановками (имя проекта, дата), поэтому у одного и того же canonical файла
 * нет одной канонической суммы. Вместо ослабления проверки восстанавливаем
 * подстановки и требуем побайтового совпадения повторного рендера. Совпадение
 * доказывает preimage; несовпадение означает «файл изменён» и блокирует запись.
 *
 * Восстановление не может дать ложного «да»: любое найденное решение проверяется
 * повторным рендером. Неоднозначный случай даёт null, то есть отказ.
 */

/** Сентинелы содержат NUL: этот символ не может встретиться в тексте шаблона. */
const PROJECT_NAME_SENTINEL = '\u0000{PROJECT_NAME}\u0000';
const DATE_SENTINEL = '\u0000{DATE}\u0000';
const VERSION_SENTINEL = '\u0000{MAESTRO_VERSION}\u0000';

export interface RecoveredVars {
  projectName?: string;
  date?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Восстанавливает подстановки, при которых `source` рендерится ровно в `actual`.
 *
 * Возвращает null, если такого набора подстановок не существует.
 */
export function recoverTemplateVars(
  source: string,
  actual: string,
  startingPoint: StartingPoint,
  version: string,
): RecoveredVars | null {
  // Версия не восстанавливается, а берётся из manifest: файл обязан быть рендером
  // ровно той версии, которая записала проект.
  const shape = renderTemplate(source, {
    projectName: PROJECT_NAME_SENTINEL,
    date: DATE_SENTINEL,
    startingPoint,
    version,
  });

  const parts = shape.split(new RegExp(`(${escapeRegExp(PROJECT_NAME_SENTINEL)}|${escapeRegExp(DATE_SENTINEL)})`));
  const groups: ('projectName' | 'date')[] = [];
  let pattern = '';
  for (const part of parts) {
    if (part === PROJECT_NAME_SENTINEL || part === DATE_SENTINEL) {
      const name = part === PROJECT_NAME_SENTINEL ? 'projectName' : 'date';
      const first = groups.indexOf(name);
      // Повторное вхождение той же переменной обязано совпасть буквально.
      pattern += first === -1 ? '([^\\r\\n]*?)' : `\\${first + 1}`;
      if (first === -1) groups.push(name);
      continue;
    }
    pattern += escapeRegExp(part);
  }

  const match = new RegExp(`^${pattern}$`).exec(normalizeEol(actual));
  if (match === null) return null;

  const recovered: RecoveredVars = {};
  groups.forEach((name, index) => {
    recovered[name] = match[index + 1] ?? '';
  });

  // Единственный авторитет — повторный рендер. Всё, что не совпало побайтово,
  // считается изменённым файлом.
  const vars: TemplateVars = {
    projectName: recovered.projectName ?? '',
    date: recovered.date ?? '',
    startingPoint,
    version,
  };
  return normalizeEol(renderTemplate(source, vars)) === normalizeEol(actual) ? recovered : null;
}

/** Плейсхолдеры, которые шаблон реально использует: нерасшифрованную переменную нельзя угадывать. */
export function templateUses(source: string): { projectName: boolean; date: boolean; version: boolean } {
  const probe = renderTemplate(source, {
    projectName: PROJECT_NAME_SENTINEL,
    date: DATE_SENTINEL,
    startingPoint: 'idea',
    version: VERSION_SENTINEL,
  });
  return {
    projectName: probe.includes(PROJECT_NAME_SENTINEL),
    date: probe.includes(DATE_SENTINEL),
    version: probe.includes(VERSION_SENTINEL),
  };
}
