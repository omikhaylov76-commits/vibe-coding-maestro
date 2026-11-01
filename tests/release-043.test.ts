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
