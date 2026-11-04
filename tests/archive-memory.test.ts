import { existsSync } from 'node:fs';
import { chmod, link, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeArchiveCommand } from '../src/cli/archive-run.js';
import { runMaestroCli } from '../src/cli/maestro.js';
import { archiveProject } from '../src/core/archive/index.js';
import { rebaseLinks } from '../src/core/archive/links.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { legacyPlanBodyDigest, planBodyDigest } from '../src/core/plan.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, snapshotTree } from './helpers.js';
import { collectIo } from './published.js';

afterEach(cleanupTempDirs);

const PLAN = 'wiki/plans/0002-work.md';
const PLAN_ARCHIVE = 'wiki/plans/archive/0002-work.md';

async function project(): Promise<string> {
  const root = join(await makeTempDir('archive-'), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

async function put(root: string, path: string, text: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), text, 'utf8');
}

interface Finding { id: string; severity?: string; status: string; resolution?: string }

function auditText(id: string, status: string, findings: Finding[], extra = ''): string {
  const parts = findings.map((item) => [
    `## Finding ${item.id}`, `- severity: ${item.severity ?? 'medium'}`, '- target: src/a.ts:1', '- evidence: воспроизведено',
    `- status: ${item.status}`, `- resolution: ${item.resolution ?? 'исправлено'}`, '',
  ].join('\n'));
  return ['---', `audit_id: ${id}`, `status: ${status}`, '---', '', `# Проверка ${id}`, '', extra, '', ...parts].join('\n');
}

const closedAudit = (id: string, extra = ''): string => auditText(id, 'resolved', [{ id: `${id}-F1`, status: 'resolved' }], extra);

interface PlanOptions {
  status?: string;
  digest?: ((text: string) => string) | null;
  slice?: string;
  sources?: string;
}

function planText(body: string, options: PlanOptions = {}): string {
  const digest = options.digest === undefined ? planBodyDigest : options.digest;
  const approved = (options.status ?? 'active') !== 'draft';
  const text = [
    '---', 'type: plan', 'title: Работа', 'id: PLAN-0002', 'kind: feature', `status: ${options.status ?? 'active'}`, 'scale: feature', 'mode: extension',
    'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', `sources: ${options.sources ?? '[]'}`,
    'supersedes: null', `approved_by: ${approved ? 'Человек' : 'null'}`, `approved_at: ${approved ? '2026-11-01' : 'null'}`, 'active_phase: null', 'blocking_questions: 0',
    'spec_delta: none', `current_slice: ${options.slice ?? 'null'}`, '---', '', body,
  ].join('\n');
  return digest === null ? text : text.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${digest(text)}`);
}

async function withPlan(root: string, body: string, options: PlanOptions = {}): Promise<string> {
  const text = planText(body, options);
  await put(root, PLAN, text);
  if (body.includes('../audits/AUD-1.md') && !existsSync(join(root, 'wiki/audits/AUD-1.md'))) await put(root, 'wiki/audits/AUD-1.md', auditText('AUD-1', 'open', [{ id: 'AUD-1-F1', status: 'open' }]));
  await put(root, 'wiki/hot.md', (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-work.md'));
  return text;
}

const PROMTARA = [
  '# Промтара', '', '## Цель этапа', '', 'Текст цели.', '', '## Порции этапа', '', '### 1.5-schet — счёт', '', 'Порция.', '',
  '## Изменения после утверждения', '', 'Вводная сборника.', '',
  '### SPEC DELTA-01 (2026-10-12) — доступ к `Railway`', '', 'Тело со [ссылкой](README.md#отпечаток) и [отчётом](../audits/AUD-1.md).', '',
  '#### Подробности', '', '- пункт', '',
  '### SPEC DELTA-02 (2026-10-13) — бэкапы', '', '```text', '### SPEC DELTA-99 в блоке кода', '```', '',
  '### SPEC DELTA-12 (2026-10-15) — **Prom**  и  «наличие»', '', 'Тело.', '',
  '### Приёмка `1.4a` и переход к `1.4d` (2026-10-24, слово владельца)', '', 'Слово владельца.', '',
  '### SPEC DELTA-41 — порция `1.6a`', '', 'Открытая.', '',
  '## Утверждение', '', 'Утверждено.', '',
].join('\n');

const HUB = [
  '# Хаб', '', '## Цель', '', 'Цель.', '', '## Изменения после утверждения', '', 'Список.', '', '## Утверждение', '', 'Текст.', '',
  '## Порция 01 — итог (30.10.2026)', '', 'Итог: [отчёт](../audits/AUD-1.md).', '',
  '## SPEC DELTA 9 — заказ капсулой (01.11.2026)', '', '### Этап 1. Нас выбрали', '', 'Текст.', '', '### Этап 2. Работа', '', 'Текст.', '',
  '## Порция 12-capsule — объявлена 01.11.2026', '', 'Текст.', '',
].join('\n');

async function expectDoctorClean(root: string): Promise<void> {
  const codes = (await doctorProject(root)).findings.filter((item) => item.level !== 'info').map((item) => `${item.code}: ${item.path ?? ''}`);
  expect(codes).toEqual([]);
}

