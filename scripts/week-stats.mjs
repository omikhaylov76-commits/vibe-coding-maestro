/**
 * Замер недели: как идёт работа в проектах Maestro. Скрипт не входит в пакет.
 *
 *   node scripts/week-stats.mjs --root <папка проектов> --from 2026-10-11 --to <дата> --label start --out <файл.json>
 *   node scripts/week-stats.mjs --compare <start.json> <end.json> [--out <файл.md>]
 *
 * Только чтение. Журналы Claude Code — только числа: из строки журнала берутся
 * разрешённые поля (`allowedFields`), текст сообщений и инструментов до отчёта не
 * доходит. Git и doctor идут с `GIT_OPTIONAL_LOCKS=0`. Пишет только в `--out`, и не
 * в репозиторий и не в проект: в отчёте имена проектов. Журналы и git разбирает
 * сам, `dist` нужен только для кодов doctor.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

/** Относительные цены шага; допущение, а не счёт. */
const PRICE = { input: 1, read: 0.1, write: 2, output: 5 };
/** Те же пороги, что у `context` и `doctor`: держит тест. */
export const SIZE_THRESHOLDS = [400_000, 600_000];
export const HOT_BEHIND_COMMITS = 3;
export const HANDOFF_COMMITS_LIMIT = 10;
/** Меньше закрытых порций на всех — данных мало. */
const MIN_CLOSED_SLICES = 5;

const HANDOFFS = ':(glob)wiki/handoffs/*.md';
const PLANS = ':(glob)wiki/plans/*.md';
const PLAN_ARCHIVE = ':(glob)wiki/plans/archive/*.md';
const MANIFEST = '.maestro/manifest.json';
const HANDOFF_SECTIONS = ['Итог для человека', 'Состояние', 'Проверки', 'Решения', 'Риски и открытые вопросы', 'Что мешало в работе', 'Следующий шаг'];
const FRICTION_SECTION = 'Что мешало в работе';
const APPROVAL_SECTION = 'Утверждение';
const ARCHIVE_PATHS = ['wiki/log/', 'wiki/plans/archive/', 'wiki/audits/archive/'];

