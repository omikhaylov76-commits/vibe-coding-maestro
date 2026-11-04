import { execFile, spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { HANDOFF_COMMITS_LIMIT, HOT_BEHIND_COMMITS } from '../src/core/archive/limits.js';
import { FINISH_SLICE_TOKENS, NEW_SESSION_TOKENS, projectLogDirName } from '../src/core/context.js';
import { cleanupTempDirs, makeTempDir, snapshotTree } from './helpers.js';

const execFileAsync = promisify(execFile);
afterEach(cleanupTempDirs);

const SCRIPT = join(process.cwd(), 'scripts/week-stats.mjs');
const SECRET = 'СЕКРЕТНАЯ-ФРАЗА-ИЗ-ПЕРЕПИСКИ';
const FROM = '2026-10-11';
const TO = '2026-10-20';

interface Week {
  allowedFields(entry: unknown): Record<string, unknown>;
  findingsIn(text: string): Record<string, number> | null;
  frictionsIn(text: string): { kind: string; lines: string[] };
  frontmatter(text: string): Record<string, string>;
  leafName(path: string): string;
  openMarkTitles(text: string): string[];
  posixPath(path: string): string;
  projectLogDirName(path: string): string;
  HANDOFF_COMMITS_LIMIT: number;
  HOT_BEHIND_COMMITS: number;
  OPEN_MARK_RE: RegExp;
  SIZE_THRESHOLDS: number[];
}
const week = async (): Promise<Week> => await import(pathToFileURL(SCRIPT).href) as Week;

interface Run { stdout: string; stderr: string; code: number }
function run(args: string[], claudeDir: string, script = SCRIPT): Run {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir } });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? -1 };
}

const assistant = (id: string, tokens: number, time: string, extra: Record<string, unknown> = {}, content: unknown[] = []) => ({
  type: 'assistant', timestamp: time, ...extra,
  message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0, output_tokens: 2 } },
});

const human = (text: string, time: string) => ({ type: 'user', timestamp: time, origin: { kind: 'human' }, message: { content: text } });

async function journal(claudeDir: string, root: string, name: string, lines: unknown[], tail = ''): Promise<void> {
  const dir = join(claudeDir, 'projects', projectLogDirName(root));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n${tail}`, 'utf8');
}

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd });
};

/** Коммит с заданной датой: период скрипта считается по времени коммита. */
async function commit(cwd: string, date: string, message: string): Promise<void> {
  await git(cwd, 'add', '-A');
  await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgSign=false', 'commit', '-q', '--allow-empty', '-m', message], {
    cwd, env: { ...process.env, GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` },
  });
}

const PLAN = 'wiki/plans/0002-work.md';
const planText = (slice: string, extra = ''): string => `---\nid: PLAN-0002\ncurrent_slice: ${slice}\n---\n\n# План\n\n1. [x] Порция. → [итог](../handoffs/2026-10-12-close.md)\n${extra}`;
const HANDOFF = (body: string): string => `---\ntype: handoff\n---\n\n# Передача\n\n${body}\n`;
const FULL = (findings: string, friction: string): string => HANDOFF([
  '## Итог для человека', '- сделано', '', '## Состояние', '- факты', '', '## Проверки', findings, '', '## Решения', '- нет', '',
  '## Риски и открытые вопросы', '- нет', '', '## Что мешало в работе', friction, '', '## Следующий шаг', '- дальше',
].join('\n'));