async function expectRefused(root: string, sections: string[], code: string): Promise<void> {
  const before = await snapshotTree(root);
  for (const apply of [false, true]) {
    const result = await archiveProject(root, { apply, sections, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((item) => item.code)).toContain(code);
    expect(await snapshotTree(root)).toEqual(before);
  }
}

async function preflightCode(root: string): Promise<number> {
  return runMaestroCli(['preflight', '--path', root], collectIo().io);
}

describe('0.4.4 archive: отчёты проверок', () => {
  it('закрытый отчёт уходит в wiki/audits/archive/: текст прежний, адреса ссылок поправлены; без --apply — ни байта', async () => {
    const root = await project();
    const original = closedAudit('AUD-1', 'План — [README](../plans/README.md#отпечаток), соседний — [AUD-2](AUD-2.md).');
    await put(root, 'wiki/audits/AUD-1.md', original);
    await put(root, 'wiki/audits/AUD-2.md', closedAudit('AUD-2'));
    const before = await snapshotTree(root);
    const dry = await archiveProject(root);
    expect(dry.audits.moved).toEqual([
      { from: 'wiki/audits/AUD-1.md', to: 'wiki/audits/archive/AUD-1.md' },
      { from: 'wiki/audits/AUD-2.md', to: 'wiki/audits/archive/AUD-2.md' },
    ]);
    expect(await snapshotTree(root)).toEqual(before);

    const result = await archiveProject(root, { apply: true });
    expect(result.applied).toBe(true);
    expect(existsSync(join(root, 'wiki/audits/AUD-1.md'))).toBe(false);
    expect(await readUtf8(root, 'wiki/audits/archive/AUD-1.md')).toBe(original.replace('../plans/README.md#отпечаток', '../../plans/README.md#отпечаток'));
    await expectDoctorClean(root);
    expect((await archiveProject(root)).writes).toEqual([]);
  });

  it('остаются с причиной: открытый (и с «не исправляем»), неразборчивый, названный в sources; уже есть в архиве — не перезаписывается', async () => {
    const root = await project();
    const open = auditText('AUD-OPEN', 'open', [{ id: 'AUD-OPEN-F1', status: 'open', resolution: 'не исправляем — мелочь; записано в wiki/icebox.md' }]);
    await put(root, 'wiki/audits/AUD-OPEN.md', open);
    await put(root, 'wiki/audits/AUD-BAD.md', '---\naudit_id: AUD-BAD\nstatus: resolved\n---\n\nбез находок\n');
    await put(root, 'wiki/audits/AUD-SRC.md', closedAudit('AUD-SRC'));
    await put(root, 'wiki/audits/AUD-DUP.md', closedAudit('AUD-DUP'));
    await put(root, 'wiki/audits/archive/AUD-DUP.md', closedAudit('AUD-DUP', 'Прежний.'));
    await withPlan(root, '# План\n', { digest: null, sources: '[wiki/audits/AUD-SRC.md]' });
    const result = await archiveProject(root, { apply: true });
    expect(result.audits.moved).toEqual([]);
    expect(Object.fromEntries(result.audits.kept.map((item) => [item.path, item.code]))).toEqual({
      'wiki/audits/AUD-BAD.md': 'audit-malformed',
      'wiki/audits/AUD-DUP.md': 'audit-archive-exists',
      'wiki/audits/AUD-OPEN.md': 'audit-open',
      'wiki/audits/AUD-SRC.md': 'audit-plan-source',
    });
    expect(await readUtf8(root, 'wiki/audits/AUD-OPEN.md')).toBe(open);
    expect(await readUtf8(root, 'wiki/audits/archive/AUD-DUP.md')).toContain('Прежний.');
  });

  it('открытая high, положенная руками в архив, — по-прежнему audit-blocking-finding; неразборчивый там — audit-malformed', async () => {
    const root = await project();
    await put(root, 'wiki/audits/archive/AUD-3.md', auditText('AUD-3', 'open', [{ id: 'AUD-3-F1', severity: 'high', status: 'open' }]));
    await put(root, 'wiki/audits/archive/AUD-4.md', '---\naudit_id: AUD-4\nstatus: open\n---\n\nтекст\n');
    const codes = (await doctorProject(root)).findings.map((item) => `${item.code} ${item.path}`);
    expect(codes).toContain('audit-blocking-finding wiki/audits/archive/AUD-3.md');
    expect(codes).toContain('audit-malformed wiki/audits/archive/AUD-4.md');
  });

  it('ссылки на отчёт в передаче и hot.md ведут на новое место, остальные байты те же; якорь и вид записи сохранены', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    const handoff = '# Передача\n\nОтчёт: [AUD-1](../audits/AUD-1.md#finding) и <не ссылка ../audits/AUD-1.md>, путь текстом wiki/audits/AUD-1.md.\n\n[в угловых](<../audits/AUD-1.md>)\n';
    await put(root, 'wiki/handoffs/2026-11-01-a.md', handoff);
    const hot = await readUtf8(root, 'wiki/hot.md');
    await put(root, 'wiki/hot.md', `${hot}\nОтчёт: [AUD-1](audits/AUD-1.md).\n`);
    const result = await archiveProject(root, { apply: true });
    expect(result.relinked.sort()).toEqual(['wiki/handoffs/2026-11-01-a.md', 'wiki/hot.md']);
    expect(await readUtf8(root, 'wiki/handoffs/2026-11-01-a.md')).toBe(handoff.replace('(../audits/AUD-1.md#finding)', '(../audits/archive/AUD-1.md#finding)').replace('(<../audits/AUD-1.md>)', '(<../audits/archive/AUD-1.md>)'));
    expect(await readUtf8(root, 'wiki/hot.md')).toBe(`${hot}\nОтчёт: [AUD-1](audits/archive/AUD-1.md).\n`);
    await expectDoctorClean(root);
  });

  it('ссылка из утверждённого плана поправлена, записан новый отпечаток, строка об отпечатках — в архиве плана (файл создан)', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    const text = await withPlan(root, '# План\n\nОтчёт: [AUD-1](../audits/AUD-1.md).\n', { slice: '01-work' });
    const digestBefore = planBodyDigest(text);
    const result = await archiveProject(root, { apply: true, now: FIXED_NOW });
    const after = await readUtf8(root, PLAN);
    expect(after).toContain('(../audits/archive/AUD-1.md)');
    expect(result.digests).toEqual([{ plan: PLAN, before: digestBefore, after: planBodyDigest(after) }]);
    expect(after).toContain(`approved_digest: ${planBodyDigest(after)}`);
    const archive = await readUtf8(root, PLAN_ARCHIVE);
    expect(archive).toContain('type: plan-archive');
    expect(archive).toContain('plan: PLAN-0002');
    expect(archive).toContain(`source: ${PLAN}`);
    expect(archive).toContain(`2026-08-02: \`${digestBefore}\` → \`${planBodyDigest(after)}\``);
    await expectDoctorClean(root);
    expect(await preflightCode(root)).toBe(0);
  });

  it('план изменён после утверждения: отчёт остаётся с причиной, план не тронут; другие отчёты уходят', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await put(root, 'wiki/audits/AUD-2.md', closedAudit('AUD-2'));
    const text = await withPlan(root, '# План\n\nОтчёт: [AUD-1](../audits/AUD-1.md).\n');
    const changed = text.replace('# План', '# План с неутверждённой правкой');
    await put(root, PLAN, changed);
    const result = await archiveProject(root, { apply: true });
    expect(result.audits.moved.map((item) => item.from)).toEqual(['wiki/audits/AUD-2.md']);
    expect(result.audits.kept).toEqual([expect.objectContaining({ path: 'wiki/audits/AUD-1.md', code: 'audit-plan-changed' })]);
    expect(await readUtf8(root, PLAN)).toBe(changed);
    expect(existsSync(join(root, PLAN_ARCHIVE))).toBe(false);
  });

  it('в завершённом плане поправлен только адрес: отпечаток тот же, архива плана нет', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    const text = planText('# Прошлый план\n\nОтчёт: [AUD-1](../audits/AUD-1.md).\n', { status: 'completed' });
    await put(root, PLAN, text);
    const result = await archiveProject(root, { apply: true });
    expect(result.digests).toEqual([]);
    expect(await readUtf8(root, PLAN)).toBe(text.replace('(../audits/AUD-1.md)', '(../audits/archive/AUD-1.md)'));
    expect(existsSync(join(root, PLAN_ARCHIVE))).toBe(false);
    await expectDoctorClean(root);
  });

  it('журнал и отчёт в одном запуске: ссылка на отчёт в записи журнала ведёт на новое место из файла месяца', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    const old = `## 2026-10-01 — старая\n\nОтчёт: [AUD-1](audits/AUD-1.md).\n${'- подробность.\n'.repeat(1500)}\n`;
    const recent = '## 2026-11-01 — новая\n\nОтчёт: [AUD-1](audits/AUD-1.md).\n';
    await put(root, 'wiki/log.md', `# Журнал\n\nШапка: [AUD-1](audits/AUD-1.md).\n\n${old}${recent}`);
    expect((await archiveProject(root, { apply: true })).applied).toBe(true);
    expect(await readUtf8(root, 'wiki/log/2026-10.md')).toContain('(../audits/archive/AUD-1.md)');
    const log = await readUtf8(root, 'wiki/log.md');
    expect(log.match(/\(audits\/archive\/AUD-1\.md\)/g)).toHaveLength(2);
    await expectDoctorClean(root);
  });
});

