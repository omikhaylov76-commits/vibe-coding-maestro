import { posix } from 'node:path';
import { frontmatter } from '../doctor/text.js';
import { HOT_PATH, planFileName } from '../doctor/plans.js';
import { ACTIVE_PLAN_NONE, isWikiRelativePlanRef, PLAN_APPROVAL_DIGEST_KEY, PLAN_NULL, planDigestMatches } from '../plan.js';
import { countChars, formatChars } from './limits.js';
import { linkName } from './links.js';
import { markdownLines, withoutBom } from './markdown.js';
import { blocker } from './types.js';
import type { ArchiveBlocker } from './types.js';

export const PLANS_ARCHIVE_DIR = 'wiki/plans/archive';

/** Законченные планы: к ним не возвращаются, их отпечаток никто не сверит. `blocked` — пауза, он сюда не входит. */
const FINISHED_STATUSES: readonly string[] = ['completed', 'rejected', 'superseded'];

export interface PlanFile {
  path: string;
  /** Текст как на диске. */
  text: string;
  meta: Record<string, string> | null;
  /** Записанный отпечаток; null — не записан. */
  digest: string | null;
  /** Отпечаток сверят doctor и preflight, сейчас или после паузы: план не закончен и отпечаток записан. */
  guarded: boolean;
  /** Текст совпадает с отпечатком; без отпечатка сверять нечего. */
  intact: boolean;
}

export function planFiles(files: ReadonlyMap<string, string>): PlanFile[] {
  const plans: PlanFile[] = [];
  for (const [path, text] of files) {
    if (planFileName(path) === null) continue;
    const plain = withoutBom(text);
    const meta = frontmatter(plain);
    const recorded = meta?.[PLAN_APPROVAL_DIGEST_KEY];
    const digest = recorded === undefined || recorded === PLAN_NULL ? null : recorded;
    plans.push({
      path,
      text,
      meta,
      digest,
      guarded: digest !== null && !FINISHED_STATUSES.includes(meta?.status ?? ''),
      intact: digest === null || planDigestMatches(digest, plain),
    });
  }
  return plans;
}

export const planArchivePath = (planPath: string): string => `${PLANS_ARCHIVE_DIR}/${posix.basename(planPath)}`;

/** Шапка нового архива плана. */
function planArchiveHeader(plan: PlanFile, eol: string): string {
  const name = posix.basename(plan.path);
  return [
    '---', 'type: plan-archive', `plan: ${plan.meta?.id ?? name.slice(0, -3)}`, `source: ${plan.path}`, '---', '',
    `# Архив плана: ${name.slice(0, -3)}`, '',
    `Закрытые правки, перенесённые из [плана](../${linkName(name)}) командой \`vibe-maestro archive\`: текст прежний, поправлены только адреса ссылок. Это история: читайте поиском, руками не правьте и обратно в план не копируйте.`, '', '',
  ].join(eol);
}

/** Дописывает блоки в архив плана: новый файл — с шапкой, между блоками — пустая строка. */
export function appendToPlanArchive(existing: string | null, plan: PlanFile, blocks: readonly string[], eol: string): string {
  let text = existing ?? planArchiveHeader(plan, eol);
  for (const block of blocks) {
    if (!/(?:\r?\n){2}$/.test(text)) text += /\r?\n$/.test(text) ? eol : `${eol}${eol}`;
    text += block;
  }
  return text;
}

/** Строка в архиве плана: чем заменён отпечаток и когда. */
export const digestLine = (date: string, before: string, after: string, eol: string): string =>
  `Отпечаток плана заменён командой \`vibe-maestro archive\` ${date}: \`${before}\` → \`${after}\`. Текст совпадал с прежним отпечатком, изменились только перенесённые разделы и адреса ссылок.${eol}`;

/** Записывает новый отпечаток в строку frontmatter, остальные байты те же. */
export function writeDigest(text: string, digest: string): string {
  return text.replace(new RegExp(`^${PLAN_APPROVAL_DIGEST_KEY}:.*$`, 'm'), `${PLAN_APPROVAL_DIGEST_KEY}: ${digest}`);
}

export interface PlanHeading {
  level: number;
  /** Строка заголовка как на диске, с переводом строки. */
  line: string;
  /** Заголовок без разметки и лишних пробелов. */
  title: string;
  start: number;
  /** Конец раздела: следующий заголовок того же или старшего уровня. */
  end: number;
}