/** Те же пять слов, что у `archive`: держит тест. */
export const OPEN_MARK_RE = /(?<![\p{L}\p{N}_])(?:UNKNOWN|OPEN_QUESTION|HYPOTHESIS|не\s+проверено|открыто)(?![\p{L}\p{N}_])/iu;
const CLOSED_FINDINGS_RE = /Находки:\s*critical\s+\d+,\s*high\s+\d+,\s*medium\s+\d+,\s*low\s+\d+;\s*открыто\s+0(?!\d)/;
const FINDINGS_RE = /^\s*(?:[-*]\s+)?Находки:\s*critical\s+(\d+),\s*high\s+(\d+),\s*medium\s+(\d+),\s*low\s+(\d+);\s*открыто\s+(\d+)\b.*$/gm;
/** В архиве плана адрес на уровень глубже: `archive` переписывает его на `../../handoffs/`. */
const RESULT_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\].*? → \[итог\]\((?:\.\.\/)+handoffs\/([^\s()/]+\.md)\)$/gm;
/** Ссылка на сам отчёт, а не упоминание папки: оно есть в образце передачи. */
const REPORT_LINK_RE = /audits\/[^\s`)]+\.md/;
const HEADING_RE = /^ {0,3}(#{2,6})[ \t]+(.*?)[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** То же имя папки журналов, что у `src/core/context.ts`: держит тест. */
export function projectLogDirName(path) {
  return resolve(path).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Последняя часть пути с любыми разделителями. */
export function leafName(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** Путь внутри проекта с разделителем `/`: так его пишет git на любой ОС. */
export const posixPath = (path) => path.replace(/\\/g, '/');

/** Только разрешённые поля строки журнала: всё остальное дальше этой функции не идёт. */
export function allowedFields(entry) {
  const message = entry?.message ?? {};
  const content = message.content;
  const blocks = typeof content === 'string' ? ['text'] : Array.isArray(content) ? content.map((block) => block?.type) : [];
  const tools = Array.isArray(content) ? content.filter((block) => block?.type === 'tool_use').map((block) => block.name) : [];
  const usage = message.usage ?? {};
  const number = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
  return {
    type: entry?.type,
    subtype: entry?.subtype,
    isSidechain: entry?.isSidechain === true,
    isMeta: entry?.isMeta === true,
    isCompactSummary: entry?.isCompactSummary === true,
    originKind: entry?.origin?.kind,
    timestamp: entry?.timestamp,
    hasToolResult: entry?.toolUseResult !== undefined,
    id: message.id,
    usage: { input: number(usage.input_tokens), read: number(usage.cache_read_input_tokens), write: number(usage.cache_creation_input_tokens), output: number(usage.output_tokens) },
    blocks,
    tools,
  };
}

const stepSize = ({ input, read, write, output }) => input + read + write + output;
const stepCost = ({ input, read, write, output }) => PRICE.input * input + PRICE.read * read + PRICE.write * write + PRICE.output * output;

/** Шаги и счётчики одного файла журнала. Оборванная последняя строка пропускается. */
async function readJournal(path, period, subagent = false) {
  const steps = new Map();
  const counts = { compactions: 0, human: 0, noOrigin: 0, ask: 0 };
  for await (const line of createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })) {
    let fields;
    try {
      fields = allowedFields(JSON.parse(line));
    } catch {
      continue;
    }
    const time = Date.parse(fields.timestamp ?? '');
    const inPeriod = time >= period.from && time <= period.to;
    if (fields.type === 'system') {
      if (fields.subtype === 'compact_boundary' && inPeriod) counts.compactions += 1;
    } else if (fields.type === 'user') {
      const text = fields.blocks.includes('text') && !fields.blocks.includes('tool_result');
      if (!inPeriod || !text || fields.isMeta || fields.hasToolResult || fields.isSidechain || fields.isCompactSummary) continue;
      if (fields.originKind === 'human') counts.human += 1;
      else if (fields.originKind === undefined) counts.noOrigin += 1;
    } else if (fields.type === 'assistant' && (subagent || !fields.isSidechain)) {
      if (inPeriod) counts.ask += fields.tools.filter((name) => name === 'AskUserQuestion').length;
      if (typeof fields.id !== 'string' || stepSize(fields.usage) === 0) continue;
      steps.set(fields.id, { size: stepSize(fields.usage), cost: stepCost(fields.usage), time });
    }
  }
  const all = [...steps.values()];
  return { ...counts, all, steps: all.filter((step) => step.time >= period.from && step.time <= period.to) };
}

const listDir = (path, withTypes = false) => {
  try {
    return readdirSync(path, { withFileTypes: withTypes });
  } catch {
    return [];
  }
};

/** `*.jsonl` основных сессий папки и файлы их субагентов. */
function journalFiles(dir) {
  const entries = listDir(dir, true);
  return {
    sessions: entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => join(dir, entry.name)),
    subagents: entries.filter((entry) => entry.isDirectory()).flatMap((entry) => {
      const folder = join(dir, entry.name, 'subagents');
      return listDir(folder).filter((name) => name.endsWith('.jsonl')).map((name) => join(folder, name));
    }),
  };
}

const sum = (list, pick = (item) => item) => list.reduce((total, item) => total + pick(item), 0);
const ratio = (part, whole) => (whole > 0 ? part / whole : null);

function quantile(values, share) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV, maxBuffer: 2 ** 31 - 1, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Разбор `git log --format=%x01%H%x09%ct` с тем, что идёт за шапкой коммита. */
function gitLog(cwd, args) {
  const output = git(cwd, ['log', '--format=%x01%H%x09%ct', ...args]) ?? '';
  return output.split('\x01').filter(Boolean).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [hash, seconds] = (head ?? '').split('\t');
    return { hash, time: Number(seconds) * 1000, rest };
  });
}

const show = (cwd, commit, path) => git(cwd, ['show', `${commit}:${path}`]);
const inPeriod = (period) => (item) => item.time >= period.from && item.time <= period.to;

export function frontmatter(text) {
  const block = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const values = {};
  for (const line of (block?.[1] ?? '').split(/\r?\n/)) {
    const pair = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (pair) values[pair[1]] = pair[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

/** Та же граница слова, что у `mentionsSlice`; шапка `wiki/hot.md` не считается. */
export function mentionsSlice(text, slice) {
  const escaped = slice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(body);
}

const sliceValue = (value) => (value === undefined || value === '' || value === 'null' || value === '~' ? null : value);

/** Порция активного плана по текстам; `readPlan` — откуда взять план. */
function currentSlice(hot, readPlan) {
  const plan = frontmatter(hot).active_plan;
  if (plan === undefined || plan === '' || plan === 'none') return null;
  const text = readPlan(`wiki/${plan}`);
  return text === null ? null : sliceValue(frontmatter(text).current_slice);
}

/** Текст раздела `## <title>` до следующего `## `; null — раздела нет. */
export function sectionOf(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

/** Строки находок в тексте: сумма по уровням; null — строки нет. */
export function findingsIn(text) {
  const matches = [...text.matchAll(FINDINGS_RE)];
  if (matches.length === 0) return null;
  const pick = (index) => sum(matches, (match) => Number(match[index]));
  return { critical: pick(1), high: pick(2), medium: pick(3), low: pick(4), open: pick(5) };
}

const needsReport = (found) => found.critical > 0 || found.high > 0 || found.open > 0;

/** Раздел трений: `text` — строки, `none` — «нет», `missing` — раздела нет. */
export function frictionsIn(text) {
  const section = sectionOf(text, FRICTION_SECTION);
  if (section === null) return { kind: 'missing', lines: [] };
  const lines = section.split('\n').map((line) => line.trim().replace(/^[-*]\s+/, '').trim()).filter(Boolean);
  if (lines.length === 0) return { kind: 'missing', lines: [] };
  if (lines.length === 1 && /^нет[.!]?$/i.test(lines[0] ?? '')) return { kind: 'none', lines: [] };
  return { kind: 'text', lines };
}

/** Заголовки разделов текста, где вне блоков кода стоит пометка незакрытого. */
export function openMarkTitles(text) {
  const titles = [];
  let current = null;
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const [, mark, rest = ''] = FENCE_RE.exec(line) ?? [];
    if (fence !== null) {
      if (mark?.[0] === fence[0] && mark.length >= fence.length && rest.trim() === '') fence = null;
      continue;
    }
    if (mark !== undefined && !(mark.startsWith('`') && rest.includes('`'))) {
      fence = mark;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      current = heading[2];
      if (OPEN_MARK_RE.test(current) && !titles.includes(current)) titles.push(current);
    } else if (current !== null && OPEN_MARK_RE.test(line.replace(CLOSED_FINDINGS_RE, '')) && !titles.includes(current)) {
      titles.push(current);
    }
  }
  return titles;
}

/** Добавленные строки патча без шапок файлов. */
const addedLines = (lines) => lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1));

