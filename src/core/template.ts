import { CREATE_COMMAND, PRODUCT_NAME, SERVICE_COMMAND } from './meta.js';
import type { StartingPoint } from './meta.js';

/**
 * Человекочитаемый плейсхолдер даты. Подставляется ТОЛЬКО во frontmatter,
 * чтобы не испортить документированный формат записей в теле документа.
 */
export const DATE_PLACEHOLDER = 'ГГГГ-ММ-ДД';

const FRONTMATTER_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
/**
 * Умышленно широкий: любой {{...}} обязан быть известным.
 * Опечатка в шаблоне (в т.ч. кириллицей) должна падать, а не молча уезжать в файл проекта.
 */
const PLACEHOLDER_RE = /\{\{([^{}\r\n]+)\}\}/g;

export interface TemplateVars {
  projectName: string;
  date: string;
  startingPoint: StartingPoint;
}

export interface SplitResult {
  hasFrontmatter: boolean;
  frontmatter: string;
  body: string;
  open: string;
  close: string;
}

export function splitFrontmatter(content: string): SplitResult {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { hasFrontmatter: false, frontmatter: '', body: content, open: '', close: '' };
  }
  return {
    hasFrontmatter: true,
    open: match[1] as string,
    frontmatter: match[2] as string,
    close: match[3] as string,
    body: content.slice((match[0] as string).length),
  };
}

function substituteVars(text: string, vars: TemplateVars): string {
  const table: Record<string, string> = {
    PROJECT_NAME: vars.projectName,
    DATE: vars.date,
    STARTING_POINT: vars.startingPoint,
    PRODUCT_NAME,
    CREATE_COMMAND,
    SERVICE_COMMAND,
  };

  return text.replace(PLACEHOLDER_RE, (_full, name: string) => {
    const value = table[name];
    if (value === undefined) {
      throw new Error(`Неизвестный плейсхолдер шаблона: {{${name}}}`);
    }
    return value;
  });
}

/**
 * Рендерит шаблон проекта.
 * Даты в формате ГГГГ-ММ-ДД заменяются только внутри frontmatter;
 * {{ПЕРЕМЕННЫЕ}} — везде. Неизвестный плейсхолдер — ошибка, а не тихая пропажа.
 */
export function renderTemplate(source: string, vars: TemplateVars): string {
  const parsed = splitFrontmatter(source);

  if (!parsed.hasFrontmatter) {
    return substituteVars(parsed.body, vars);
  }

  const frontmatter = substituteVars(parsed.frontmatter, vars).split(DATE_PLACEHOLDER).join(vars.date);
  const body = substituteVars(parsed.body, vars);

  return parsed.open + frontmatter + parsed.close + body;
}