const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*\r?\n?$/;
const WORD_RE = /^[\p{L}\p{N}_]/u;
const COLLECTIONS = ['Правки после утверждения', 'Изменения после утверждения'];
const APPROVAL = 'Утверждение';
const POINTER_RE = /^В архиве: \[[^\]]*\]\(archive\/[^)]*\)\.?$/;
const UNCHECKED_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[ \]/gm;
/** Сколько заголовков показать в отказе: у живых планов их сотни. */
const LISTED = 30;

/** Заголовки и аргументы сравниваются без разметки и с одинарными пробелами. */
export function plainTitle(value: string): string {
  return value.replace(/`|\*\*|[«»]/g, '').replace(/\s+/g, ' ').trim();
}

const startsWithWord = (title: string, wanted: string): boolean => title.startsWith(wanted) && !WORD_RE.test(title.slice(wanted.length));
const isCollection = (title: string): boolean => COLLECTIONS.some((name) => startsWithWord(title, name));

function mentionsSlice(text: string, slice: string): boolean {
  const escaped = slice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
}

export function planHeadings(text: string): PlanHeading[] {
  const body = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0].length ?? 0;
  const headings: PlanHeading[] = [];
  for (const { line, offset, code } of markdownLines(text)) {
    if (code || offset < body) continue;
    const match = HEADING_RE.exec(line);
    if (match !== null) headings.push({ level: match[1]?.length ?? 0, line, title: plainTitle(match[2] ?? ''), start: offset, end: text.length });
  }
  headings.forEach((heading, index) => {
    heading.end = headings.slice(index + 1).find((next) => next.level <= heading.level)?.start ?? text.length;
  });
  return headings;
}

export interface SectionChoice {
  heading: PlanHeading;
  nested: PlanHeading[];
  /** От раздела осталась только строка «В архиве: …». */
  already: boolean;
  warnings: string[];
}

export interface SectionsResolution {
  plan: PlanFile | null;
  chosen: SectionChoice[];
  blockers: ArchiveBlocker[];
}

function listed(headings: readonly PlanHeading[]): string {
  const shown = headings.slice(0, LISTED).map((heading) => `«${heading.title.slice(0, 80)}»`).join('; ');
  return headings.length > LISTED ? `${shown}; и ещё ${headings.length - LISTED}` : shown;
}

function chooseSection(text: string, plan: PlanFile, argument: string, headings: readonly PlanHeading[], collection: PlanHeading): { choice?: SectionChoice; blocker?: ArchiveBlocker } {
  const wanted = plainTitle(argument);
  const candidates = headings.filter((heading) => heading.level === 2 || heading.level === 3);
  const found = wanted === '' ? [] : candidates.filter((heading) => startsWithWord(heading.title, wanted));
  const movable = candidates.filter((heading) => heading.start > collection.start);
  if (found.length === 0) return { blocker: blocker('archive-section-not-found', `В плане нет раздела, заголовок которого начинается с «${argument}». Правки плана: ${listed(movable) || 'их нет'}.`, plan.path) };
  if (found.length > 1) return { blocker: blocker('archive-section-ambiguous', `«${argument}» подходит к разделам: ${listed(found)}. Уточните начало заголовка; одинаковые заголовки так не перенести.`, plan.path) };
  const heading = found[0]!;
  const title = `«${heading.title}»`;
  if (isCollection(heading.title)) return { blocker: blocker('archive-section-collection', `${title} — сборник правок: внутри могут быть и открытые. Называйте закрытые правки по одной.`, plan.path) };
  if (heading.start < collection.start) return { blocker: blocker('archive-section-main-part', `${title} — основная часть плана, она в архив не переносится. Переносить можно только разделы ниже «${collection.title}».`, plan.path) };
  const nested = headings.filter((other) => other.start > heading.start && other.start < heading.end);
  const slice = plan.meta?.current_slice;
  const declaredSlice = slice === undefined || slice === PLAN_NULL ? null : slice;
  for (const part of [heading, ...nested]) {
    if (isCollection(part.title)) return { blocker: blocker('archive-section-collection', `Внутри ${title} стоит сборник правок «${part.title}»: внутри него могут быть и открытые.`, plan.path) };
    if (part === heading ? startsWithWord(part.title, APPROVAL) : part.title === APPROVAL) return { blocker: blocker('archive-section-approval', `«${part.title}» — запись об утверждении плана, она остаётся в плане.`, plan.path) };
    if (declaredSlice !== null && mentionsSlice(part.title, declaredSlice)) return { blocker: blocker('archive-section-current-slice', `В заголовке «${part.title}» стоит текущая порция ${declaredSlice}: открытое в архив не переносится.`, plan.path) };
  }
  const section = text.slice(heading.start, heading.end);
  const rest = section.slice(heading.line.length);
  const warnings: string[] = [];
  if (declaredSlice !== null && mentionsSlice(rest, declaredSlice)) warnings.push(`раздел ${title} упоминает текущую порцию ${declaredSlice}.`);
  const unchecked = [...rest.matchAll(UNCHECKED_RE)].length;
  if (unchecked > 0) warnings.push(`в разделе ${title} неотмеченных пунктов [ ]: ${formatChars(unchecked)}.`);
  return { choice: { heading, nested, already: POINTER_RE.test(rest.trim()), warnings } };
}

/** `active_plan` из `wiki/hot.md`. */
export function declaredPlan(files: ReadonlyMap<string, string>): string {
  const hot = files.get(HOT_PATH);
  return (hot === undefined ? null : frontmatter(withoutBom(hot)))?.active_plan ?? ACTIVE_PLAN_NONE;
}

/** Находит названные разделы активного плана; ничего не меняет. */
export function resolveSections(files: ReadonlyMap<string, string>, plans: readonly PlanFile[], wanted: readonly string[]): SectionsResolution {
  const refuse = (item: ArchiveBlocker, plan: PlanFile | null = null): SectionsResolution => ({ plan, chosen: [], blockers: [item] });
  const declared = declaredPlan(files);
  if (declared === ACTIVE_PLAN_NONE) return refuse(blocker('archive-section-no-plan', 'Активного плана нет (active_plan: none): --section работает только в активном плане.', HOT_PATH));
  const plan = isWikiRelativePlanRef(declared) ? plans.find((item) => item.path === `wiki/${declared}`) : undefined;
  if (plan === undefined) return refuse(blocker('archive-section-plan-missing', `Объявленный активный план не найден: ${declared}.`, HOT_PATH));
  if (plan.meta === null) return refuse(blocker('archive-section-plan-invalid', 'Frontmatter плана не разобран: сначала поправьте его (doctor).', plan.path), plan);
  if (!plan.intact) return refuse(blocker('archive-plan-changed', 'Текст плана изменился после утверждения (approved_digest не совпадает): перенос записал бы новый отпечаток поверх неутверждённой правки. Покажите изменения человеку; после его «да» запишите отпечаток из вывода preflight и повторите.', plan.path), plan);

  const headings = planHeadings(plan.text);
  const collection = headings.find((heading) => (heading.level === 2 || heading.level === 3) && isCollection(heading.title));
  if (collection === undefined) return refuse(blocker('archive-section-no-collection', `В плане нет раздела «${COLLECTIONS[0]}» или «${COLLECTIONS[1]}»: переносить можно только правки, которые стоят ниже него.`, plan.path), plan);

  const chosen: SectionChoice[] = [];
  const blockers: ArchiveBlocker[] = [];
  for (const argument of wanted) {
    const result = chooseSection(plan.text, plan, argument, headings, collection);
    if (result.blocker !== undefined) blockers.push(result.blocker);
    else if (result.choice !== undefined) {
      const { heading } = result.choice;
      const overlapping = chosen.find((other) => heading.start < other.heading.end && other.heading.start < heading.end);
      if (overlapping !== undefined) blockers.push(blocker('archive-section-overlap', `Разделы «${overlapping.heading.title}» и «${heading.title}» пересекаются: назовите один из них.`, plan.path));
      else chosen.push(result.choice);
    }
  }
  return { plan, chosen, blockers };
}

export interface SectionCut {
  /** План: вместо разделов — заголовок и строка «В архиве: …». */
  remaining: string;
  /** Разделы байт в байт, с заголовками, в порядке плана. */
  sections: string[];
}

export function cutSections(text: string, chosen: readonly SectionChoice[], archivePath: string, eol: string): SectionCut {
  const name = posix.basename(archivePath);
  const sections: string[] = [];
  let remaining = '';
  let cursor = 0;
  for (const { heading } of [...chosen].filter((item) => !item.already).sort((left, right) => left.heading.start - right.heading.start)) {
    sections.push(text.slice(heading.start, heading.end));
    const line = /\n$/.test(heading.line) ? heading.line : `${heading.line}${eol}`;
    remaining += `${text.slice(cursor, heading.start)}${line}${eol}В архиве: [${name}](archive/${linkName(name)}).${eol}${eol}`;
    cursor = heading.end;
  }
  return { remaining: remaining + text.slice(cursor), sections };
}

/** Размер раздела для отчёта. */
export const sectionChars = (text: string, heading: PlanHeading): number => countChars(text.slice(heading.start, heading.end));