describe('0.4.4 archive: закрытые правки плана', () => {
  it('раздел формы Промтары уходит в архив плана байт в байт; в плане — заголовок и строка; вложенные и размеры — в отчёте', async () => {
    const root = await project();
    const text = await withPlan(root, PROMTARA, { digest: null });
    const before = await snapshotTree(root);
    const dry = await archiveProject(root, { sections: ['SPEC DELTA-01'] });
    expect(dry.sections).toEqual([expect.objectContaining({ heading: 'SPEC DELTA-01 (2026-10-12) — доступ к Railway', status: 'moved', nested: [{ heading: 'Подробности', chars: expect.any(Number) }] })]);
    expect(dry.sections[0]!.chars).toBeGreaterThan(50);
    expect(await snapshotTree(root)).toEqual(before);

    expect((await archiveProject(root, { apply: true, sections: ['SPEC DELTA-01'] })).applied).toBe(true);
    const section = text.slice(text.indexOf('### SPEC DELTA-01'), text.indexOf('### SPEC DELTA-02'));
    const archive = await readUtf8(root, PLAN_ARCHIVE);
    expect(archive).toContain(section.replace('(README.md', '(../README.md').replace('../audits/AUD-1.md', '../../audits/AUD-1.md'));
    const plan = await readUtf8(root, PLAN);
    expect(plan).toBe(text.replace(section, '### SPEC DELTA-01 (2026-10-12) — доступ к `Railway`\n\nВ архиве: [0002-work.md](archive/0002-work.md).\n\n'));
    await expectDoctorClean(root);
  });

  it('совпадение: кириллица по границе слова, разметка в заголовке и аргументе, двойные пробелы; ноль и несколько — отказ с перечнем', async () => {
    const root = await project();
    await withPlan(root, PROMTARA, { digest: null });
    expect((await archiveProject(root, { sections: ['Приёмка 1.4a'] })).sections[0]?.heading).toContain('Приёмка 1.4a и переход');
    expect((await archiveProject(root, { sections: ['Приёмка `1.4a`'] })).ok).toBe(true);
    expect((await archiveProject(root, { sections: ['SPEC  DELTA-12 (2026-10-15) — Prom и наличие'] })).ok).toBe(true);
    await expectRefused(root, ['Приём'], 'archive-section-not-found');
    await expectRefused(root, ['SPEC DELTA-1'], 'archive-section-not-found');
    await expectRefused(root, ['SPEC DELTA-99'], 'archive-section-not-found');
    await expectRefused(root, ['SPEC'], 'archive-section-ambiguous');
    const ambiguous = await archiveProject(root, { sections: ['SPEC'] });
    expect(ambiguous.blockers[0]?.message).toContain('SPEC DELTA-02');
    const missing = await archiveProject(root, { sections: ['Нет такого'] });
    expect(missing.blockers[0]?.message).toContain('Приёмка 1.4a');
  });

  it('форма Промтары: отказ для сборника, для основной части, для «Утверждение», для раздела текущей порции', async () => {
    const root = await project();
    await withPlan(root, PROMTARA, { digest: null, slice: '1.6a' });
    await expectRefused(root, ['Изменения после утверждения'], 'archive-section-collection');
    await expectRefused(root, ['Изменения'], 'archive-section-collection');
    await expectRefused(root, ['Порции этапа'], 'archive-section-main-part');
    await expectRefused(root, ['Цель этапа'], 'archive-section-main-part');
    await expectRefused(root, ['1.5-schet'], 'archive-section-main-part');
    await expectRefused(root, ['Утверждение'], 'archive-section-approval');
    await expectRefused(root, ['SPEC DELTA-41'], 'archive-section-current-slice');
    expect((await archiveProject(root, { sections: ['SPEC DELTA-02'] })).ok).toBe(true);
  });

  it('при current_slice: null сборник и основная часть всё равно отказывают; упоминание порции в теле и [ ] — предупреждение', async () => {
    const root = await project();
    await withPlan(root, PROMTARA.replace('Слово владельца.', 'Дальше — порция 1.6a.\n\n- [ ] не отмечено'), { digest: null });
    await expectRefused(root, ['Изменения после утверждения'], 'archive-section-collection');
    await expectRefused(root, ['Порции этапа'], 'archive-section-main-part');
    expect((await archiveProject(root, { sections: ['Приёмка'] })).sections[0]?.warnings).toEqual([expect.stringContaining('неотмеченных')]);

    await withPlan(root, PROMTARA.replace('Слово владельца.', 'Дальше — порция 1.6a.'), { digest: null, slice: '1.6a' });
    expect((await archiveProject(root, { sections: ['Приёмка'] })).sections[0]?.warnings).toEqual([expect.stringContaining('1.6a')]);
  });

  it('форма хаба: разделы ниже «Утверждение» переносятся, с вложенными ###; следующий ## остаётся', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    const result = await archiveProject(root, { apply: true, sections: ['Порция 01', 'SPEC DELTA 9'] });
    expect(result.sections.map((item) => item.nested.length)).toEqual([0, 2]);
    const plan = await readUtf8(root, PLAN);
    expect(plan).not.toContain('### Этап 1');
    expect(plan).toContain('## Порция 12-capsule — объявлена 01.11.2026');
    const archive = await readUtf8(root, PLAN_ARCHIVE);
    expect(archive).toContain('### Этап 2. Работа');
    expect(archive).toContain('(../../audits/AUD-1.md)');
    await expectDoctorClean(root);
  });

  it('план без сборника, active_plan: none, разделы внахлёст — отказ, ни байта', async () => {
    const root = await project();
    await expectRefused(root, ['Что угодно'], 'archive-section-no-plan');
    await withPlan(root, '# План\n\n## Цель\n\nТекст.\n\n## Порция 1\n\nТекст.\n', { digest: null });
    await expectRefused(root, ['Порция 1'], 'archive-section-no-collection');
    await withPlan(root, HUB, { digest: null });
    await expectRefused(root, ['SPEC DELTA 9', 'Этап 1'], 'archive-section-overlap');
  });

  it('раздел с вложенным заголовком текущей порции — отказ', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null, slice: '12-capsule' });
    await expectRefused(root, ['Порция 12-capsule'], 'archive-section-current-slice');
    await withPlan(root, HUB.replace('### Этап 2. Работа', '### Порция 12-capsule'), { digest: null, slice: '12-capsule' });
    await expectRefused(root, ['SPEC DELTA 9'], 'archive-section-current-slice');
  });

  it('повторный --section на заглушке: «уже в архиве», ни байта', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    await archiveProject(root, { apply: true, sections: ['Порция 01'] });
    const before = await snapshotTree(root);
    const result = await archiveProject(root, { apply: true, sections: ['Порция 01'] });
    expect(result.ok).toBe(true);
    expect(result.writes).toEqual([]);
    expect(result.sections).toEqual([expect.objectContaining({ status: 'already' })]);
    expect(await snapshotTree(root)).toEqual(before);
    const cli = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Порция 01'], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('уже в архиве');
  });

  it('второй перенос дописывает в тот же архив плана', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    await archiveProject(root, { apply: true, sections: ['Порция 01'] });
    await archiveProject(root, { apply: true, sections: ['SPEC DELTA 9'] });
    const archive = await readUtf8(root, PLAN_ARCHIVE);
    expect(archive.match(/type: plan-archive/g)).toHaveLength(1);
    expect(archive.indexOf('## Порция 01')).toBeLessThan(archive.indexOf('## SPEC DELTA 9'));
    await expectDoctorClean(root);
  });

  it('раздел ссылается на отчёт, уходящий в том же запуске: адрес верный, отпечаток сверен один раз', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1', 'План: [работа](../plans/0002-work.md).'));
    const text = await withPlan(root, HUB, { slice: '01-work' });
    const result = await archiveProject(root, { apply: true, sections: ['Порция 01'], now: FIXED_NOW });
    expect(result.audits.moved).toHaveLength(1);
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0]?.before).toBe(planBodyDigest(text));
    expect(await readUtf8(root, PLAN_ARCHIVE)).toContain('(../../audits/archive/AUD-1.md)');
    expect(await readUtf8(root, 'wiki/audits/archive/AUD-1.md')).toContain('(../../plans/0002-work.md)');
    await expectDoctorClean(root);
    expect(await preflightCode(root)).toBe(0);
  });

  it('утверждённый неизменённый план со строками итога: перенос, новый отпечаток, preflight разрешает, doctor зелёный', async () => {
    const root = await project();
    await put(root, 'wiki/handoffs/2026-11-01-a.md', '# Передача\n');
    const body = `${HUB}\n## Порядок\n\n1. [ ] Порция 1.\n`.replace('## Порядок', '## Хвост правок');
    const text = await withPlan(root, body, { slice: '01-work' });
    await put(root, PLAN, text.replace('1. [ ] Порция 1.', '1. [x] Порция 1. → [итог](../handoffs/2026-11-01-a.md)'));
    expect(await preflightCode(root)).toBe(0);
    const result = await archiveProject(root, { apply: true, sections: ['Порция 01'], now: FIXED_NOW });
    expect(result.applied).toBe(true);
    const after = await readUtf8(root, PLAN);
    expect(after).toContain(`approved_digest: ${planBodyDigest(after)}`);
    expect(after).toContain('[итог](../handoffs/2026-11-01-a.md)');
    await expectDoctorClean(root);
    expect(await preflightCode(root)).toBe(0);
  });

  it('разделы вставлены обратно с прежними адресами ссылок — прежний отпечаток', async () => {
    const root = await project();
    const text = await withPlan(root, PROMTARA);
    await archiveProject(root, { apply: true, sections: ['SPEC DELTA-01', 'Приёмка'] });
    let plan = await readUtf8(root, PLAN);
    const archive = await readUtf8(root, PLAN_ARCHIVE);
    for (const [from, to] of [['### SPEC DELTA-01', '### Приёмка'], ['### Приёмка', 'Отпечаток плана заменён']] as const) {
      const moved = archive.slice(archive.indexOf(from), archive.indexOf(to));
      const back = rebaseLinks(moved, PLAN_ARCHIVE, PLAN);
      const stub = new RegExp(`${from}[^\\n]*\\n\\nВ архиве: [^\\n]*\\n\\n`);
      plan = plan.replace(stub, () => back);
    }
    expect(planBodyDigest(plan)).toBe(planBodyDigest(text));
  });

  it('план изменён после утверждения: отказ, ни байта — неутверждённую правку не «отмыть»', async () => {
    const root = await project();
    const text = await withPlan(root, HUB);
    await put(root, PLAN, text.replace('Цель.', 'Другая цель.'));
    await expectRefused(root, ['Порция 01'], 'archive-plan-changed');
  });

  it('без отпечатка: перенос без отпечатка; отпечаток вида 0.4.2 принимается и заменяется новым', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    const plain = await archiveProject(root, { apply: true, sections: ['Порция 01'] });
    expect(plain.digests).toEqual([]);
    expect(await readUtf8(root, PLAN)).not.toContain('approved_digest');
    expect(await readUtf8(root, PLAN_ARCHIVE)).not.toContain('Отпечаток плана заменён');

    const legacy = await project();
    const body = HUB.replace('Цель.', '- [x] Цель.');
    await withPlan(legacy, body, { digest: legacyPlanBodyDigest, slice: '01-work' });
    const result = await archiveProject(legacy, { apply: true, sections: ['Порция 01'], now: FIXED_NOW });
    expect(result.digests).toHaveLength(1);
    const after = await readUtf8(legacy, PLAN);
    expect(after).toContain(`approved_digest: ${planBodyDigest(after)}`);
    expect(await preflightCode(legacy)).toBe(0);
  });

  it('CRLF плана сохраняется; preflight разрешает', async () => {
    const root = await project();
    const text = await withPlan(root, HUB, { slice: '01-work' });
    await put(root, PLAN, text.replace(/\n/g, '\r\n'));
    expect((await archiveProject(root, { apply: true, sections: ['Порция 01'] })).applied).toBe(true);
    const after = await readFile(join(root, PLAN), 'utf8');
    expect(after.replace(/\r\n/g, '')).not.toContain('\n');
    expect(after).toContain('В архиве: [0002-work.md](archive/0002-work.md).\r\n');
    await expectDoctorClean(root);
    expect(await preflightCode(root)).toBe(0);
    expect(await readUtf8(root, PLAN_ARCHIVE)).toContain('## Порция 01 — итог (30.10.2026)\r\n\r\nИтог:');
  });

  it('BOM плана сохраняется, отпечаток считается как у doctor', async () => {
    const root = await project();
    const text = await withPlan(root, HUB);
    await put(root, PLAN, `\uFEFF${text}`);
    await expectDoctorClean(root);
    expect((await archiveProject(root, { apply: true, sections: ['Порция 01'] })).applied).toBe(true);
    expect((await readFile(join(root, PLAN), 'utf8')).startsWith('\uFEFF')).toBe(true);
    await expectDoctorClean(root);
  });

  it('сбой посреди записи откатывает всё: план, архив плана, отчёты', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await withPlan(root, HUB);
    const before = await snapshotTree(root);
    let count = 0;
    const result = await archiveProject(root, {
      apply: true,
      sections: ['Порция 01'],
      hooks: { beforeCommit: async () => { count += 1; if (count === 3) throw new Error('сбой на третьем пути'); } },
    });
    expect(result.rolledBack).toBe(true);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('папка архива плана в .gitignore — отказ; проект без git — проверки нет', async () => {
    const { execFileSync } = await import('node:child_process');
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    execFileSync('git', ['init', '-q'], { cwd: root });
    await put(root, '.gitignore', 'archive/\n');
    await expectRefused(root, ['Порция 01'], 'archive-destination-ignored');
  });

  it('CLI: --section повторяется, только у archive, требует значение; отказ — код 1 с перечнем; --json — отчёт', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    const dry = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Порция 01', '--section', 'SPEC DELTA 9'], dry.io)).toBe(0);
    expect(dry.stdout()).toContain('Раздел плана «Порция 01 — итог (30.10.2026)»');
    expect(dry.stdout()).toContain('внутри «Этап 1. Нас выбрали»');
    expect(dry.stdout()).toContain('--section "SPEC DELTA 9" --apply');

    const wrong = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Нет такого'], wrong.io)).toBe(1);
    expect(wrong.stderr()).toContain('archive-section-not-found');

    const json = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Порция 01', '--json'], json.io)).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({ plan: PLAN, planArchive: PLAN_ARCHIVE, sections: [{ status: 'moved' }] });

    expect(await runMaestroCli(['archive', '--path', root, '--section'], collectIo().io)).not.toBe(0);
    expect(await runMaestroCli(['doctor', '--path', root, '--section', 'x'], collectIo().io)).not.toBe(0);
  });
});

