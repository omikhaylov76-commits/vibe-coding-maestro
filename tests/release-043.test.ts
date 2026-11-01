import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
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

/**
 * Разбор подмножества YAML, которым написан образец настройки проверок: блочные словари и
 * списки с отступом в два пробела, строки и списки в квадратных скобках. Чужое — ошибка.
 */
function parseYamlSubset(text: string): unknown {
  const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  for (const line of lines) expect(line, 'без табуляции').not.toMatch(/\t/);
  const scalar = (raw: string): unknown => {
    const value = raw.trim();
    if (value.startsWith('[')) {
      expect(value.endsWith(']'), value).toBe(true);
      return value.slice(1, -1).split(',').map((item) => item.trim().replace(/^'(.*)'$/, '$1')).filter((item) => item !== '');
    }
    return value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  };
  let index = 0;
  const block = (indent: number): unknown => {
    const first = lines[index] as string;
    const isList = first.slice(indent).startsWith('- ');
    const result: unknown[] | Record<string, unknown> = isList ? [] : {};
    while (index < lines.length) {
      const line = lines[index] as string;
      const own = line.length - line.trimStart().length;
      if (own < indent) break;
      expect(own, `отступ: ${line}`).toBe(indent);
      if (isList) {
        expect(line.slice(indent).startsWith('- '), line).toBe(true);
        // Элемент списка «- key: value» — словарь, его ключи идут с отступом indent + 2.
        lines[index] = `${' '.repeat(indent + 2)}${line.slice(indent + 2)}`;
        (result as unknown[]).push(/^[\w-]+:( |$)/.test(line.slice(indent + 2)) ? block(indent + 2) : scalar(line.slice(indent + 2)));
        if (!/^[\w-]+:( |$)/.test(line.slice(indent + 2))) index += 1;
        continue;
      }
      const match = /^([\w-]+):(?: (.*))?$/.exec(line.slice(indent));
      expect(match, `строка словаря: ${line}`).not.toBeNull();
      index += 1;
      const [, key, value] = match as RegExpExecArray;
      (result as Record<string, unknown>)[key as string] = value === undefined ? block(indent + 2) : scalar(value);
    }
    return result;
  };
  const parsed = block(0);
  expect(index, 'разобраны все строки').toBe(lines.length);
  return parsed;
}