/** Проект с историей: передача закрытой порции, передача посреди порции, отставшая память. */
async function project(root: string, name = 'учебный проект'): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, '.maestro'), { recursive: true });
  await mkdir(join(path, 'wiki/handoffs'), { recursive: true });
  await mkdir(join(path, 'wiki/plans/archive'), { recursive: true });
  await mkdir(join(path, 'wiki/audits'), { recursive: true });
  await mkdir(join(path, 'src'));
  await git(path, 'init', '-q');
  await writeFile(join(path, '.maestro/manifest.json'), JSON.stringify({ product: { version: '0.4.5' } }), 'utf8');
  await writeFile(join(path, 'wiki/hot.md'), '---\nactive_plan: plans/0002-work.md\n---\n\n# Сейчас\n', 'utf8');
  await writeFile(join(path, PLAN), planText('null'), 'utf8');
  await commit(path, '2026-10-01', 'Maestro');

  await writeFile(join(path, 'src/a.txt'), '1\n', 'utf8');
  await commit(path, '2026-10-11', 'код');
  await writeFile(join(path, 'wiki/handoffs/2026-10-12-close.md'), FULL('Находки: critical 0, high 1, medium 2, low 3; открыто 1.', '- нет'), 'utf8');
  await commit(path, '2026-10-12', 'передача закрытой порции');

  await writeFile(join(path, PLAN), planText('01-next', '\n## Утверждение\n\nНаходки: critical 1, high 0, medium 0, low 0; открыто 0.\n'), 'utf8');
  await writeFile(join(path, 'wiki/plans/archive/0002-work.md'), '# Архив\n\n### Правка 1\n\nHYPOTHESIS: проверить.\n\n### Правка 2\n\n```text\nUNKNOWN\n```\n', 'utf8');
  await commit(path, '2026-10-13', 'план и архив');
  await writeFile(join(path, 'wiki/handoffs/2026-10-14-mid.md'), FULL('Находки: critical 0, high 0, medium 0, low 0; открыто 0.', '- упала сборка на старом Node'), 'utf8');
  await commit(path, '2026-10-14', 'передача посреди порции');
  await writeFile(join(path, 'wiki/handoffs/2026-10-14-bare.md'), HANDOFF('## Состояние\n- факты'), 'utf8');
  await commit(path, '2026-10-14', 'передача без образца');
  for (let day = 15; day < 19; day += 1) {
    await writeFile(join(path, 'src/a.txt'), `${day}\n`, 'utf8');
    await commit(path, `2026-10-${day}`, `код ${day}`);
  }
  return path;
}

async function sample(): Promise<{ root: string; claudeDir: string; path: string; out: string }> {
  const root = await makeTempDir('week-');
  const claudeDir = await makeTempDir('week-claude-');
  const path = await project(root);
  await journal(claudeDir, path, 's1', [
    assistant('old', 900_000, '2026-09-01T09:04:00Z'),
    human(`первое сообщение ${SECRET}`, '2026-10-12T09:00:00Z'),
    { type: 'user', timestamp: '2026-10-12T09:00:01Z', origin: { kind: 'task-notification' }, message: { content: `уведомление субагента ${SECRET}` } },
    { type: 'user', timestamp: '2026-10-12T09:00:02Z', isCompactSummary: true, message: { content: `сводка сжатия ${SECRET}` } },
    { type: 'user', timestamp: '2026-10-12T09:00:03Z', isMeta: true, origin: { kind: 'human' }, message: { content: SECRET } },
    { type: 'user', timestamp: '2026-10-12T09:00:04Z', toolUseResult: { stdout: SECRET }, origin: { kind: 'human' }, message: { content: [{ type: 'tool_result', content: SECRET }] } },
    assistant('m1', 100_000, '2026-10-12T09:01:00Z', {}, [{ type: 'text', text: SECRET }]),
    assistant('m1', 100_000, '2026-10-12T09:01:00Z', {}, [{ type: 'tool_use', name: 'AskUserQuestion', input: { question: SECRET } }]),
    assistant('m2', 450_000, '2026-10-12T09:02:00Z', {}, [{ type: 'tool_use', name: 'Bash', input: { command: SECRET } }]),
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-12T09:03:00Z', content: SECRET },
    assistant('sub', 900_000, '2026-10-12T09:03:30Z', { isSidechain: true }),
    assistant('m3', 650_000, '2026-10-16T09:04:00Z'),
  ], '{"type":"assistant","message":{"id":"торн');
  const sub = join(claudeDir, 'projects', projectLogDirName(path), 's1', 'subagents');
  await mkdir(sub, { recursive: true });
  await writeFile(join(sub, 'agent-1.jsonl'), `${JSON.stringify(assistant('a1', 1_000, '2026-10-12T09:01:30Z', { isSidechain: true }, [{ type: 'text', text: SECRET }]))}\n`, 'utf8');
  return { root, claudeDir, path, out: join(await makeTempDir('week-out-'), 'start.json') };
}