/** Передачи с их состоянием в коммите добавления. */
function handoffsOf(cwd, period) {
  const added = gitLog(cwd, ['--reverse', '-M', '--diff-filter=A', '--name-only', '--', HANDOFFS]);
  const inside = added.filter(inPeriod(period)).flatMap(({ hash, time, rest }) => rest.map(posixPath).filter(Boolean).map((path) => {
    const hot = show(cwd, hash, 'wiki/hot.md') ?? '';
    const slice = currentSlice(hot, (plan) => show(cwd, hash, plan));
    return { hash, time, path, text: show(cwd, hash, path) ?? '', midSlice: slice !== null };
  }));
  return inside.sort((left, right) => left.time - right.time);
}

/** Git годится для счёта: те же условия, что у doctor. */
const lagReadable = (cwd) => existsSync(join(cwd, '.git')) && git(cwd, ['rev-parse', '--is-shallow-repository'])?.trim() === 'false';

/** Коммиты кода после опоры на этом коммите, теми же командами, что у doctor; null — опоры нет. */
function codeCommitsAt(cwd, commit) {
  const lastAdded = (path) => git(cwd, ['log', '-1', '-M', '--diff-filter=A', '--format=%H', commit, '--', path])?.trim() ?? '';
  const anchor = lastAdded(HANDOFFS) || lastAdded(MANIFEST);
  if (anchor === '') return null;
  const count = git(cwd, ['rev-list', '--count', `${anchor}..${commit}`, '--', '.', ':(exclude)wiki']);
  return count === null ? null : Number(count);
}

