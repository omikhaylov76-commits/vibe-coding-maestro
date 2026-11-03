import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { archiveProject } from '../src/core/archive/index.js';
import { countChars, LOG_KEEP, LOG_LIMIT } from '../src/core/archive/limits.js';
import { rebaseLinks } from '../src/core/archive/links.js';
import { LOG_POINTER, parseLog } from '../src/core/archive/log.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { MANIFEST_PATH } from '../src/core/manifest.js';
import { ARCHIVE_STAGING_DIR, UPGRADE_STAGING_DIR } from '../src/core/transaction.js';
import { analyzeUpgrade, upgradeProject } from '../src/core/upgrade/index.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, snapshotTree } from './helpers.js';
import { collectIo, materializePublished } from './published.js';

afterEach(cleanupTempDirs);

async function project(): Promise<string> {
  const root = join(await makeTempDir('archive-'), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

/** Запись журнала примерно на `size` знаков со ссылкой на файл проекта. */
function entry(date: string, title: string, size = 900): string {
  const body = `- **Что сделано** — ${title}; план — [plans/0001-starter.md](plans/0001-starter.md), правила — [README](plans/README.md#отпечаток).\n`;
  return `## ${date} — ${title}\n\n${body}${'- подробность.\n'.repeat(Math.max(0, Math.floor((size - body.length) / 15)))}\n`;
}

/** Журнал шаблона и `count` записей: первые — октябрь, последние — ноябрь. */
async function writeLog(root: string, count: number, eol = '\n'): Promise<string> {
  const template = await readUtf8(root, 'wiki/log.md');
  const entries = Array.from({ length: count }, (_, index) => entry(index < count - 5 ? `2026-10-${String(1 + (index % 28)).padStart(2, '0')}` : `2026-11-0${1 + (index % 5)}`, `шаг ${index + 1}`));
  const text = `${template.replace(/\n*$/, '\n\n')}${entries.join('')}`.replace(/\n/g, eol);
  await writeFile(join(root, 'wiki/log.md'), text, 'utf8');
  return text;
}

describe('0.4.4 archive: разбор журнала', () => {
  it('запись — от «## дата» до следующей датированной; в блоке кода — не запись; дата в скобках — запись; без даты — едет с предыдущей', () => {
    const text = [
      '# Журнал', '', '```', '## ГГГГ-ММ-ДД — краткая суть', '```', '', '## Заметка без даты в шапке', '',
      '## 2026-10-12 — первая', '- а', '', '## Без даты — продолжение', '- б', '',
      '## [2026-10-19] build | вторая', '- в', '', '## 2026-11-01 — третья', '- г', '',
    ].join('\n');
    const parsed = parseLog(text);
    expect(parsed.preamble).toContain('## Заметка без даты в шапке');
    expect(parsed.entries.map((item) => item.month)).toEqual(['2026-10', '2026-10', '2026-11']);
    expect(parsed.entries[0]!.text).toContain('## Без даты — продолжение');
    expect(parsed.preamble + parsed.entries.map((item) => item.text).join('')).toBe(text);
  });
});

describe('0.4.4 archive: адреса ссылок', () => {
  it('файл переезжает на папку глубже — относительные адреса пересчитаны, остальное байт в байт', () => {
    const text = [
      '[передача](handoffs/2026-10-01-a.md) и [<с пробелом>](<handoffs/a b.md>) и [якорь](plans/README.md#отпечаток)',
      '[кириллица](plans/%D0%BF%D0%BB%D0%B0%D0%BD.md) [сайт](https://example.com/wiki/x) [только якорь](#раз) [наружу](../../x.md) [папка](log/)',
      '```', '[в блоке кода](decisions/adr.md)', '```',
    ].join('\n');
    const moved = rebaseLinks(text, 'wiki/log.md', 'wiki/log/2026-10.md');
    expect(moved).toBe([
      '[передача](../handoffs/2026-10-01-a.md) и [<с пробелом>](<../handoffs/a b.md>) и [якорь](../plans/README.md#отпечаток)',
      '[кириллица](../plans/%D0%BF%D0%BB%D0%B0%D0%BD.md) [сайт](https://example.com/wiki/x) [только якорь](#раз) [наружу](../../x.md) [папка](./)',
      '```', '[в блоке кода](../decisions/adr.md)', '```',
    ].join('\n'));
    expect(rebaseLinks(text, 'wiki/log.md', 'wiki/log.md')).toBe(text);
  });

  it('ссылка на перенесённый файл ведёт на новое место', () => {
    const moved = new Map([['wiki/audits/a.md', 'wiki/audits/archive/a.md']]);
    expect(rebaseLinks('[отчёт](../audits/a.md#F1) [другой](../audits/b.md)', 'wiki/handoffs/h.md', 'wiki/handoffs/h.md', moved))
      .toBe('[отчёт](../audits/archive/a.md#F1) [другой](../audits/b.md)');
  });
});

describe('0.4.4 archive: журнал по порогу', () => {
  it('журнал не больше порога — переносить нечего, ни байта', async () => {
    const root = await project();
    const before = await snapshotTree(root);
    const result = await archiveProject(root, { apply: true });
    expect(result).toMatchObject({ ok: true, applied: false, log: null, writes: [] });
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('без --apply — только предложение, ни байта; с --apply — старое в месяцах, последние записи остаются, текст байт в байт', async () => {
    const root = await project();
    const original = await writeLog(root, 40);
    expect(countChars(original)).toBeGreaterThan(LOG_LIMIT);
    const before = await snapshotTree(root);

    const dry = await archiveProject(root);
    expect(dry.ok).toBe(true);
    expect(dry.applied).toBe(false);
    expect(dry.writes).toEqual([
      { path: 'wiki/log.md', action: 'update' },
      { path: 'wiki/log/2026-10.md', action: 'create' },
    ]);
    expect(await snapshotTree(root)).toEqual(before);

    const applied = await archiveProject(root, { apply: true });
    expect(applied).toMatchObject({ ok: true, applied: true });
    const log = await readUtf8(root, 'wiki/log.md');
    const month = await readUtf8(root, 'wiki/log/2026-10.md');
    expect(log).toContain(LOG_POINTER);
    expect(month.startsWith('# Журнал: 2026-10\n')).toBe(true);

    const kept = parseLog(log).entries;
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.reduce((sum, item) => sum + countChars(item.text), 0)).toBeLessThanOrEqual(LOG_KEEP);
    expect(kept.length + applied.log!.movedEntries).toBe(40);
    // Каждая запись — ровно один раз; в месяце отличаются только адреса ссылок.
    const originalEntries = parseLog(original).entries.map((item) => item.text);
    const movedEntries = parseLog(month).entries.map((item) => item.text);
    expect(movedEntries).toEqual(originalEntries.slice(0, movedEntries.length).map((text) => text.replaceAll('](plans/', '](../plans/')));
    expect(kept.map((item) => item.text)).toEqual(originalEntries.slice(movedEntries.length));

    const doctor = await doctorProject(root);
    expect(doctor.findings.filter((item) => item.level !== 'info')).toEqual([]);

    const again = await archiveProject(root, { apply: true });
    expect(again.writes).toEqual([]);
  });

  it('записи двух месяцев расходятся по своим файлам, порядок прежний', async () => {
    const root = await project();
    const template = await readUtf8(root, 'wiki/log.md');
    const entries = Array.from({ length: 60 }, (_, index) => entry(index < 30 ? `2026-10-${String(index + 1).padStart(2, '0')}` : `2026-11-${String(index - 29).padStart(2, '0')}`, `шаг ${index + 1}`));
    await writeFile(join(root, 'wiki/log.md'), `${template}\n${entries.join('')}`, 'utf8');
    const result = await archiveProject(root, { apply: true });
    expect(result.log!.months.map((month) => month.path)).toEqual(['wiki/log/2026-10.md', 'wiki/log/2026-11.md']);
    expect(parseLog(await readUtf8(root, 'wiki/log/2026-10.md')).entries).toHaveLength(30);
    const november = parseLog(await readUtf8(root, 'wiki/log/2026-11.md')).entries.map((item) => item.text.split('\n')[0]);
    expect(november[0]).toBe('## 2026-11-01 — шаг 31');
    expect(november.length + parseLog(await readUtf8(root, 'wiki/log.md')).entries.length).toBe(30);
  });

  it('повторный перенос дописывает в тот же месяц, шапка журнала не дублируется', async () => {
    const root = await project();
    await writeLog(root, 40);
    await archiveProject(root, { apply: true });
    const firstMonth = await readUtf8(root, 'wiki/log/2026-10.md');
    const log = await readUtf8(root, 'wiki/log.md');
    await writeFile(join(root, 'wiki/log.md'), log + Array.from({ length: 30 }, (_, index) => entry(`2026-10-${String(index + 1).padStart(2, '0')}`, `поздняя ${index + 1}`)).join(''), 'utf8');
    const second = await archiveProject(root, { apply: true });
    expect(second.ok).toBe(true);
    const month = await readUtf8(root, 'wiki/log/2026-10.md');
    expect(month.startsWith(firstMonth)).toBe(true);
    expect(month.match(/^# Журнал/gm)).toHaveLength(1);
    expect((await readUtf8(root, 'wiki/log.md')).split(LOG_POINTER)).toHaveLength(2);
  });

  it('переносы строк CRLF сохраняются', async () => {
    const root = await project();
    await writeLog(root, 40, '\r\n');
    expect((await archiveProject(root, { apply: true })).ok).toBe(true);
    const month = await readFile(join(root, 'wiki/log/2026-10.md'), 'utf8');
    const log = await readFile(join(root, 'wiki/log.md'), 'utf8');
    expect(month.replace(/\r\n/g, '')).not.toContain('\n');
    expect(log.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('сбой посреди переноса — откат: дерево прежнее', async () => {
    const root = await project();
    await writeLog(root, 40);
    const before = await snapshotTree(root);
    const result = await archiveProject(root, {
      apply: true,
      hooks: { beforeCommit: async (path) => { if (path === 'wiki/log/2026-10.md') throw new Error('сбой для теста'); } },
    });
    expect(result).toMatchObject({ ok: false, rolledBack: true });
    expect(await snapshotTree(root)).toEqual(before);
    expect(existsSync(join(root, 'wiki/log'))).toBe(false);
  });
});

describe('0.4.4 archive: отказы до записи', () => {
  it('проект другой версии — сначала upgrade', async () => {
    const root = await project();
    await writeLog(root, 40);
    const manifest = JSON.parse(await readUtf8(root, MANIFEST_PATH)) as { product: { version: string } };
    manifest.product.version = '0.4.2';
    await writeFile(join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2), 'utf8');
    const before = await snapshotTree(root);
    const result = await archiveProject(root, { apply: true });
    expect(result.blockers.map((item) => item.code)).toEqual(['archive-version-mismatch']);
    expect(result.blockers[0]!.message).toContain('upgrade');
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('оставшаяся папка транзакции upgrade или archive — отказ и пробного запуска, и --apply', async () => {
    for (const staging of [UPGRADE_STAGING_DIR, ARCHIVE_STAGING_DIR]) {
      const root = await project();
      await writeLog(root, 40);
      await mkdir(join(root, staging, 'backup'), { recursive: true });
      for (const apply of [false, true]) {
        const result = await archiveProject(root, { apply });
        expect(result.blockers.map((item) => item.code), `${staging} apply=${apply}`).toEqual(['archive-staging-present']);
      }
      expect(existsSync(join(root, 'wiki/log'))).toBe(false);
    }
  });

  it('upgrade (пробный и --apply) отказывает, пока есть папка транзакции archive', async () => {
    const { root } = await materializePublished('0.4.2-standard');
    await mkdir(join(root, ARCHIVE_STAGING_DIR, 'backup'), { recursive: true });
    expect((await analyzeUpgrade(root)).analysis.blockers.map((item) => item.code)).toEqual(['upgrade-archive-staging-present']);
    const before = await snapshotTree(root);
    const result = await upgradeProject(root, { apply: true });
    expect(result.applied).toBe(false);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('папку назначения игнорирует git — отказ; проект без git — перенос работает', async () => {
    const root = await project();
    await writeLog(root, 40);
    execFileSync('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, '.gitignore'), `${await readUtf8(root, '.gitignore')}[Ll]og/\n`, 'utf8');
    const result = await archiveProject(root, { apply: true });
    expect(result.blockers).toEqual([expect.objectContaining({ code: 'archive-destination-ignored', path: 'wiki/log/2026-10.md' })]);
    expect(existsSync(join(root, 'wiki/log'))).toBe(false);

    const plain = await project();
    await writeLog(plain, 40);
    expect((await archiveProject(plain, { apply: true })).applied).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('папка архива — symbolic link наружу: отказ, снаружи ни байта', async () => {
    const root = await project();
    await writeLog(root, 40);
    const outside = await makeTempDir('outside-');
    await symlink(outside, join(root, 'wiki/log'));
    const result = await archiveProject(root, { apply: true });
    expect(result.blockers.map((item) => item.code)).toContain('archive-symlink');
    expect(existsSync(join(outside, '2026-10.md'))).toBe(false);
  });
});

describe('0.4.4 archive: команда', () => {
  it('без --apply — пробный запуск и команда для переноса; --apply переносит; --apply у doctor — ошибка', async () => {
    const root = await project();
    await writeLog(root, 40);
    const dry = collectIo();
    expect(await runMaestroCli(['archive', '--path', root], dry.io)).toBe(0);
    expect(dry.stdout()).toContain('пробный запуск, ни байта не записано');
    expect(dry.stdout()).toContain('wiki/log/2026-10.md');
    expect(dry.stdout()).toMatch(/archive --path .* --apply/);
    const applied = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--apply'], applied.io)).toBe(0);
    expect(applied.stdout()).toContain('Ничего не удалено');
    const nothing = collectIo();
    expect(await runMaestroCli(['archive', '--path', root], nothing.io)).toBe(0);
    expect(nothing.stdout()).toContain('Переносить в архив нечего');
    const json = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ reportVersion: 1, ok: true, writes: [] });
    const wrong = collectIo();
    expect(await runMaestroCli(['doctor', '--path', root, '--apply'], wrong.io)).toBe(2);
    expect(wrong.stderr()).toContain('только для upgrade и archive');
  });
});