describe('0.4.3: маленькая задача, метки, новая сессия, проверки на GitHub, Icebox', () => {
  const template = (path: string): Promise<string> => packageText(`templates/project/${path}`);
  const SESSION = 'Новую сессию советует `npx --package create-vibe-maestro@{{MAESTRO_VERSION}} vibe-maestro context --path .`: по его выводу простыми словами скажи человеку, пора ли в новую сессию — она начнёт с `wiki/hot.md` и последней передачи, а не с пересылки всей истории.';

  it('одна и та же фраза о новой сессии в четырёх местах; «всегда новая сессия после утверждения» ушло', async () => {
    for (const path of ['.claude/rules/maestro.md', 'protocols/handoff.md', 'protocols/build.md', 'protocols/plan.md']) {
      expect(await template(path), path).toContain(SESSION);
    }
    expect(await template('protocols/plan.md')).not.toContain('Работу по утверждённому плану начинай в новой сессии');
  });

  it('метки: одна таблица в plan.md, те же шесть в шаблоне плана, в разговоре — три со ссылкой на таблицу', async () => {
    const labels = [
      ['FACT', 'Факт'], ['HUMAN_DECISION', 'Решение человека'], ['HYPOTHESIS', 'Гипотеза'],
      ['AGENT_PROPOSAL', 'Предложение агента'], ['OPEN_QUESTION', 'Открытый вопрос'], ['UNKNOWN', 'Неизвестно'],
    ] as const;
    const plan = await template('protocols/plan.md');
    const rows = [...plan.matchAll(/^\| `([A-Z_]+)` \| ([^|]+) \| [^|]+ \|$/gm)].map((match) => [match[1], (match[2] as string).trim()]);
    expect(rows).toEqual(labels.map(([label, name]) => [label, name]));
    const known = await template('wiki/plans/TEMPLATE.md');
    const section = known.slice(known.indexOf('## Что известно'), known.indexOf('## Как проверим'));
    expect([...section.matchAll(/^- \*\*([^*]+)\*\* \(`([A-Z_]+)`\)/gm)].map((match) => [match[2], match[1]])).toEqual(labels.map(([label, name]) => [label, name]));
    const rules = await template('.claude/rules/maestro.md');
    expect(rules).toContain('FACT (и чем проверено) / HYPOTHESIS (и как проверить) / UNKNOWN');
    expect(rules).toContain('полная таблица меток для плана — `protocols/plan.md`, Stage A');
  });

  it('QUICK: мини-план в wiki/plans/, нигде не отправлен в wiki/progress/; маленькая правка при активном плане — новой порцией', async () => {
    const plan = await template('protocols/plan.md');
    expect(plan).toContain('- `QUICK` — мини-план без бюрократии там же, где все планы: `wiki/plans/<номер>-<слаг>.md` с `kind: mini` и `scale: quick`');
    expect(plan).toContain('«добавляю правку: что именно, что это значит для вас; делаем?»');
    expect(plan).toContain('План `FEATURE` и крупнее обязан определить');
    expect(plan).not.toContain('--scale quick');
    for (const file of await listFiles(join(process.cwd(), 'templates/project'))) {
      const text = await template(file);
      for (const line of text.split('\n').filter((item) => /QUICK|мини-план/.test(item))) {
        expect(line, `${file}: ${line}`).not.toMatch(/progress/);
      }
    }
    expect(await template('protocols/build.md')).toContain('`QUICK` — один подтверждённый красный тест на весь набор правок');
    expect(await template('protocols/completion.md')).toContain('Проект из одной маленькой задачи (`QUICK`) завершается тем же путём');
  });

  it('проверки на GitHub: все правила, в том числе «после отправки не жди», — в build.md и коротко в правилах Maestro', async () => {
    const build = await template('protocols/build.md');
    const github = build.slice(build.indexOf('## Проверки на GitHub'), build.indexOf('<a id="VCM-HUMAN-AUTHORITY">'));
    for (const rule of [
      'проверь на компьютере теми же командами, что и на GitHub, до отправки',
      'отправляй пачкой после закрытой порции, а не после каждого коммита',
      'не отправляй, пока идёт прошлый прогон: посмотри один раз',
      'не чаще раза за закрытую порцию и никогда вместо локальной',
      'после отправки не жди и не опрашивай проверку — работай дальше',
      'ждать по-настоящему — только перед слиянием, один раз',
      'сколько проверок на сервере запускал и зачем',
      'Расписание (`schedule`) — только по решению человека о стоимости',
    ]) expect(github, rule).toContain(rule);
    const rules = await template('.claude/rules/maestro.md');
    for (const rule of ['проверь на компьютере теми же командами до отправки', 'отправляй пачкой после закрытой порции', 'после отправки не жди и не опрашивай проверку — работай дальше']) {
      expect(rules, rule).toContain(rule);
    }
    expect(await template('protocols/handoff.md')).toContain('после отправки не жди проверку');
  });

  it('образец настройки проверок — разбираемый YAML: отмена устаревших прогонов, быстрый на ветке, полный на pull request', async () => {
    const build = await template('protocols/build.md');
    const yaml = /```yaml\n([\s\S]*?)```/.exec(build)?.[1] ?? '';
    const config = parseYamlSubset(yaml) as Record<string, any>;
    expect(config.concurrency['cancel-in-progress']).toBe('true');
    expect(config.concurrency.group).toBe('${{ github.workflow }}-${{ github.ref }}');
    expect(config.on.push['branches-ignore']).toEqual(['main']);
    expect(config.on.pull_request.branches).toEqual(['main']);
    for (const event of ['push', 'pull_request']) expect(config.on[event]['paths-ignore']).toEqual(['wiki/**', 'maestro/**', 'docs/**', '**/*.md']);
    expect(config.jobs.quick.if).toBe("github.event_name == 'push'");
    expect(config.jobs.full.if).toBe("github.event_name == 'pull_request'");
    expect(config.on.schedule).toBeUndefined();
    // Выражения GitHub `${{ … }}` переживают рендер шаблона как есть.
    const { initProject } = await import('../src/core/init.js');
    const { FIXED_NOW, makeTempDir } = await import('./helpers.js');
    const root = join(await makeTempDir('release-043-gh-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    expect(await readFile(join(root, 'protocols/build.md'), 'utf8')).toContain('group: ${{ github.workflow }}-${{ github.ref }}');
  });

  it('settings.json шаблона: защиты с вопросом (ask) — как в 0.4.2; в deny добавлена только защита образца отчёта', async () => {
    type Settings = { permissions: { deny: string[]; ask: string[] } };
    const now = JSON.parse(await template('.claude/settings.json')) as Settings;
    const { execFileSync } = await import('node:child_process');
    const before = JSON.parse(execFileSync('git', ['show', 'v0.4.2:templates/project/.claude/settings.json'], { encoding: 'utf8' })) as Settings;
    expect(now.permissions.ask).toEqual(before.permissions.ask);
    expect(now.permissions.deny.filter((rule) => !before.permissions.deny.includes(rule))).toEqual(['Edit(/maestro/templates/audit.md)']);
    expect(before.permissions.deny.filter((rule) => !now.permissions.deny.includes(rule))).toEqual([]);
    expect(JSON.stringify(now)).not.toContain('gh workflow');
  });

  it('спрашивать только понятное человеку: правило в maestro.md, и ни один файл Maestro не просит «да» на тесты и проверки', async () => {
    const rules = await template('.claude/rules/maestro.md');
    expect(rules).toContain('Спрашивай «да» только о том, что человек понимает и за что отвечает');
    expect(rules).toContain('Тесты, проверки плана и кода, перепроверку исправлений и проверки на GitHub делай сам по правилам Maestro, без вопросов');
    expect(rules).toContain('итог простыми словами в две-три строки');
    expect(rules.split('\n').length).toBeLessThanOrEqual(45);
    const files = (await listFiles(join(process.cwd(), 'templates/project'))).filter((path) => /^(protocols|\.claude|maestro)\//.test(path) && path.endsWith('.md'));
    for (const file of files) {
      for (const sentence of (await template(file)).split(/(?<=[.!?])\s+|\n/)) {
        // Фразы, где проверки агент делает сам («без вопросов», «— сам»), — то самое правило, а не просьба «да».
        if (!sentence.includes('«да»') || sentence.includes('без вопросов') || /запускать проверки — сам/.test(sentence)) continue;
        expect(sentence, `${file}: «да» на проверку`).not.toMatch(/тест|проверк|провер[яи]|GitHub|\bCI\b|ревью|аудит/i);
      }
    }
    const handoff = await template('maestro/templates/handoff.md');
    expect(handoff.indexOf('## Итог для человека')).toBeLessThan(handoff.indexOf('## Состояние'));
    expect(await template('protocols/handoff.md')).toContain('Скажи человеку итог порции простыми словами, в две-три строки');
  });

  it('Icebox — файл проекта wiki/icebox.md: create кладёт, upgrade приносит, свой не трогает', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) expect(canonicalOwnershipInventory(depth)['wiki/icebox.md'], depth).toBe('project-owned');
    const icebox = await template('wiki/icebox.md');
    expect(icebox).toContain('| Идея | Почему отложена | Когда вернуться |');
    expect(await template('protocols/wiki.md')).toContain('фиксируй в `wiki/icebox.md`: идея, почему отложена, когда вернуться');
    expect(await template('wiki/index.md')).toContain('[icebox.md](icebox.md)');

    const { root } = await materializePublished('0.4.1-standard');
    expect((await analyzeUpgrade(root)).analysis.creates.map((item) => item.path)).toContain('wiki/icebox.md');
    const { root: own } = await materializePublished('0.4.1-standard');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(own, 'wiki/icebox.md'), '# Наши идеи\n', 'utf8');
    const { analysis } = await analyzeUpgrade(own);
    expect(analysis.creates.map((item) => item.path)).not.toContain('wiki/icebox.md');
    expect(analysis.preserves).toContain('wiki/icebox.md');
  });
});