/** Отставание памяти на каждом коммите первой линии за период. */
function lagReplay(cwd, period) {
  const commits = lagReadable(cwd) ? gitLog(cwd, ['--first-parent', '--reverse']).filter(inPeriod(period)) : [];
  const states = [];
  for (const commit of commits) {
    const code = codeCommitsAt(cwd, commit.hash);
    if (code === null) continue;
    let hotBehind = false;
    if (code >= HOT_BEHIND_COMMITS) {
      const hot = show(cwd, commit.hash, 'wiki/hot.md') ?? '';
      const slice = currentSlice(hot, (plan) => show(cwd, commit.hash, plan));
      hotBehind = slice !== null && !mentionsSlice(hot, slice);
    }
    states.push({ time: commit.time, hotBehind, handoffBehind: code >= HANDOFF_COMMITS_LIMIT });
  }
  const timed = states.map((state, index) => ({ ...state, length: (states[index + 1]?.time ?? Math.min(period.to, Date.now())) - state.time }));
  const share = (key) => ratio(sum(timed.filter((state) => state[key]), (state) => state.length), sum(timed, (state) => state.length));
  return {
    commits: states.length,
    hotBehindCommits: states.filter((state) => state.hotBehind).length,
    handoffBehindCommits: states.filter((state) => state.handoffBehind).length,
    hotBehindTime: share('hotBehind'),
    handoffBehindTime: share('handoffBehind'),
  };
}