describe('0.4.4 archive: находки ревью', () => {
  /** На macOS и Windows имена, которые отличаются только регистром, — один файл. */
  const sameFileInOtherCase = (root: string): boolean => existsSync(join(root, 'WIKI/HOT.MD'));
  
  it('файл архива с именем другого регистра не затирается: отчёт остаётся с причиной', async () => {
    const root = await project();
    await put(root, 'wiki/audits/archive/Report.md', closedAudit('AUD-OLD'));
    await put(root, 'wiki/audits/report.md', closedAudit('AUD-NEW'));
    const result = await archiveProject(root, { apply: true });
    expect(await readUtf8(root, 'wiki/audits/archive/Report.md')).toContain('AUD-OLD');
    if (sameFileInOtherCase(root)) {
      expect(result.audits.kept).toEqual([expect.objectContaining({ path: 'wiki/audits/report.md', code: 'audit-archive-exists' })]);
      expect(await readUtf8(root, 'wiki/audits/report.md')).toContain('AUD-NEW');
    } else {
      expect(await readUtf8(root, 'wiki/audits/archive/report.md')).toContain('AUD-NEW');
    }
  });

  it('архив плана с именем другого регистра не затирается: отказ, ни байта', async () => {
    const root = await project();
    await withPlan(root, HUB, { digest: null });
    await archiveProject(root, { apply: true, sections: ['Порция 01'] });
    await rename(join(root, PLAN), join(root, 'wiki/plans/0002-WORK.md'));
    await put(root, 'wiki/hot.md', (await readUtf8(root, 'wiki/hot.md')).replace('plans/0002-work.md', 'plans/0002-WORK.md'));
    if (!sameFileInOtherCase(root)) return;
    await expectRefused(root, ['SPEC DELTA 9'], 'archive-destination-exists');
    expect(await readUtf8(root, PLAN_ARCHIVE)).toContain('## Порция 01');
  });

  it('ссылки и sources, которые doctor считает целыми, ведут на новое место: другой регистр, абсолютный адрес, обход через имя папки', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    const links = [`[абсолютный](${(await realpath(root)).split('\\').join('/')}/wiki/audits/AUD-1.md)`, '[обход](../../../проект/wiki/audits/AUD-1.md#finding)'];
    if (sameFileInOtherCase(root)) links.push('[регистр](../audits/aud-1.md)');
    await put(root, 'wiki/handoffs/2026-11-01-a.md', `# Передача\n\n${process.platform === 'win32' ? links.slice(1).join('\n') : links.join('\n')}\n`);
    await expectDoctorClean(root);
    expect((await archiveProject(root, { apply: true })).audits.moved).toHaveLength(1);
    await expectDoctorClean(root);
    const handoff = await readUtf8(root, 'wiki/handoffs/2026-11-01-a.md');
    expect(handoff).toContain('(../audits/archive/AUD-1.md#finding)');
    expect(handoff).not.toContain('(../audits/AUD-1.md');
  });

  it('в перенесённом отчёте адрес с обходом через имя папки тоже остаётся рабочим', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1', 'План: [README](../../../проект/wiki/plans/README.md).'));
    await expectDoctorClean(root);
    await archiveProject(root, { apply: true });
    await expectDoctorClean(root);
  });

  it('отчёт, названный в sources в другом регистре, остаётся на месте', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    if (!sameFileInOtherCase(root)) return;
    await withPlan(root, '# План\n', { digest: null, sources: '[wiki/audits/aud-1.md]' });
    expect((await archiveProject(root, { apply: true })).audits.kept.map((item) => item.code)).toEqual(['audit-plan-source']);
    await expectDoctorClean(root);
  });

  it('git: файл месяца уже есть, но игнорируется — отказ; правило родительского репозитория — отказ', async () => {
    const { execFileSync } = await import('node:child_process');
    const longLog = (text: string): string => `${text}\n## 2026-10-01 — старая\n\n${'- подробность.\n'.repeat(1500)}\n## 2026-11-02 — новая\n\n- порция.\n`;
    const root = await project();
    await put(root, 'wiki/log.md', longLog(await readUtf8(root, 'wiki/log.md')));
    await put(root, 'wiki/log/2026-10.md', '# Журнал: 2026-10\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    await put(root, '.gitignore', 'wiki/log/\n');
    await expectRefused(root, [], 'archive-destination-ignored');

    const outer = await makeTempDir('outer-');
    const nested = join(outer, 'app');
    expect((await initProject({ target: nested, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await put(nested, 'wiki/log.md', longLog(await readUtf8(nested, 'wiki/log.md')));
    execFileSync('git', ['init', '-q'], { cwd: outer });
    await put(outer, '.gitignore', 'app/wiki/log/\n');
    await expectRefused(nested, [], 'archive-destination-ignored');
  });

  it('план на паузе (blocked): ссылка поправлена, отпечаток заменён, после возврата к работе гейт открыт', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await withPlan(root, '# План\n\nОтчёт: [AUD-1](../audits/AUD-1.md).\n', { status: 'blocked', slice: '01-work' });
    expect((await archiveProject(root, { apply: true })).digests).toHaveLength(1);
    await put(root, PLAN, (await readUtf8(root, PLAN)).replace('status: blocked', 'status: active'));
    await expectDoctorClean(root);
    expect(await preflightCode(root)).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('symbolic link на своих путях — отказ: журнал, папка отчётов, активный план, .maestro', async () => {
    const outside = await makeTempDir('outside-');
    const refused = async (root: string, sections: string[] = []): Promise<void> => {
      const result = await archiveProject(root, { apply: true, sections });
      expect(result.applied).toBe(false);
      expect(result.blockers.map((item) => item.code)).toContain('archive-symlink');
    };
    const log = await project();
    await put(outside, 'log.md', '# Журнал\n');
    await rm(join(log, 'wiki/log.md'));
    await symlink(join(outside, 'log.md'), join(log, 'wiki/log.md'));
    await refused(log);

    const audits = await project();
    await mkdir(join(outside, 'audits'));
    await rm(join(audits, 'wiki/audits'), { recursive: true, force: true });
    await symlink(join(outside, 'audits'), join(audits, 'wiki/audits'));
    await refused(audits);

    const plan = await project();
    await withPlan(plan, HUB, { digest: null });
    await rename(join(plan, PLAN), join(outside, 'plan.md'));
    await symlink(join(outside, 'plan.md'), join(plan, PLAN));
    await refused(plan, ['Порция 01']);

    const maestro = await project();
    await rename(join(maestro, '.maestro'), join(outside, 'maestro-copy'));
    await symlink(join(outside, 'maestro-copy'), join(maestro, '.maestro'));
    await refused(maestro);
    expect(existsSync(join(outside, 'maestro-copy/archive-staging'))).toBe(false);
  });

  it('файл на месте папки архива — понятный отказ; нечитаемый файл — отказ, а не падение', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await put(root, 'wiki/audits/archive', 'это файл\n');
    await expectRefused(root, [], 'archive-not-directory');

    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const locked = await project();
    await put(locked, 'wiki/handoffs/2026-11-01-a.md', '# Передача\n');
    await chmod(join(locked, 'wiki/handoffs/2026-11-01-a.md'), 0o000);
    const json = collectIo();
    expect(await runMaestroCli(['archive', '--path', locked, '--json'], json.io)).toBe(1);
    expect(JSON.parse(json.stdout())).toMatchObject({ ok: false, blockers: [{ code: 'archive-unreadable', path: 'wiki/handoffs/2026-11-01-a.md' }] });
    await chmod(join(locked, 'wiki/handoffs/2026-11-01-a.md'), 0o644);
  });

  it('откат не удался: CLI не говорит «изменений нет», называет частичное изменение', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await put(root, 'wiki/handoffs/2026-11-01-a.md', 'Отчёт: [AUD-1](../audits/AUD-1.md).\n');
    let count = 0;
    const cli = collectIo();
    const code = await executeArchiveCommand({
      path: root,
      json: false,
      apply: true,
      hooks: { beforeCommit: async () => {
        count += 1;
        // Третий путь: уже удалён отчёт, а вернуть его неоткуда.
        if (count === 3) {
          await rm(join(root, '.maestro/archive-staging/backup'), { recursive: true });
          throw new Error('сбой');
        }
      } },
    }, cli.io);
    expect(code).toBe(1);
    expect(cli.stderr()).toContain('проект изменён частично');
    expect(cli.stderr()).not.toContain('изменений на диске нет');
  });

  it('второй сборник правок защищён так же, как первый; внутри раздела — тоже', async () => {
    const root = await project();
    const body = '# План\n\n## Цель\n\nТекст.\n\n## Изменения после утверждения\n\n### Старая\n\nТекст.\n\n## Правки после утверждения\n\n### Правка 1 — открытая (2026-11-01)\n\n- [ ] порция\n\n## Утверждение\n\nДа.\n';
    await withPlan(root, body, { digest: null });
    await expectRefused(root, ['Правки после утверждения'], 'archive-section-collection');
    await expectRefused(root, ['Изменения после утверждения'], 'archive-section-collection');
    await withPlan(root, body.replace('## Правки после утверждения', '#### Правки после утверждения').replace('## Изменения после утверждения', '### Изменения после утверждения\n\n## Сборка'), { digest: null });
    await expectRefused(root, ['Сборка'], 'archive-section-collection');
  });

  it('журнал больше порога, а переносить нечего: сказано почему, а не «не больше порога»; отчёт в sources — без «закрытых отчётов нет»', async () => {
    const dates = await project();
    await put(dates, 'wiki/log.md', `# Журнал\n\n## 12.10.2026 — запись\n\n${'- подробность.\n'.repeat(1500)}`);
    const first = collectIo();
    expect(await runMaestroCli(['archive', '--path', dates], first.io)).toBe(0);
    expect(first.stdout()).toContain('нет записей с датой в начале заголовка');
    expect(first.stdout()).not.toContain('не больше порога');
    expect((await archiveProject(dates)).logNote).toContain('20 000');

    const single = await project();
    await put(single, 'wiki/log.md', `# Журнал\n\n## 2026-10-12 — запись\n\n${'- подробность.\n'.repeat(1500)}`);
    await put(single, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await withPlan(single, '# План\n', { digest: null, sources: '[wiki/audits/AUD-1.md]' });
    const second = collectIo();
    expect(await runMaestroCli(['archive', '--path', single], second.io)).toBe(0);
    expect(second.stdout()).toContain('запись одна');
    expect(second.stdout()).toContain('Остаётся wiki/audits/AUD-1.md');
    expect(second.stdout()).not.toContain('закрытых отчётов нет');
  });

  it('особые знаки в адресах: скобки в кодировке и имя плана со скобками, процентом и пробелом дают рабочие ссылки', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD(1).md', closedAudit('AUD-1'));
    await put(root, 'wiki/handoffs/2026-11-01-a.md', 'Отчёт: [a](../audits/AUD%281%29.md).\n');
    await expectDoctorClean(root);
    await archiveProject(root, { apply: true });
    await expectDoctorClean(root);
    expect(await readUtf8(root, 'wiki/handoffs/2026-11-01-a.md')).toContain('(../audits/archive/AUD%281%29.md)');

    for (const name of ['0002-demo(v2).md', '0002-100%.md', '0002 demo.md']) {
      const named = await project();
      await withPlan(named, HUB, { digest: null });
      await rename(join(named, PLAN), join(named, 'wiki/plans', name));
      await put(named, 'wiki/hot.md', (await readUtf8(named, 'wiki/hot.md')).replace('active_plan: plans/0002-work.md', `active_plan: plans/${name}`));
      expect((await archiveProject(named, { apply: true, sections: ['Порция 01'] })).applied).toBe(true);
      await expectDoctorClean(named);
      expect((await readUtf8(named, `wiki/plans/${name}`)).match(/^В архиве: \[[^\]]*\]\(archive\/[^\s)]+\)\.$/m), name).not.toBeNull();
      const again = await archiveProject(named, { sections: ['Порция 01'] });
      expect(again.sections.map((item) => item.status), name).toEqual(['already']);
    }
  });

  it('файл с тем же номером, но другим именем — не перенесённый отчёт: ссылка на него не меняется', async () => {
    const root = await project();
    await put(root, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    await link(join(root, 'wiki/audits/AUD-1.md'), join(root, 'wiki/handoffs/copy.md'));
    const text = 'Копия: [файл](copy.md).\n';
    await put(root, 'wiki/handoffs/2026-11-01-a.md', text);
    await archiveProject(root, { apply: true });
    expect(await readUtf8(root, 'wiki/handoffs/2026-11-01-a.md')).toBe(text);
    await expectDoctorClean(root);
  });

  it('вся папка проекта вне git у родительского репозитория: это выбор проекта, перенос работает', async () => {
    const { execFileSync } = await import('node:child_process');
    const outer = await makeTempDir('outer-');
    const nested = join(outer, 'app');
    expect((await initProject({ target: nested, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await put(nested, 'wiki/audits/AUD-1.md', closedAudit('AUD-1'));
    execFileSync('git', ['init', '-q'], { cwd: outer });
    await put(outer, '.gitignore', 'app/\n');
    expect((await archiveProject(nested, { apply: true })).audits.moved).toHaveLength(1);
  });

  it('правка, заголовок которой начинается как сборник, переносится: сборник — только первый и точные названия', async () => {
    const root = await project();
    await withPlan(root, '# План\n\n## Изменения после утверждения\n\n### Изменения после утверждения: замена API (2026-10-02)\n\nТекст.\n\n## Утверждение\n\nДа.\n', { digest: null });
    expect((await archiveProject(root, { sections: ['Изменения после утверждения: замена API'] })).ok).toBe(true);
  });

  it('имя плана с неразрывным пробелом, решёткой и квадратными скобками: ссылка рабочая, повтор — «уже в архиве»', async () => {
    for (const name of ['0002\u00A0demo.md', '0002#1.md', '0002[v2].md']) {
      const root = await project();
      await withPlan(root, HUB, { digest: null });
      await rename(join(root, PLAN), join(root, 'wiki/plans', name));
      await put(root, 'wiki/hot.md', (await readUtf8(root, 'wiki/hot.md')).replace('active_plan: plans/0002-work.md', `active_plan: plans/${name}`));
      expect((await archiveProject(root, { apply: true, sections: ['Порция 01'] })).applied, name).toBe(true);
      await expectDoctorClean(root);
      expect((await archiveProject(root, { sections: ['Порция 01'] })).sections.map((item) => item.status), name).toEqual(['already']);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('папка без прав: отказ в отчёте, а не падение', async () => {
    const root = await project();
    await mkdir(join(root, 'wiki/secret'));
    await chmod(join(root, 'wiki/secret'), 0o000);
    const json = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--json'], json.io)).toBe(1);
    expect(JSON.parse(json.stdout())).toMatchObject({ ok: false, blockers: [{ code: 'archive-unreadable' }] });
    await chmod(join(root, 'wiki/secret'), 0o755);
  });

  it('вложенный заголовок «Утверждение правки 1» не мешает; вложенный ровно «Утверждение» — отказ', async () => {
    const root = await project();
    const body = (nested: string): string => `# План\n\n## Изменения после утверждения\n\n### Правка 1 — вход (2026-11-01)\n\nТекст.\n\n#### ${nested}\n\nТекст.\n\n## Утверждение\n\nДа.\n`;
    await withPlan(root, body('Утверждение правки 1'), { digest: null });
    expect((await archiveProject(root, { sections: ['Правка 1'] })).ok).toBe(true);
    await withPlan(root, body('Утверждение'), { digest: null });
    await expectRefused(root, ['Правка 1'], 'archive-section-approval');
  });
});

describe('0.4.5 archive: незакрытое в разделе', () => {
  const body = (text: string): string => ['# Работа', '', '## Изменения после утверждения', '', '### Правка 1', '', text, '', '### Правка 2', '', 'Закрыта.', '', '## Утверждение', '', 'Да.', ''].join('\n');
  async function warnings(text: string): Promise<string[]> {
    const root = await project();
    await withPlan(root, body(text), { digest: null });
    const report = await archiveProject(root, { sections: ['Правка 1'] });
    expect(report.ok).toBe(true);
    return report.sections[0]?.warnings ?? [];
  }

  it('каждое из пяти слов даёт предупреждение со строкой и подсказкой, что делать', async () => {
    for (const word of ['UNKNOWN', 'OPEN_QUESTION', 'HYPOTHESIS', 'не проверено', 'открыто']) {
      const [warning, ...rest] = await warnings(`Строка: ${word}: ответ потом.`);
      expect(rest).toEqual([]);
      expect(warning).toContain(`«Строка: ${word}: ответ потом.»`);
      expect(warning).toContain('Закрыто — переносите; открыто — сначала запишите в wiki/hot.md или wiki/icebox.md');
    }
  });

  it('регистр не важен; слово внутри другого слова и блок кода — нет', async () => {
    for (const text of ['hypothesis подтвердилась', 'Unknown закрыт', 'ОТКРЫТО: нет', 'Не проверено руками']) expect((await warnings(text)).length, text).toBe(1);
    for (const text of ['Закрыто.', 'неоткрыто', 'HYPOTHESISES', 'UNKNOWN_1', 'открытой', '```text\nUNKNOWN и открыто\n```', '~~~\nHYPOTHESIS\n~~~']) {
      expect(await warnings(text), text).toEqual([]);
    }
  });

  it('свой заголовок считается; пробелы в «не проверено» любые; строка находок — нет', async () => {
    const root = await project();
    await withPlan(root, body('Текст.').replace('### Правка 1', '### Правка 1 — открыто: цена'), { digest: null });
    expect((await archiveProject(root, { sections: ['Правка 1'] })).sections[0]?.warnings).toEqual([expect.stringContaining('«### Правка 1 — открыто: цена»')]);
    expect((await warnings('Файлы не  проверено.')).length).toBe(1);
    expect((await warnings('Файлы не\u00A0проверено.')).length).toBe(1);
    expect(await warnings('Находки: critical 0, high 0, medium 0, low 0; открыто 0.')).toEqual([]);
    expect((await warnings('- Находки: critical 1, high 0, medium 0, low 0; открыто 1. [отчёт](x.md)')).length).toBe(1);
    expect((await warnings('Находки: critical 0, high 0, medium 0, low 0; открыто 0. UNKNOWN: цена доставки.')).length).toBe(1);
    expect((await warnings('Находки по цене: открыто.')).length).toBe(1);
  });

  it('уже перенесённый раздел с пометкой в заголовке — без предупреждения', async () => {
    const root = await project();
    await withPlan(root, body('Текст.').replace('### Правка 1', '### Правка 1 — открыто: цена'), { digest: null });
    expect((await archiveProject(root, { apply: true, sections: ['Правка 1'] })).applied).toBe(true);
    const again = (await archiveProject(root, { sections: ['Правка 1'] })).sections[0];
    expect([again?.status, again?.warnings]).toEqual(['already', []]);
  });

  it('заголовок вложенного раздела считается; строк больше трёх — «ещё N»', async () => {
    const [nested] = await warnings('Текст.\n\n#### Открыто: цена доставки\n\nДальше.');
    expect(nested).toContain('«#### Открыто: цена доставки»');
    const [many] = await warnings(['UNKNOWN первая', 'UNKNOWN вторая', 'UNKNOWN третья', 'UNKNOWN четвёртая', 'UNKNOWN пятая'].join('\n\n'));
    expect(many).toContain('«UNKNOWN третья»; ещё 2.');
    expect(many).not.toContain('четвёртая');
  });

  it('длинная строка режется по кодовым точкам, слово остаётся видно', async () => {
    const start = (await warnings(`HYPOTHESIS ${'😀'.repeat(200)}`))[0] ?? '';
    const shown = /незакрытого: «(.*?)»/su.exec(start)?.[1] ?? '';
    expect(shown.endsWith('😀…')).toBe(true);
    expect([...shown].length).toBe(101);
    expect(shown).not.toContain('�');

    const far = (await warnings(`${'😀'.repeat(200)} открыто ${'x'.repeat(200)}`))[0] ?? '';
    const middle = /незакрытого: «(.*?)»/su.exec(far)?.[1] ?? '';
    expect(middle).toContain('открыто');
    expect(middle.startsWith('…') && middle.endsWith('…')).toBe(true);
    expect([...middle].length).toBe(102);
    expect(middle).not.toContain('�');

    const end = (await warnings(`${'x'.repeat(300)} открыто`))[0] ?? '';
    const tail = /незакрытого: «(.*?)»/su.exec(end)?.[1] ?? '';
    expect(tail.endsWith(' открыто')).toBe(true);
    expect([...tail].length).toBe(101);
  });

  it('[ ] как раньше; пробный запуск — ни байта; --json — те же warnings; перенос не отказывает', async () => {
    const root = await project();
    await withPlan(root, body('- [ ] пункт\n\nHYPOTHESIS: проверить.'), { digest: null });
    const before = await snapshotTree(root);
    const preview = await archiveProject(root, { sections: ['Правка 1'] });
    expect(preview.sections[0]?.warnings).toEqual([expect.stringContaining('неотмеченных пунктов [ ]: 1'), expect.stringContaining('«HYPOTHESIS: проверить.»')]);

    const cli = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Правка 1'], cli.io)).toBe(0);
    expect(cli.stdout()).toContain('- Проверьте: в разделе «Правка 1» есть пометки незакрытого: «HYPOTHESIS: проверить.».');
    const json = collectIo();
    expect(await runMaestroCli(['archive', '--path', root, '--section', 'Правка 1', '--json'], json.io)).toBe(0);
    expect((JSON.parse(json.stdout()) as { sections: { warnings: string[] }[] }).sections[0]?.warnings).toEqual(preview.sections[0]?.warnings);
    expect(await snapshotTree(root)).toEqual(before);

    const applied = await archiveProject(root, { apply: true, sections: ['Правка 1'] });
    expect([applied.ok, applied.applied]).toEqual([true, true]);
    expect(await readUtf8(root, PLAN_ARCHIVE)).toContain('HYPOTHESIS: проверить.');
  });
});