describe('0.4.3: галочки не сбивают отпечаток утверждения', () => {
  const PLAN = 'wiki/plans/0002-quick.md';
  const ITEMS = '## Как проверим\n\n- [ ] тест входа зелёный\n- [ ] doctor зелёный\n';

  /** Утверждённый объявленный мини-план; `digestOf` — каким способом посчитан отпечаток. */
  async function approved(body: string, digestOf: (text: string) => string): Promise<string> {
    const { initProject } = await import('../src/core/init.js');
    const { FIXED_NOW, makeTempDir, readUtf8 } = await import('./helpers.js');
    const { writeFile } = await import('node:fs/promises');
    const root = join(await makeTempDir('release-043-plan-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    let text = [
      '---', 'type: plan', 'title: Вход', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension',
      'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', 'sources: []',
      'supersedes: null', 'approved_by: Человек', 'approved_at: 2026-11-01', 'active_phase: null', 'blocking_questions: 0',
      'spec_delta: none', 'current_slice: 01-vhod', '---', '', '# Вход', '', body,
    ].join('\n');
    text = text.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${digestOf(text)}`);
    await writeFile(join(root, PLAN), text, 'utf8');
    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-quick.md'), 'utf8');
    return root;
  }

  async function gate(root: string): Promise<{ preflight: number; doctor: string[] }> {
    const cli = collectIo();
    return {
      preflight: await runMaestroCli(['preflight', '--path', root], cli.io),
      doctor: (await doctorProject(root)).findings.map((item) => item.code),
    };
  }

  async function edit(root: string, from: string, to: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const text = await readFile(join(root, PLAN), 'utf8');
    expect(text).toContain(from);
    await writeFile(join(root, PLAN), text.replace(from, to), 'utf8');
  }

  it('отметка [x] после утверждения: preflight разрешает, doctor зелёный; правка текста пункта закрывает гейт', async () => {
    const { planBodyDigest } = await import('../src/core/plan.js');
    const root = await approved(ITEMS, planBodyDigest);
    expect(await gate(root)).toEqual({ preflight: 0, doctor: [] });
    await edit(root, '- [ ] тест входа зелёный', '- [x] тест входа зелёный');
    await edit(root, '- [ ] doctor зелёный', '- [X] doctor зелёный');
    expect(await gate(root)).toEqual({ preflight: 0, doctor: [] });
    await edit(root, '- [x] тест входа зелёный', '- [x] тест входа и выхода зелёный');
    const changed = await gate(root);
    expect(changed.preflight).not.toBe(0);
    expect(changed.doctor).toContain('plan-changed-after-approval');
  });

  it('[x] вне пункта списка — текст плана: его правка по-прежнему закрывает гейт', async () => {
    const { planBodyDigest } = await import('../src/core/plan.js');
    const root = await approved(`${ITEMS}\nОбозначение [ ] в тексте.\n`, planBodyDigest);
    await edit(root, 'Обозначение [ ] в тексте.', 'Обозначение [x] в тексте.');
    expect((await gate(root)).doctor).toContain('plan-changed-after-approval');
  });

  it('план, утверждённый отпечатком 0.4.2, без правок — зелёный; с [x] при утверждении и без правок — тоже', async () => {
    const { legacyPlanBodyDigest } = await import('../src/core/plan.js');
    // Опора: отпечаток 0.4.2 — это ровно прежний способ счёта (sha256 классификации и текста как есть).
    const { execFileSync } = await import('node:child_process');
    expect(execFileSync('git', ['show', 'v0.4.2:src/core/plan.ts'], { encoding: 'utf8' })).toContain("return createHash('sha256').update(`${classification}\\n---\\n${body}`).digest('hex');");
    expect(await gate(await approved(ITEMS, legacyPlanBodyDigest))).toEqual({ preflight: 0, doctor: [] });
    const ticked = ITEMS.replace('- [ ] тест входа', '- [x] тест входа');
    expect(await gate(await approved(ticked, legacyPlanBodyDigest))).toEqual({ preflight: 0, doctor: [] });
  });

  it('шаблон плана: критерии «готово» — списком с [ ]; README планов говорит, что отметки не входят в отпечаток', async () => {
    const template = await packageText('templates/project/wiki/plans/TEMPLATE.md');
    expect(template.slice(template.indexOf('## Как проверим'), template.indexOf('## Где правим'))).toMatch(/\n- \[ \] /);
    expect(await packageText('templates/project/wiki/plans/README.md')).toContain('Отметки `[x]` в пунктах списка тоже не входят');
  });
});

describe('0.4.3: pack — папка, состав до упаковки, подсветка, пароли по паспорту', () => {
  const execGit = async (cwd: string, ...args: string[]): Promise<string> => {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'tag.gpgSign=false', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' });
  };

  /** Паспорт со всеми разделами; `access` — содержимое разделов о доступах. */
  const passport = (access: Record<string, string> = {}): string => [
    '# Паспорт проекта', '',
    '## Репозиторий', '', '- Адрес: github.com/example/site (закрытый)', '- Основная ветка: main', '- Тег сдачи: v1.0.0', '',
    '## Где работает', '', access['Где работает'] ?? '- Хостинг, проект, сервис, регион: не применимо\n- Адрес в интернете: не применимо', '',
    '## Домен и DNS', '', access['Домен и DNS'] ?? '- Не применимо', '',
    '## Данные, базы, резервные копии', '', access['Данные'] ?? '- не применимо', '',
    '## Внешние сервисы и чей аккаунт', '', access['Сервисы'] ?? '- не применимо', '',
    '## Переменные окружения', '', 'Только имена и где задаются (`.env`, панель хостинга), значения — никогда.', '', access['Переменные'] ?? '- не применимо', '',
    '## Расписания и фоновые задачи', '', '- не применимо', '',
    '## Как запустить, обновить, откатить', '', '- Запустить: открыть index.html', '- Обновить: заменить файлы', '- Откатить: прежний архив', '',
  ].join('\n');

  async function delivered(files: Record<string, string>, passportText = passport()): Promise<string> {
    const { initProject } = await import('../src/core/init.js');
    const { FIXED_NOW, makeTempDir } = await import('./helpers.js');
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const root = join(await makeTempDir('release-043-pack-'), 'Сайт');
    expect((await initProject({ target: root, name: 'Сайт', startingPoint: 'idea', git: true, now: FIXED_NOW })).ok).toBe(true);
    for (const [path, content] of Object.entries({ 'wiki/passport.md': passportText, ...files })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, 'utf8');
    }
    await execGit(root, 'add', '-A');
    for (const path of Object.keys(files)) await execGit(root, 'add', '-f', path);
    await execGit(root, 'commit', '-qm', 'сдача');
    await execGit(root, 'tag', '-a', 'v1.0.0', '-m', 'Сдача');
    return root;
  }

  it('--out с / или \\ на конце — папка: создаётся, архив в ней под именем по умолчанию', async () => {
    const root = await delivered({ 'index.html': '<h1>Сайт</h1>\n' });
    const { makeTempDir } = await import('./helpers.js');
    for (const ending of ['/', '\\']) {
      const dir = join(await makeTempDir('out-dir-'), 'dist');
      const cli = collectIo();
      expect(await runMaestroCli(['pack', '--path', root, '--tag', 'v1.0.0', '--out', `${dir}${ending}`], cli.io), cli.stderr()).toBe(0);
      expect(existsSync(join(dir, 'Сайт-v1.0.0.zip')), ending).toBe(true);
      expect(cli.stdout()).toContain(join(dir, 'Сайт-v1.0.0.zip'));
    }
  });

  it('--dry-run не пишет ни байта и показывает тот же состав, что потом в архиве; повтор тега — тот же sha256', async () => {
    const root = await delivered({ 'index.html': '<h1>Сайт</h1>\n', 'docs/для-заказчика.md': '# Как пользоваться\n' });
    const { makeTempDir } = await import('./helpers.js');
    const { readdir } = await import('node:fs/promises');
    const parent = await makeTempDir('dry-');
    const before = await snapshotTree(root);
    const cli = collectIo();
    expect(await runMaestroCli(['pack', '--path', root, '--tag', 'v1.0.0', '--out', join(parent, 'a.zip'), '--dry-run'], cli.io), cli.stderr()).toBe(0);
    expect(await snapshotTree(root)).toEqual(before);
    expect(await readdir(parent)).toEqual([]);
    expect(cli.stdout()).toContain('ничего не записано');
    expect(cli.stdout()).toContain('только после «да» человека');

    const { packProject } = await import('../src/core/pack.js');
    const { readZip } = await import('../src/core/zip.js');
    const dry = await packProject({ root, tag: 'v1.0.0', out: join(parent, 'a.zip'), dryRun: true });
    const real = await packProject({ root, tag: 'v1.0.0', out: join(parent, 'a.zip') });
    expect(real.ok).toBe(true);
    expect(readZip(await readFile(join(parent, 'a.zip'))).map((entry) => entry.path)).toEqual(dry.entries);
    expect(dry.files).toBe(real.files);
    expect(dry.highlights).toEqual(real.highlights);
    const again = await packProject({ root, tag: 'v1.0.0', out: join(parent, 'b.zip') });
    expect(again.sha256).toBe(real.sha256);
  });

  it('подсветка ловит каждую группу и не трогает чистый файл; упаковка не запрещается', async () => {
    const files = {
      'src/home.js': 'const cache = "/Users/someone/cache";\n',
      'src/win.js': 'const cache = "C:\\\\Users\\\\someone\\\\cache";\n'.replace(/\\\\/g, '\\'),
      'src/tmp.js': 'const t = "/tmp/build";\nconst v = "/private/var/folders/x";\n',
      'docs/about.md': 'Сделано с Vibe Coding Maestro.\n',
      'docs/cmd.md': 'Запуск: npx vibe-maestro doctor\n',
      'docs/internal.md': 'Подробности — в wiki/plans и protocols/build.md.\n',
      'docs/agent.md': 'Настройки лежат в .claude/settings.json.\n',
      'docs/plan.md': 'Это сделано по план 0002.\n',
      'src/plan-id.js': '// PLAN-0002\n',
      '.vscode/settings.json': '{}\n',
      '.idea/workspace.xml': '<project/>\n',
      '.github/workflows/ci.yml': 'name: ci\n',
      'debug.log': 'ok\n',
      'src/clean.js': 'export const answer = 42; // vibe, maestro, wiki — просто слова\n',
    };
    const root = await delivered(files);
    const { packProject } = await import('../src/core/pack.js');
    const result = await packProject({ root, tag: 'v1.0.0', out: join(root, '..', 'x.zip'), dryRun: true, home: '/Users/someone' });
    expect(result.ok).toBe(true);
    const reasons = (path: string): string[] => (result.highlights ?? []).filter((item) => item.path === path).map((item) => item.reason);
    expect(reasons('src/home.js')).toEqual(['путь домашней папки']);
    expect(reasons('src/win.js')).toEqual(['путь домашней папки']);
    expect(reasons('src/tmp.js')).toEqual(['временная папка']);
    expect(reasons('docs/about.md')).toEqual(['имя Maestro']);
    expect(reasons('docs/cmd.md')).toEqual(['имя Maestro']);
    expect(reasons('docs/internal.md')).toEqual(['внутренняя папка']);
    expect(reasons('docs/agent.md')).toEqual(['внутренняя папка']);
    expect(reasons('docs/plan.md')).toEqual(['номер плана']);
    expect(reasons('src/plan-id.js')).toEqual(['номер плана']);
    for (const path of ['.vscode/settings.json', '.idea/workspace.xml', '.github/workflows/ci.yml', 'debug.log']) {
      expect(reasons(path), path).toEqual(['служебный файл']);
    }
    // Файлы, которые кладёт сам Maestro, тоже служебные (в .gitignore ещё и строки про .claude/).
    for (const path of ['.gitignore', '.gitattributes']) expect(reasons(path), path).toContain('служебный файл');
    expect(reasons('src/clean.js')).toEqual([]);
    expect(reasons('index.html')).toEqual([]);
    // Строка, где найдено, названа.
    expect(result.highlights).toContainEqual({ path: 'src/tmp.js', reason: 'временная папка', line: 1 });

    // Путь самого проекта называется точнее, чем «домашняя папка».
    const own = await delivered({ 'src/where.js': '' });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(own, 'src/where.js'), `const here = ${JSON.stringify(own)};\n`, 'utf8');
    await execGit(own, 'commit', '-qam', 'путь');
    await execGit(own, 'tag', '-a', 'v1.0.1', '-m', 'x');
    const where = await packProject({ root: own, tag: 'v1.0.1', out: join(own, '..', 'y.zip'), dryRun: true, home: dirname(dirname(own)) });
    expect((where.highlights ?? []).filter((item) => item.path === 'src/where.js').map((item) => item.reason)).toEqual(['путь папки проекта']);

    // Обычный pack печатает подсвеченное и пакует с прежним кодом выхода.
    const cli = collectIo();
    expect(await runMaestroCli(['pack', '--path', root, '--tag', 'v1.0.0', '--out', join(root, '..', 'z.zip')], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('Подсвечено — проверьте перед отправкой');
    expect(cli.stdout()).toContain('docs/about.md — имя Maestro (строка 1)');
  });

  it('HANDOVER.md: все разделы о доступах «не применимо» — «доступов не было»; хоть одна запись — прежний текст', async () => {
    const { handoverText, passportHasNoAccess } = await import('../src/core/pack.js');
    const none = handoverText({ projectName: 'Сайт', tag: 'v1', commit: 'abc', passport: passport() });
    expect(passportHasNoAccess(passport())).toBe(true);
    expect(none).toContain('Доступов не было, менять нечего');
    expect(none).not.toContain('смените все пароли и ключи');
    for (const [section, text] of [
      ['Где работает', '- Хостинг: Netlify, проект site'],
      ['Домен и DNS', '- site.example.com у регистратора'],
      ['Данные', '- Таблица в Google Sheets заказчика'],
      ['Сервисы', '- Форма Formspree — аккаунт заказчика'],
      ['Переменные', '- FORM_ID — панель Netlify'],
      ['Переменные', 'Ключей нет, кроме одного в панели'],
    ] as const) {
      const text2 = passport({ [section]: text });
      expect(passportHasNoAccess(text2), `${section}: ${text}`).toBe(false);
      expect(handoverText({ projectName: 'Сайт', tag: 'v1', commit: 'abc', passport: text2 }), section).toContain('## Первым делом: смените все пароли и ключи');
    }

    const root = await delivered({ 'index.html': '<h1>Сайт</h1>\n' });
    const cli = collectIo();
    expect(await runMaestroCli(['pack', '--path', root, '--tag', 'v1.0.0', '--out', join(root, '..', 'h.zip')], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('HANDOVER.md: доступов не было, менять заказчику нечего');
    const { readZip } = await import('../src/core/zip.js');
    const handover = readZip(await readFile(join(root, '..', 'h.zip'))).find((entry) => entry.path === 'HANDOVER.md')?.data.toString('utf8') ?? '';
    expect(handover).toContain('## Доступы');
  });

  it('протокол завершения: сначала --dry-run, состав проверяет агент, человеку — итог; упаковка и отправка — по «да»', async () => {
    const completion = await packageText('templates/project/protocols/completion.md');
    expect(completion).toContain('vibe-maestro pack --path . --tag vX.Y.Z --dry-run');
    expect(completion).toContain('человеку — итог: сколько файлов, что убрано, что осталось под вопросом');
    expect(completion.indexOf('--dry-run')).toBeLessThan(completion.indexOf('Архив для заказчика — после «да» человека'));
    expect(completion).toContain('отправка заказчику — отдельное «да»');
    expect(completion).toContain('«доступов не было»');
  });
});