function lagNow(cwd) {
  const read = (path) => {
    try {
      return readFileSync(join(cwd, path), 'utf8');
    } catch {
      return null;
    }
  };
  const hot = read('wiki/hot.md') ?? '';
  const slice = currentSlice(hot, read);
  return { slice, hotNamesSlice: slice === null ? null : mentionsSlice(hot, slice), codeCommitsAfterHandoff: lagReadable(cwd) ? codeCommitsAt(cwd, 'HEAD') : null };
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** Коды doctor: только у проектов версии сборки, у остальных doctor скажет лишь «устарел». */
function doctorCodes(cwd, version) {
  const bin = join(REPO, 'dist/bin/vibe-maestro.js');
  if (!existsSync(bin)) return { note: 'сборки нет: коды doctor появятся после npm run build' };
  const build = packageVersion();
  if (version !== build) return { note: `версия проекта ${version}, сборка ${build}` };
  const run = spawnSync(process.execPath, [bin, 'doctor', '--path', cwd, '--json'], { encoding: 'utf8', env: GIT_ENV, maxBuffer: 2 ** 31 - 1 });
  try {
    const codes = {};
    for (const { code } of JSON.parse(run.stdout).findings) codes[code] = (codes[code] ?? 0) + 1;
    return { codes };
  } catch {
    return { note: 'doctor не ответил отчётом' };
  }
}

function planFiles(cwd) {
  const inFolder = (folder) => listDir(join(cwd, folder)).filter((name) => name.endsWith('.md')).map((name) => join(cwd, folder, name));
  return [...inFolder('wiki/plans'), ...inFolder('wiki/plans/archive')];
}

function auditReports(cwd, period) {
  const inFolder = (folder) => listDir(join(cwd, folder)).filter((name) => name.endsWith('.md')).map((name) => join(cwd, folder, name));
  const open = [...inFolder('wiki/audits'), ...inFolder('wiki/audits/archive')].filter((path) => frontmatter(readFileSync(path, 'utf8')).status === 'open').length;
  const added = gitLog(cwd, ['--diff-filter=A', '--name-only', '--', ':(glob)wiki/audits/*.md', ':(glob)wiki/audits/archive/*.md']).filter(inPeriod(period));
  return { inAudits: inFolder('wiki/audits').length, inArchive: inFolder('wiki/audits/archive').length, open, addedInPeriod: sum(added, (item) => item.rest.filter(Boolean).length) };
}

async function measureProject(path, claudeDir, period) {
  const name = leafName(path);
  const version = JSON.parse(readFileSync(join(path, MANIFEST), 'utf8')).product?.version ?? null;
  const own = projectLogDirName(path);
  const dirs = listDir(join(claudeDir, 'projects')).filter((dir) => dir === own || dir.startsWith(`${own}--claude-worktrees-`)).map((dir) => join(claudeDir, 'projects', dir));

  const sessions = [];
  let subagentCost = 0;
  for (const dir of dirs) {
    const { sessions: files, subagents } = journalFiles(dir);
    for (const file of files) {
      const journal = await readJournal(file, period);
      if (journal.steps.length > 0 || journal.human + journal.noOrigin + journal.compactions > 0) sessions.push(journal);
    }
    for (const file of subagents) subagentCost += sum((await readJournal(file, period, true)).steps, (step) => step.cost);
  }

  const handoffs = handoffsOf(path, period);
  const closed = handoffs.filter((item) => !item.midSlice);
  const closedTimes = [...new Set(closed.map((item) => item.time))];
  const steps = sessions.flatMap((session) => session.steps);
  const cost = sum(steps, (step) => step.cost);
  const inside = inPeriod(period);
  const at10 = sessions.flatMap((session) => (session.all[9] !== undefined && inside(session.all[9]) ? [session.all[9].size] : []));
  const ends = sessions.flatMap((session) => {
    const last = session.all.at(-1);
    return last !== undefined && inside(last) ? [last.size] : [];
  });
  const stepsPerSlice = sessions.flatMap((session) => {
    const gaps = [];
    let start = 0;
    session.all.forEach((step, index) => {
      const previous = session.all[index - 1];
      if (previous !== undefined && closedTimes.some((time) => time > previous.time && time <= step.time)) {
        gaps.push(index - start);
        start = index;
      }
    });
    return gaps;
  });
  const [low, high] = SIZE_THRESHOLDS;
  const q1 = {
    sessions: sessions.length,
    steps: steps.length,
    cost: Math.round(cost),
    costPerStep: ratio(cost, steps.length),
    sizeAt10: median(at10),
    sizeMax: median(sessions.filter((session) => session.steps.length > 0).map((session) => Math.max(...session.steps.map((step) => step.size)))),
    sizeEnd: median(ends),
    shareAbove400: ratio(sum(steps.filter((step) => step.size >= low), (step) => step.cost), cost),
    shareAbove600: ratio(sum(steps.filter((step) => step.size >= high), (step) => step.cost), cost),
    endedAbove400: ends.filter((size) => size >= low).length,
    endedAbove600: ends.filter((size) => size >= high).length,
    compactions: sum(sessions, (session) => session.compactions),
    subagentCost: Math.round(subagentCost),
    subagentShare: ratio(subagentCost, cost + subagentCost),
    stepsPerSlice: { median: median(stepsPerSlice), p75: quantile(stepsPerSlice, 0.75), p90: quantile(stepsPerSlice, 0.9) },
    handoffs: handoffs.length,
    midSliceHandoffs: handoffs.length - closed.length,
    closedSlices: closed.length,
  };

  const names = new Set(handoffs.map((item) => basename(item.path)));
  const resultLines = sum(planFiles(path), (file) => [...readFileSync(file, 'utf8').matchAll(RESULT_LINE_RE)].filter((match) => names.has(match[1])).length);
  const archived = gitLog(path, ['--name-only', '--', ...ARCHIVE_PATHS]).filter(inside);
  const moved = gitLog(path, ['-p', '-U0', '--', PLAN_ARCHIVE]).filter(inside);
  const q2 = {
    handoffs: handoffs.length,
    withSummary: handoffs.filter((item) => sectionOf(item.text, 'Итог для человека') !== null).length,
    byTemplate: handoffs.filter((item) => HANDOFF_SECTIONS.every((title) => sectionOf(item.text, title) !== null)).length,
    resultLines,
    archiveCommits: archived.length,
    openMarkCandidates: [...new Set(moved.flatMap((commit) => openMarkTitles(addedLines(commit.rest).join('\n'))))],
  };

  const frictions = handoffs.map((item) => frictionsIn(item.text));
  const q3 = {
    withText: frictions.filter((item) => item.kind === 'text').length,
    none: frictions.filter((item) => item.kind === 'none').length,
    missing: frictions.filter((item) => item.kind === 'missing').length,
    lines: frictions.flatMap((item) => item.lines),
  };

  const q4 = { critical: 0, high: 0, medium: 0, low: 0, open: 0, handoffsWithLine: 0, handoffsWithoutLine: 0, planLines: 0, lost: [], reports: auditReports(path, period) };
  const addFindings = (found) => {
    for (const level of ['critical', 'high', 'medium', 'low', 'open']) q4[level] += found[level];
  };
  // Строка — сумма по порции: у двух передач одной порции считается последняя.
  const bySlice = new Map();
  for (const item of handoffs) {
    const found = findingsIn(item.text);
    if (found === null) {
      // Посреди порции проверок могло ещё не быть: строки там и не должно быть.
      if (!item.midSlice) q4.handoffsWithoutLine += 1;
      continue;
    }
    q4.handoffsWithLine += 1;
    const { plan, slice } = frontmatter(item.text);
    bySlice.set(sliceValue(slice) === null || slice === 'none' ? item.path : `${plan}\n${slice}`, found);
    if (needsReport(found) && !REPORT_LINK_RE.test(item.text)) q4.lost.push(item.path);
  }
  for (const found of bySlice.values()) addFindings(found);
  for (const commit of gitLog(path, ['-p', '-U0', '-GНаходки: critical', '--', PLANS]).filter(inside)) {
    const lines = addedLines(commit.rest).join('\n');
    const found = findingsIn(lines);
    if (found === null) continue;
    q4.planLines += [...lines.matchAll(FINDINGS_RE)].length;
    addFindings(found);
    if (needsReport(found) && !REPORT_LINK_RE.test(lines)) q4.lost.push(`план, коммит ${commit.hash.slice(0, 7)}`);
  }

  const q5 = { ...lagReplay(path, period), now: lagNow(path), doctor: doctorCodes(path, version) };

  const human = sum(sessions, (session) => session.human);
  const ask = sum(sessions, (session) => session.ask);
  const q6 = { human, noOrigin: sum(sessions, (session) => session.noOrigin), humanPerSlice: ratio(human, closed.length), ask, askPerSlice: ratio(ask, closed.length) };

  return { name, path, version, q1, q2, q3, q4, q5, q6 };
}

/** Папки журналов с префиксом `--root` без своего проекта: только токены, по папкам. */
async function orphanLogs(root, projects, claudeDir, period, excluded) {
  const prefix = `${projectLogDirName(root)}-`;
  const own = projects.map(projectLogDirName);
  const belongs = (dir, base) => dir === base || dir.startsWith(`${base}-`);
  const result = {};
  for (const dir of listDir(join(claudeDir, 'projects'))) {
    if (!dir.startsWith(prefix) || own.some((base) => dir === base || dir.startsWith(`${base}--claude-worktrees-`)) || excluded.some((base) => belongs(dir, base))) continue;
    const { sessions: files } = journalFiles(join(claudeDir, 'projects', dir));
    const journals = [];
    for (const file of files) journals.push(await readJournal(file, period));
    const steps = journals.flatMap((journal) => journal.steps);
    if (steps.length > 0) result[dir] = { sessions: journals.filter((journal) => journal.steps.length > 0).length, steps: steps.length, cost: Math.round(sum(steps, (step) => step.cost)) };
  }
  return result;
}

function projectsIn(root) {
  return listDir(root, true).filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, MANIFEST))).map((entry) => join(root, entry.name));
}

