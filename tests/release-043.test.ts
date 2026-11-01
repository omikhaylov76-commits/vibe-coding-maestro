import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import { analyzeUpgrade } from '../src/core/upgrade/index.js';
import { REMOVED_PATHS } from '../src/core/upgrade/releases.js';
import { cleanupTempDirs, listFiles, snapshotTree } from './helpers.js';
import { collectIo, materializePublished } from './published.js';

/** Файл пакета с LF: в checkout на Windows он может прийти с CRLF. */
const packageText = async (path: string): Promise<string> => (await readFile(join(process.cwd(), path), 'utf8')).replace(/\r\n/g, '\n');

afterEach(cleanupTempDirs);

/** Строки текста без пустой строки после последнего перевода. */
const linesOf = (text: string): string[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/** Разбирает вывод `upgrade --diff` на файлы: заголовок `=== …: путь (…)` и строки кусков. */
function diffSections(output: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of output.split('\n')) {
    const header = /^=== [^:]+: (\S+)/.exec(line);
    if (header !== null) {
      current = [];
      sections.set(header[1] as string, current);
    } else if (line === '') {
      current = null;
    } else if (current !== null) {
      current.push(line);
    }
  }
  return sections;
}

/** Применяет куски unified diff к прежнему тексту. */
function applyUnified(before: string[], body: string[]): string[] {
  const out: string[] = [];
  let next = 0;
  for (const line of body) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (header !== null) {
      const oldStart = Number(header[1]);
      const start = Number(header[2]) === 0 ? oldStart : oldStart - 1;
      out.push(...before.slice(next, start));
      next = start;
      continue;
    }
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') { out.push(text); continue; }
    expect(before[next], `строка «${text}» есть в прежнем тексте`).toBe(text);
    if (mark === ' ') out.push(text);
    next += 1;
  }
  return [...out, ...before.slice(next)];
}

describe('0.4.3: upgrade --diff показывает сами правки', () => {
  it('на проекте 0.4.1: каждая правка, применённая к прежнему файлу, даёт ровно новый текст; ни байта не записано', async () => {
    const { root } = await materializePublished('0.4.1-standard');
    const before = await snapshotTree(root);
    const plan = await analyzeUpgrade(root);
    const cli = collectIo();
    expect(await runMaestroCli(['upgrade', '--path', root, '--diff'], cli.io)).toBe(0);
    expect(await snapshotTree(root)).toEqual(before);

    const sections = diffSections(cli.stdout());
    const files = plan.writes.filter((write) => !plan.analysis.metadata.includes(write.path));
    expect([...sections.keys()].sort()).toEqual(files.map((write) => write.path).sort());
    for (const write of files) {
      const old = write.action === 'create' ? [] : linesOf(await readFile(join(root, write.path), 'utf8'));
      const next = write.action === 'remove' ? [] : linesOf(write.content);
      expect(applyUnified(old, sections.get(write.path) ?? []), write.path).toEqual(next);
    }
    expect(cli.stdout()).toContain('=== Будет обновлено: protocols/plan.md (строк: +');
    expect(cli.stdout()).toContain('=== Будет добавлено: protocols/start.md (строк: +');
    expect(cli.stdout()).not.toContain('=== Будет обновлено: .maestro/manifest.json');
    expect(cli.stdout()).toContain('upgrade --path');
    expect(cli.stdout()).toContain('--apply');
  });

  it('без флага — прежний список плюс число строк у каждого файла и подсказка про --diff', async () => {
    const { root } = await materializePublished('0.4.1-standard');
    const cli = collectIo();
    expect(await runMaestroCli(['upgrade', '--path', root], cli.io)).toBe(0);
    expect(cli.stdout()).toMatch(/\n {2}protocols\/plan\.md \(строк: \+\d+ -\d+\)\n/);
    expect(cli.stdout()).toMatch(/\n {2}protocols\/start\.md \(строк: \+\d+\)\n/);
    expect(cli.stdout()).toContain('Сами правки построчно:');
    expect(cli.stdout()).not.toContain('@@ -');
  });

  it('--diff только для upgrade и не сочетается с --apply и --json', async () => {
    const { root } = await materializePublished('0.4.1-standard');
    const before = await snapshotTree(root);
    for (const args of [['--diff', '--apply'], ['--apply', '--diff'], ['--diff', '--json']]) {
      const cli = collectIo();
      expect(await runMaestroCli(['upgrade', '--path', root, ...args], cli.io), args.join(' ')).toBe(2);
      expect(cli.stderr()).toContain('--diff');
    }
    const doctor = collectIo();
    expect(await runMaestroCli(['doctor', '--diff', '--path', root], doctor.io)).toBe(2);
    expect(doctor.stderr()).toContain('доступен только для upgrade');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('doctor на устаревшем проекте называет --diff', async () => {
    const { root } = await materializePublished('0.4.1-standard');
    const report = await doctorProject(root);
    const outdated = report.findings.find((item) => item.code === 'project-outdated');
    expect(outdated?.message).toContain('с --diff — сами правки построчно');
  });
});

/** Ссылки Markdown сравниваются по тексту: адрес переехавшего раздела другой. */
const withoutLinkTargets = (text: string): string => text.replace(/\]\([^)]*\)/g, ']');