interface Report {
  label: string;
  projects: Record<string, {
    q1: Record<string, unknown>; q2: Record<string, unknown> & { openMarkCandidates: string[] }; q3: Record<string, unknown>;
    q4: Record<string, unknown> & { reports: Record<string, number> }; q5: Record<string, unknown>; q6: Record<string, number | null>;
  }>;
  logDirsWithoutProject: Record<string, { sessions: number; steps: number; cost: number }>;
}

const measure = (setup: { root: string; claudeDir: string; out: string }, label = 'start'): Run =>
  run(['--root', setup.root, '--from', FROM, '--to', TO, '--label', label, '--out', setup.out], setup.claudeDir);

describe('0.4.5: скрипт недели', () => {
  it('журналы — только числа: секретная фраза не попадает ни в вывод, ни в файл, ни в сравнение', async () => {
    const setup = await sample();
    const first = measure(setup);
    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    const text = await readFile(setup.out, 'utf8');
    expect(first.stdout).not.toContain(SECRET);
    expect(text).not.toContain(SECRET);
    const compared = run(['--compare', setup.out, setup.out], setup.claudeDir);
    expect(compared.code).toBe(0);
    expect(compared.stdout).not.toContain(SECRET);
  });

  it('разрешённые поля: из строки журнала уходят только служебные значения', async () => {
    const { allowedFields } = await week();
    const fields = allowedFields({
      type: 'assistant', timestamp: 't', origin: { kind: 'human', note: SECRET }, secret: SECRET, cwd: SECRET,
      message: { id: 'm', role: SECRET, content: [{ type: 'text', text: SECRET }, { type: 'tool_use', name: 'Bash', input: SECRET }], usage: { input_tokens: 1, note: SECRET } },
    });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
    expect(fields).toMatchObject({ originKind: 'human', blocks: ['text', 'tool_use'], tools: ['Bash'] });
    expect(JSON.stringify(allowedFields({ type: 'user', message: { content: SECRET } }))).not.toContain(SECRET);
  });

  it('вопрос 1 и 6: шаги, размер, субагенты отдельно; сообщение человека — только origin.kind human', async () => {
    const setup = await sample();
    expect(measure(setup).code).toBe(0);
    const report = JSON.parse(await readFile(setup.out, 'utf8')) as Report;
    const data = report.projects['учебный проект'];
    expect(data?.q1).toMatchObject({ sessions: 1, steps: 3, compactions: 1, sizeMax: 650_012, sizeEnd: 650_012, endedAbove400: 1, endedAbove600: 1, handoffs: 3, midSliceHandoffs: 2, closedSlices: 1 });
    // 10 + 0,1·размер кеша + 5·2: те же цены, что в проигрыше порогов.
    expect(data?.q1.cost).toBe(Math.round(3 * 20 + 0.1 * (100_000 + 450_000 + 650_000)));
    expect(data?.q1.subagentCost).toBe(Math.round(20 + 100));
    expect(data?.q1.shareAbove400).toBeCloseTo((45_020 + 65_020) / (10_020 + 45_020 + 65_020), 5);
    expect(data?.q1.shareAbove600).toBeCloseTo(65_020 / (10_020 + 45_020 + 65_020), 5);
    expect(data?.q6).toMatchObject({ human: 1, noOrigin: 0, ask: 1, humanPerSlice: 1, askPerSlice: 1 });
  });

  it('вопросы 2–5: передачи, строка итога, разделы, трения, находки, потери, отставание', async () => {
    const setup = await sample();
    expect(measure(setup).code).toBe(0);
    const data = (JSON.parse(await readFile(setup.out, 'utf8')) as Report).projects['учебный проект'];
    expect(data?.q2).toMatchObject({ handoffs: 3, withSummary: 2, byTemplate: 2, resultLines: 1, archiveCommits: 1, openMarkCandidates: ['Правка 1'] });
    expect(data?.q3).toEqual({ withText: 1, none: 1, missing: 1, lines: ['упала сборка на старом Node'] });
    expect(data?.q4).toMatchObject({ critical: 1, high: 1, medium: 2, low: 3, open: 1, handoffsWithLine: 2, handoffsWithoutLine: 1, planLines: 1 });
    expect(data?.q4.lost).toEqual(['wiki/handoffs/2026-10-12-close.md', expect.stringContaining('план, коммит ')]);
    expect(data?.q5).toMatchObject({ commits: 9, hotBehindCommits: 2, handoffBehindCommits: 0, now: { slice: '01-next', hotNamesSlice: false, codeCommitsAfterHandoff: 4 } });
  });

  it('потери: со ссылкой на отчёт — нет; открытый отчёт считается', async () => {
    const setup = await sample();
    await writeFile(join(setup.path, 'wiki/handoffs/2026-10-19-ok.md'), FULL('Находки: critical 0, high 2, medium 0, low 0; открыто 0. [отчёт](../audits/AUD-1.md)', '- нет'), 'utf8');
    await writeFile(join(setup.path, 'wiki/audits/AUD-1.md'), '---\naudit_id: AUD-1\nstatus: open\n---\n', 'utf8');
    await commit(setup.path, '2026-10-19', 'передача');
    expect(measure(setup).code).toBe(0);
    const data = (JSON.parse(await readFile(setup.out, 'utf8')) as Report).projects['учебный проект'];
    expect(data?.q4.lost).not.toContain('wiki/handoffs/2026-10-19-ok.md');
    expect(data?.q4.reports).toEqual({ inAudits: 1, inArchive: 0, open: 1, addedInPeriod: 1 });
  });

  it('запись только в --out; снимок проекта до и после совпадает; --out внутри репозитория и проекта — отказ', async () => {
    const setup = await sample();
    const before = await snapshotTree(setup.path);
    const repoBefore = await readdir(join(process.cwd(), 'scripts'));
    expect(measure(setup).code).toBe(0);
    expect(await snapshotTree(setup.path)).toEqual(before);
    expect(await readdir(dirname(setup.out))).toEqual(['start.json']);

    const inside = join(process.cwd(), 'scripts', 'week-out.json');
    const refused = run(['--root', setup.root, '--from', FROM, '--to', TO, '--out', inside], setup.claudeDir);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('внутри репозитория');
    expect(await readdir(join(process.cwd(), 'scripts'))).toEqual(repoBefore);

    const own = run(['--root', setup.root, '--from', FROM, '--to', TO, '--out', join(setup.path, 'week.json')], setup.claudeDir);
    expect(own.code).toBe(2);
    expect(own.stderr).toContain('внутри проекта');
    expect(await snapshotTree(setup.path)).toEqual(before);
  });

  it('папки журналов без проекта: только с префиксом --root, без Maestro, только токены', async () => {
    const setup = await sample();
    const capsule = join(setup.root, 'capsule');
    await journal(setup.claudeDir, capsule, 'c1', [assistant('c', 1_000, '2026-10-12T09:01:00Z', {}, [{ type: 'text', text: SECRET }])]);
    await journal(setup.claudeDir, join(dirname(setup.root), 'other-root', 'x'), 'c2', [assistant('d', 1_000, '2026-10-12T09:01:00Z')]);
    await journal(setup.claudeDir, process.cwd(), 'own', [assistant('e', 1_000, '2026-10-12T09:01:00Z')]);
    expect(measure(setup).code).toBe(0);
    const report = JSON.parse(await readFile(setup.out, 'utf8')) as Report;
    expect(report.logDirsWithoutProject).toEqual({ [projectLogDirName(capsule)]: { sessions: 1, steps: 1, cost: 120 } });
  });

  it('варианты журнала --claude-worktrees-… считаются к проекту; --project работает без --root', async () => {
    const setup = await sample();
    const dir = join(setup.claudeDir, 'projects', `${projectLogDirName(setup.path)}--claude-worktrees-side-1`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 's2.jsonl'), `${JSON.stringify(assistant('w', 1_000, '2026-10-13T09:01:00Z'))}\n`, 'utf8');
    const result = run(['--project', setup.path, '--from', FROM, '--to', TO, '--out', setup.out], setup.claudeDir);
    expect(result.code).toBe(0);
    expect((JSON.parse(await readFile(setup.out, 'utf8')) as Report).projects['учебный проект']?.q1).toMatchObject({ sessions: 2, steps: 4 });
  });

  it('оборванная последняя строка журнала не падает; журнала нет — нули, не падение', async () => {
    const root = await makeTempDir('week-');
    const claudeDir = await makeTempDir('week-claude-');
    const path = await project(root);
    expect(run(['--root', root, '--from', FROM, '--to', TO], claudeDir).code).toBe(0);
    await journal(claudeDir, path, 's1', [assistant('m1', 1_000, '2026-10-12T09:01:00Z')], '{"type":"assistant","mess');
    const result = run(['--root', root, '--from', FROM, '--to', TO], claudeDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('шагов 1');
  });

  it('сравнение: по проектам, на шаг и на порцию; меньше пяти закрытых порций — данных мало', async () => {
    const setup = await sample();
    expect(measure(setup).code).toBe(0);
    const compared = run(['--compare', setup.out, setup.out], setup.claudeDir);
    expect(compared.stdout).toContain('## учебный проект');
    expect(compared.stdout).toContain('| 1 | стоимость на шаг |');
    expect(compared.stdout).toContain('| 6 | сообщений человека на порцию | 1 | 1 |');
    expect(compared.stdout).toContain('- упала сборка на старом Node');
    expect(compared.stdout).toContain('- Правка 1');
    expect(compared.stdout).toContain('данных мало');
  });

  it('без сборки — понятная строка, а не падение; проект другой версии — без doctor', async () => {
    const setup = await sample();
    const copy = await makeTempDir('week-script-');
    await mkdir(join(copy, 'scripts'));
    await cp(SCRIPT, join(copy, 'scripts/week-stats.mjs'));
    const result = run(['--root', setup.root, '--from', FROM, '--to', TO, '--out', setup.out], setup.claudeDir, join(copy, 'scripts/week-stats.mjs'));
    expect(result.code).toBe(0);
    expect((JSON.parse(await readFile(setup.out, 'utf8')) as Report).projects['учебный проект']?.q5).toMatchObject({ doctor: { note: expect.stringContaining('сборки нет') } });
  });

  it('неверные флаги — отказ кодом 2', async () => {
    const claudeDir = await makeTempDir('week-claude-');
    expect(run(['--from', 'вчера', '--to', TO], claudeDir).code).toBe(2);
    expect(run(['--from', FROM, '--to', TO], claudeDir).code).toBe(2);
    expect(run(['--что-то'], claudeDir).code).toBe(2);
    expect(run(['--project', await makeTempDir('week-'), '--from', FROM, '--to', TO], claudeDir).stderr).toContain('не проект Maestro');
  });
});