/** Корень основной копии репозитория: журналы его рабочих копий — не проекты. */
function mainRepository() {
  const common = git(REPO, ['rev-parse', '--git-common-dir']);
  return common === null ? REPO : dirname(resolve(REPO, common.trim()));
}

/** Настоящий путь: ссылки раскрыты, регистр как на диске. */
const realDir = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
};

const isInside = (path, dir) => {
  const rest = relative(dir, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
};

/** Цель записи с настоящим путём: `/tmp` и `/private/tmp` на macOS — одно и то же. */
const realTarget = (path) => (existsSync(path) ? realDir(path) : join(realDir(dirname(resolve(path))), basename(path)));

function refuseOut(out, projects) {
  if (!existsSync(dirname(resolve(out)))) return `Нет папки для --out: ${dirname(resolve(out))}.`;
  // Ссылка, даже висячая, увела бы запись в другое место.
  if (lstatSync(out, { throwIfNoEntry: false })?.isSymbolicLink()) return `--out — ссылка: ${out}. Назовите настоящий файл.`;
  const target = realTarget(out);
  for (const dir of [REPO, mainRepository()]) {
    if (isInside(target, realDir(dir))) return `--out внутри репозитория: ${out}. В отчёте имена проектов, он лежит вне репозитория.`;
  }
  for (const project of projects) {
    if (isInside(target, realDir(project))) return `--out внутри проекта: ${out}. Скрипт только читает проекты.`;
  }
  return null;
}

const percent = (value) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)} %`);
const plain = (value) => (value === null || value === undefined ? '—' : String(Math.round(value * 10) / 10));
const per = (part, whole) => ratio(part ?? 0, whole ?? 0);

/** Строки сравнения: период разный, поэтому на шаг, на порцию и доли, а не суммы. */
const ROWS = [
  ['1', 'сессий', (r) => plain(r.q1.sessions)],
  ['1', 'шагов', (r) => plain(r.q1.steps)],
  ['1', 'стоимость на шаг', (r) => plain(r.q1.costPerStep)],
  ['1', 'размер на 10-м шаге, медиана', (r) => plain(r.q1.sizeAt10)],
  ['1', 'наибольший размер, медиана', (r) => plain(r.q1.sizeMax)],
  ['1', 'размер в конце сессии, медиана', (r) => plain(r.q1.sizeEnd)],
  ['1', 'доля стоимости от 400 тыс.', (r) => percent(r.q1.shareAbove400)],
  ['1', 'доля стоимости от 600 тыс.', (r) => percent(r.q1.shareAbove600)],
  ['1', 'сессии, закончившиеся от 400 тыс.', (r) => percent(per(r.q1.endedAbove400, r.q1.sessions))],
  ['1', 'сессии, закончившиеся от 600 тыс.', (r) => percent(per(r.q1.endedAbove600, r.q1.sessions))],
  ['1', 'сжатий на 1000 шагов', (r) => plain((per(r.q1.compactions, r.q1.steps) ?? 0) * 1000)],
  ['1', 'доля субагентов в стоимости', (r) => percent(r.q1.subagentShare)],
  ['1', 'шагов на порцию, медиана', (r) => plain(r.q1.stepsPerSlice.median)],
  ['1', 'передач посреди порции', (r) => percent(per(r.q1.midSliceHandoffs, r.q1.handoffs))],
  ['2', 'передач', (r) => plain(r.q2.handoffs)],
  ['2', 'с «Итогом для человека»', (r) => percent(per(r.q2.withSummary, r.q2.handoffs))],
  ['2', 'по образцу, все разделы', (r) => percent(per(r.q2.byTemplate, r.q2.handoffs))],
  ['2', 'строк итога в плане на закрытую порцию', (r) => plain(per(r.q2.resultLines, r.q1.closedSlices))],
  ['2', 'коммитов архива на закрытую порцию', (r) => plain(per(r.q2.archiveCommits, r.q1.closedSlices))],
  ['2', 'кандидатов на ошибку в разделах', (r) => plain(r.q2.openMarkCandidates.length)],
  ['3', 'передач со строкой трений', (r) => percent(per(r.q3.withText, r.q2.handoffs))],
  ['3', 'передач с «нет»', (r) => percent(per(r.q3.none, r.q2.handoffs))],
  ['3', 'передач без раздела', (r) => percent(per(r.q3.missing, r.q2.handoffs))],
  ['4', 'находок critical и high на передачу', (r) => plain(per(r.q4.critical + r.q4.high, r.q2.handoffs))],
  ['4', 'находок medium и low на передачу', (r) => plain(per(r.q4.medium + r.q4.low, r.q2.handoffs))],
  ['4', 'открыто', (r) => plain(r.q4.open)],
  ['4', 'закрытых порций без строки находок', (r) => percent(per(r.q4.handoffsWithoutLine, r.q1.closedSlices))],
  ['4', 'потери: нет ссылки на отчёт', (r) => plain(r.q4.lost.length)],
  ['5', 'доля времени: порция не в wiki/hot.md', (r) => percent(r.q5.hotBehindTime)],
  ['5', 'доля времени: передача отстала', (r) => percent(r.q5.handoffBehindTime)],
  ['5', 'коммитов кода после передачи сейчас', (r) => plain(r.q5.now.codeCommitsAfterHandoff)],
  ['6', 'сообщений человека на порцию', (r) => plain(r.q6.humanPerSlice)],
  ['6', 'вопросов AskUserQuestion на порцию', (r) => plain(r.q6.askPerSlice)],
];

const closedSlices = (report) => sum(Object.values(report.projects), (project) => project.q1.closedSlices);

export function compareReports(before, after) {
  const names = [...new Set([...Object.keys(before.projects), ...Object.keys(after.projects)])].sort();
  const lines = ['# Неделя: было и стало', '', `Было: ${before.label}, ${before.from} — ${before.to}. Стало: ${after.label}, ${after.from} — ${after.to}. Период разный: сравнение на шаг, на порцию и доли.`, ''];
  for (const name of names) {
    const was = before.projects[name];
    const now = after.projects[name];
    lines.push(`## ${name}`, '', '| Вопрос | Показатель | Было | Стало |', '|---|---|---|---|');
    for (const [question, title, pick] of ROWS) lines.push(`| ${question} | ${title} | ${was === undefined ? '—' : pick(was)} | ${now === undefined ? '—' : pick(now)} |`);
    const frictions = now?.q3.lines ?? [];
    if (frictions.length > 0) lines.push('', 'Что мешало:', ...frictions.map((line) => `- ${line}`));
    const candidates = now?.q2.openMarkCandidates ?? [];
    if (candidates.length > 0) lines.push('', 'Перенесённые разделы с пометками незакрытого:', ...candidates.map((title) => `- ${title}`));
    lines.push('');
  }
  const closed = closedSlices(after);
  lines.push(`Закрытых порций за второй период на всех: ${closed}.`);
  if (closed < MIN_CLOSED_SLICES) lines.push(`Меньше ${MIN_CLOSED_SLICES}: данных мало, продлить ли неделю, решает человек.`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = { projects: [], compare: null, root: null, from: null, to: null, label: 'measure', out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg}: нужно значение.`);
      return argv[index];
    };
    if (arg === '--root') options.root = value();
    else if (arg === '--project') options.projects.push(value());
    else if (arg === '--from') options.from = value();
    else if (arg === '--to') options.to = value();
    else if (arg === '--label') options.label = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--compare') options.compare = [value(), value()];
    else throw new Error(`Неизвестный флаг: ${arg}.`);
  }
  return options;
}

function periodOf(from, to) {
  for (const date of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || Number.isNaN(Date.parse(`${date}T00:00:00`))) throw new Error('--from и --to — даты вида ГГГГ-ММ-ДД.');
  }
  if (from > to) throw new Error('--from позже --to.');
  return { from: Date.parse(`${from}T00:00:00`), to: Date.parse(`${to}T23:59:59.999`) };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.compare !== null) {
    const [before, after] = options.compare.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const text = compareReports(before, after);
    if (options.out === null) process.stdout.write(text);
    else {
      const refused = refuseOut(options.out, [before, after].flatMap((report) => Object.values(report.projects).map((project) => project.path)));
      if (refused !== null) throw new Error(refused);
      writeFileSync(options.out, text, 'utf8');
    }
    return;
  }
  const period = periodOf(options.from, options.to);
  if (options.root === null && options.projects.length === 0) throw new Error('Нужна папка проектов (--root) или проект (--project).');
  const projects = [...new Set([...(options.root === null ? [] : projectsIn(resolve(options.root))), ...options.projects.map((path) => resolve(path))])].sort();
  for (const project of projects) if (!existsSync(join(project, MANIFEST))) throw new Error(`Это не проект Maestro: ${project}.`);
  if (options.out !== null) {
    const refused = refuseOut(options.out, projects);
    if (refused !== null) throw new Error(refused);
  }
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const measured = {};
  for (const project of projects) {
    const report = await measureProject(project, claudeDir, period);
    measured[report.name] = report;
  }
  const report = {
    reportVersion: 1,
    label: options.label,
    from: options.from,
    to: options.to,
    createdAt: new Date().toISOString(),
    build: packageVersion(),
    projects: measured,
    logDirsWithoutProject: options.root === null ? {} : await orphanLogs(resolve(options.root), projects, claudeDir, period, [projectLogDirName(mainRepository())]),
  };
  if (options.out !== null) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const lines = [`Замер ${report.label}: ${report.from} — ${report.to}.`];
  for (const { name, q1, q6 } of Object.values(measured)) {
    lines.push(`${name}: сессий ${q1.sessions}, шагов ${q1.steps}, передач ${q1.handoffs} (посреди порции ${q1.midSliceHandoffs}), сообщений человека ${q6.human}.`);
  }
  lines.push(`Закрытых порций на всех: ${closedSlices(report)}.`);
  if (options.out !== null) lines.push(`Записано: ${options.out}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`week-stats: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 2;
  });
}
