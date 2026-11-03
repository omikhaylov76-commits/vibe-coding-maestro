import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