describe('0.4.5: скрипт недели держится тех же правил, что и пакет', () => {
  it('образец передачи (N → 0) разбирается той же регуляркой, что настоящая строка', async () => {
    const { findingsIn } = await week();
    const sampleText = await readFile(join(process.cwd(), 'templates/project/maestro/templates/handoff.md'), 'utf8');
    expect(findingsIn(sampleText)).toBeNull();
    const line = sampleText.split('\n').find((item) => item.startsWith('Находки:')) ?? '';
    expect(findingsIn(line.replace(/ N\b/g, ' 0'))).toEqual({ critical: 0, high: 0, medium: 0, low: 0, open: 0 });
    expect(findingsIn('Находки: critical 1, high 2, medium 3, low 4; открыто 5. [отчёт](../audits/A.md)')).toEqual({ critical: 1, high: 2, medium: 3, low: 4, open: 5 });
    expect(findingsIn('- Находки: critical 1, high 0, medium 0, low 0; открыто 0.')).toMatchObject({ critical: 1 });
  });

  it('раздел трений образца читается как раздел, «нет» — как «нет»', async () => {
    const { frictionsIn } = await week();
    const sampleText = await readFile(join(process.cwd(), 'templates/project/maestro/templates/handoff.md'), 'utf8');
    expect(frictionsIn(sampleText).kind).toBe('text');
    expect(frictionsIn('## Что мешало в работе\n- нет\n\n## Следующий шаг\n- x').kind).toBe('none');
    expect(frictionsIn('## Что мешало в работе\nНет.\n').kind).toBe('none');
    expect(frictionsIn('## Состояние\n- x\n').kind).toBe('missing');
    expect(frictionsIn('## Что мешало в работе\n- тест падал\n- порт занят\n## Следующий шаг\n')).toEqual({ kind: 'text', lines: ['тест падал', 'порт занят'] });
  });

  it('пороги и имя папки журналов совпадают с кодом пакета', async () => {
    const script = await week();
    expect(script.SIZE_THRESHOLDS).toEqual([FINISH_SLICE_TOKENS, NEW_SESSION_TOKENS]);
    expect([script.HOT_BEHIND_COMMITS, script.HANDOFF_COMMITS_LIMIT]).toEqual([HOT_BEHIND_COMMITS, HANDOFF_COMMITS_LIMIT]);
    for (const path of ['/Users/me/my-app/.claude/worktrees/x_1', '/tmp/Проект с пробелом']) expect(script.projectLogDirName(path)).toBe(projectLogDirName(path));
  });

  it('пять слов те же, что у archive', async () => {
    const { OPEN_MARK_RE, openMarkTitles } = await week();
    expect(await readFile(join(process.cwd(), 'src/core/archive/plan.ts'), 'utf8')).toContain(OPEN_MARK_RE.source);
    expect(openMarkTitles('### A\n\nоткрыто\n\n### B\n\n```\nUNKNOWN\n```\n\n~~~\n```\nHYPOTHESIS\n~~~\n\n### Открыто: C\n\nтекст\n')).toEqual(['A', 'Открыто: C']);
  });

  it('разделители Windows в именах', async () => {
    const { leafName, posixPath } = await week();
    expect(leafName('C:\\Users\\me\\my-app\\')).toBe('my-app');
    expect(leafName('/Users/me/my-app')).toBe('my-app');
    expect(posixPath('wiki\\handoffs\\2026-10-12-close.md')).toBe('wiki/handoffs/2026-10-12-close.md');
  });

  it('скрипта нет в пакете', async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files.filter((item) => item.startsWith('scripts'))).toEqual([]);
    const npm = process.env.npm_execpath;
    if (npm === undefined || !npm.endsWith('.js') && !npm.endsWith('.cjs')) return;
    const packed = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', cwd: process.cwd(), maxBuffer: 2 ** 28 });
    expect(packed.status).toBe(0);
    const [info] = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
    expect((info?.files ?? []).map((file) => file.path).filter((path) => path.includes('week-stats'))).toEqual([]);
  });
});