describe('0.4.3: мелкие протоколы вошли в соседние', () => {
  const removed = Object.keys(REMOVED_PATHS).sort();

  it('убраны ровно 10 протоколов: в шаблоне и составе их нет', async () => {
    expect(removed).toEqual([
      'protocols/build/audit-phase.md', 'protocols/build/audit-plan.md', 'protocols/build/step-1-rules.md', 'protocols/build/step-2-spec.md',
      'protocols/build/step-3-architecture.md', 'protocols/build/step-5-feature-loop.md', 'protocols/context-budget.md', 'protocols/discovery.md',
      'protocols/lessons.md', 'protocols/seams.md',
    ]);
    for (const path of removed) {
      expect(existsSync(join(process.cwd(), 'templates/project', path)), path).toBe(false);
      for (const depth of ['light', 'standard', 'advanced'] as const) expect(canonicalOwnershipInventory(depth)[path], `${depth}: ${path}`).toBeUndefined();
    }
    expect(existsSync(join(process.cwd(), 'templates/project/protocols/build'))).toBe(false);
    expect((await listFiles(join(process.cwd(), 'templates/project/protocols'))).sort()).toEqual(
      ['audit.md', 'build.md', 'completion.md', 'handoff.md', 'plan.md', 'start.md', 'status.md', 'wiki.md'],
    );
  });

  it('каждый раздел с якорем переехал дословно к владельцу из реестра', async () => {
    const ledger = JSON.parse(await packageText('registry/capabilities.v1.json')) as { capabilities: { ownerPath: string | null; contractId: string | null }[] };
    const owners = new Map(ledger.capabilities.map((item) => [item.contractId, item.ownerPath]));
    let sections = 0;
    for (const path of removed) {
      const old = await packageText(`registry/baseline/0.4.2/project/${path}`);
      // Раздел: якорь, заголовок и абзац до пустой строки.
      for (const match of old.matchAll(/^(<a id="(VCM-[A-Z0-9-]+)"><\/a>\n## [^\n]+\n[^\n]+(?:\n[^\n]+)*)/gm)) {
        const id = match[2] as string;
        const owner = owners.get(id);
        expect(owner, id).toMatch(/^protocols\/(build|audit|wiki)\.md$/);
        const text = withoutLinkTargets(await packageText(`templates/project/${owner}`));
        expect(text, `${id} в ${owner}`).toContain(withoutLinkTargets(match[1] as string));
        sections += 1;
      }
    }
    // discovery.md с 0.4.2 только ссылался на старт: якорей в нём не было.
    expect(sections).toBe(19);
  });

  it('в шаблоне нет ссылок и путей на убранные протоколы', async () => {
    const root = join(process.cwd(), 'templates/project');
    for (const file of (await listFiles(root)).filter((path) => /\.(md|json)$/.test(path))) {
      const text = await packageText(`templates/project/${file}`);
      for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = posix.normalize(posix.join(posix.dirname(file), match[1] as string));
        expect(removed, `${file}: ссылка ${match[1]}`).not.toContain(target);
        if (!/^[a-z]+:/.test(match[1] as string)) expect(existsSync(join(root, target)), `${file}: битая ссылка ${match[1]}`).toBe(true);
      }
      for (const path of removed) expect(text, `${file}: ${path}`).not.toContain(path);
      expect(text, file).not.toContain('protocols/build/');
    }
  });
});

describe('0.4.3: проверки без лишнего круга — когда, насколько строго, шкала, отчёт', () => {
  const template = (path: string): Promise<string> => packageText(`templates/project/${path}`);

  /** Шкала для плана и кода: одна и та же в протоколе, у ревьюера и в prompt для Cowork. */
  const scale = async (): Promise<string> => {
    const audit = await template('protocols/audit.md');
    const block = /\n(- `critical` — [^\n]+\n- `high` — [^\n]+\n- `medium` — [^\n]+\n- `low` — [^\n]+)\n/.exec(audit)?.[1];
    expect(block, 'шкала в protocols/audit.md').toBeDefined();
    return block as string;
  };

  async function project(depth: 'light' | 'standard' | 'advanced' = 'standard'): Promise<string> {
    const { initProject } = await import('../src/core/init.js');
    const { FIXED_NOW, makeTempDir } = await import('./helpers.js');
    const root = join(await makeTempDir('release-043-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', depth, git: false, now: FIXED_NOW })).ok).toBe(true);
    return root;
  }

  async function report(root: string, text: string): Promise<{ codes: string[]; strict: string[] }> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(root, 'wiki/audits'), { recursive: true });
    await writeFile(join(root, 'wiki/audits/AUD-2026-11-01-proba.md'), text, 'utf8');
    return {
      codes: (await doctorProject(root)).findings.map((item) => item.code),
      strict: (await doctorProject(root, { strict: true })).findings.map((item) => item.code),
    };
  }

  it('одна шкала: в audit.md, у ревьюера и в Cowork-runbook дословно одна и та же', async () => {
    const block = await scale();
    expect(block).toContain('план: ');
    expect(block).toContain('код: ');
    for (const path of ['.claude/agents/code-reviewer.md', 'maestro/runbooks/cowork-audit.md']) {
      expect(await template(path), path).toContain(block);
    }
    // Уровни самого doctor — другое: протокол так и говорит.
    expect(await template('protocols/audit.md')).toContain('`critical`, `error`, `warning`, `info`');
  });

  it('образец отчёта — файл Maestro, защищён от правки, и сам по себе отчёт, который doctor принимает', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) expect(canonicalOwnershipInventory(depth)['maestro/templates/audit.md'], depth).toBe('managed');
    const settings = JSON.parse(await template('.claude/settings.json')) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain('Edit(/maestro/templates/audit.md)');

    const root = await project();
    const sample = await packageText('templates/project/maestro/templates/audit.md');
    // high закрыта после проверенного исправления, medium «не исправляем» открыта, low проверки исправлений — своя находка.
    expect(sample).toMatch(/- severity: high\n[^#]*- status: resolved\n- resolution: [^\n]*проверка исправления/);
    expect(sample).toMatch(/- severity: medium\n[^#]*- status: open\n- resolution: не исправляем — причина; где записано/);
    expect(sample).toMatch(/- evidence: найдено проверкой исправления F001/);
    const result = await report(root, sample);
    expect(result.codes).toEqual([]);
    expect(result.strict).toEqual([]);
  });

  it('открытая high — блокирующая находка; resolved-отчёт с открытой medium — неверный отчёт', async () => {
    const sample = await packageText('templates/project/maestro/templates/audit.md');
    const root = await project();
    const openHigh = sample.replace('- severity: high\n- target: src/файл.ts:42\n- evidence: что воспроизведено — команда, строка или наблюдение\n- status: resolved', '- severity: high\n- target: src/файл.ts:42\n- evidence: что воспроизведено — команда, строка или наблюдение\n- status: open');
    expect(openHigh).not.toBe(sample);
    expect((await report(root, openHigh)).codes).toContain('audit-blocking-finding');
    // «не исправляем» нельзя прятать в закрытом отчёте: resolved — только проверенное исправление.
    expect((await report(root, sample.replace('status: open\n---', 'status: resolved\n---'))).codes).toContain('audit-malformed');
  });

  it('проверку исправления нельзя писать отдельным разделом после находок — потому она в resolution', async () => {
    const sample = await packageText('templates/project/maestro/templates/audit.md');
    const root = await project();
    const tail = `${sample}\n## Проверка исправлений\n- status: проверено\n`;
    expect((await report(root, tail)).codes).toContain('audit-malformed');
    expect(await template('protocols/audit.md')).toContain('Проверка исправления — одной строкой в `resolution` той же находки');
  });

  it('один порядок проверок: аудит плана до утверждения, ревью после порции', async () => {
    const order = 'порция → тесты → ревью → исправления → проверка исправлений → передача';
    expect(await template('protocols/build.md')).toContain(order);
    expect(await template('protocols/audit.md')).toContain(order);
    const plan = await template('protocols/plan.md');
    const stageE = plan.slice(plan.indexOf('## Stage E'), plan.indexOf('## Stage F'));
    expect(stageE).toContain('Независимый аудит плана идёт до утверждения и до `preflight`');
    expect(await template('protocols/audit.md')).toContain('Аудит плана — до утверждения плана и до `preflight`; ревью кода — после порции');
    const router = await template('protocols/build.md');
    expect(router).toContain('[Аудит плана](audit.md#VCM-PLAN-AUDIT) идёт раньше — до утверждения плана');
    // Строже из двух — одной формулой в трёх местах.
    for (const path of ['protocols/build.md', 'protocols/audit.md', 'protocols/plan.md']) expect(await template(path), path).toContain('строже из двух');
    expect(plan).toContain('Governance плана не ниже depth проекта; ниже — действует depth.');
    expect(plan).not.toContain('он совпадает с depth проекта');
  });

  it('Stage D: проверка по углам на действующей ситуации для любого масштаба, повторно — только заметно изменённое', async () => {
    const plan = await template('protocols/plan.md');
    const stageD = plan.slice(plan.indexOf('## Stage D'), plan.indexOf('## Stage E'));
    expect(stageD).toContain('для любого масштаба, и для `QUICK`');
    expect(stageD).toContain('по файлу, коду или выводу команды');
    expect(stageD).toContain('опытом');
    expect(stageD).toContain('«Что известно»');
    expect(stageD).toContain('`OPEN_QUESTION`, а не правка');
    expect(stageD).toContain('подход, состав или порядок порций, границы, данные, безопасность, deployment');
    expect(plan).not.toContain('Один полный зелёный проход достаточен');
  });

  it('круг проверки: critical/high — исправить и проверить исправление, medium/low — исправить или записать и остановиться', async () => {
    const audit = await template('protocols/audit.md');
    expect(audit).toContain('Medium и low — исправь или запиши «не исправляем — причина; где записано»');
    expect(audit).toContain('Проверка исправлений нашла critical или high — исправь и проверь только это исправление');
    expect(audit).toContain('Нашла только medium и low — исправь или запиши и остановись');
    expect(audit).toContain('Проверка исправлений — одна на круг');
    expect(audit).toContain('Ничего не исправляли — проверять нечего');
    expect(audit).toContain('«проверь ещё раз» — проверка');
    expect(audit).toContain('`status: open` с `resolution: не исправляем — причина; где записано`');
    expect(audit).toContain('текст каждой находки из отчёта, файлы и строки исправления и сам текст изменений');
  });

  it('ревьюер: три вида работы, только читает, находки возвращает, файл не пишет', async () => {
    const reviewer = await template('.claude/agents/code-reviewer.md');
    expect(reviewer).toContain('tools: Read, Grep, Glob\n');
    for (const kind of ['- Ревью порции —', '- Аудит плана —', '- Проверка исправлений —']) expect(reviewer).toContain(kind);
    expect(reviewer).toContain('Файл отчёта не пиши');
    expect(reviewer).toContain('maestro/templates/audit.md');
  });

  it('открытые находки — в передаче порции и в итоге завершения', async () => {
    const handoff = await template('maestro/templates/handoff.md');
    const risks = handoff.slice(handoff.indexOf('## Риски и открытые вопросы'), handoff.indexOf('## Следующий шаг'));
    expect(risks).toContain('Открытые находки проверок');
    expect(await template('protocols/completion.md')).toContain('находки проверок «не исправляем»');
    expect(await template('maestro/runbooks/cowork-audit.md')).toContain('`resolution: не исправляем — причина; где записано`');
  });
});
