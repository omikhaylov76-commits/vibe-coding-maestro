import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { buildPreflight } from '../src/core/preflight.js';
import {
  PLAN_GOVERNANCES,
  PLAN_KINDS,
  PLAN_MODES,
  PLAN_RISKS,
  PLAN_SCALES,
  PLAN_STATUSES,
  validatePlanFrontmatter,
} from '../src/core/plan.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';

afterEach(cleanupTempDirs);

/** Минимальный валидный набор полей плана: базис для точечных мутаций. */
const BASE: Readonly<Record<string, string>> = {
  id: 'PLAN-0007',
  kind: 'feature',
  status: 'draft',
  scale: 'feature',
  mode: 'extension',
  governance: 'standard',
  risk: 'low',
  profiles: '[]',
  created: '2026-08-06',
  updated: '2026-08-06',
  sources: '[]',
  supersedes: 'null',
  approved_by: 'null',
  approved_at: 'null',
  active_phase: 'null',
};

function meta(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const result: Record<string, string> = { ...BASE };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

const codes = (overrides: Record<string, string | undefined> = {}): string[] =>
  validatePlanFrontmatter(meta(overrides)).issues.map((issue) => issue.code);

const planDoc = (overrides: Record<string, string | undefined> = {}): string =>
  `---\n${Object.entries(meta(overrides)).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n# План\n\nТело плана.\n`;

async function fresh(): Promise<string> {
  const target = await makeTempDir('plan-');
  const result = await initProject({ target, name: 'Plan Contract', startingPoint: 'idea', git: false, now: FIXED_NOW });
  expect(result.ok).toBe(true);
  return target;
}

async function writePlan(root: string, name: string, overrides: Record<string, string | undefined> = {}): Promise<void> {
  await writeFile(join(root, 'wiki/plans', name), planDoc(overrides), 'utf8');
}

/** Переписывает одно поле frontmatter в project-owned wiki/hot.md. */
async function setHotField(root: string, key: string, value: string | null): Promise<void> {
  const text = await readUtf8(root, 'wiki/hot.md');
  const line = new RegExp(`^${key}: .*$`, 'm');
  expect(line.test(text)).toBe(true);
  await writeFile(join(root, 'wiki/hot.md'), value === null ? text.replace(`${line.exec(text)?.[0] ?? ''}\n`, '') : text.replace(line, `${key}: ${value}`), 'utf8');
}

describe('0.3 Phase 0: plan frontmatter schema', () => {
  it('принимает канонический frontmatter и разбирает типизированные поля', () => {
    const { plan, issues } = validatePlanFrontmatter(meta({
      profiles: '[WEB_UI, CLI]',
      sources: '[maestro/inbox/README.md, https://example.invalid/brief]',
    }));
    expect(issues).toEqual([]);
    expect(plan).toEqual({
      id: 'PLAN-0007',
      kind: 'feature',
      status: 'draft',
      scale: 'feature',
      mode: 'extension',
      governance: 'standard',
      risk: 'low',
      profiles: ['WEB_UI', 'CLI'],
      created: '2026-08-06',
      updated: '2026-08-06',
      sources: ['maestro/inbox/README.md', 'https://example.invalid/brief'],
      supersedes: null,
      approvedBy: null,
      approvedAt: null,
      activePhase: null,
      blockingQuestions: null,
      specDelta: null,
      currentSlice: null,
      currentPhaseApproved: null,
    });
  });

  it('поля build gate необязательны, но проверяются по форме', () => {
    expect(codes({ blocking_questions: '0', spec_delta: 'none', current_slice: 'null' })).toEqual([]);
    expect(codes({ blocking_questions: '3', spec_delta: 'open', current_slice: '01-первая' })).toEqual([]);
    const parsed = validatePlanFrontmatter(meta({ blocking_questions: '2', spec_delta: 'resolved', current_slice: '02-вторая' })).plan;
    expect(parsed?.blockingQuestions).toBe(2);
    expect(parsed?.specDelta).toBe('resolved');
    expect(parsed?.currentSlice).toBe('02-вторая');

    for (const bad of ['-1', 'null', 'нет', '1.5', '']) {
      expect(codes({ blocking_questions: bad }), bad).toContain('plan-schema-invalid');
    }
    expect(codes({ spec_delta: 'нет' })).toContain('plan-schema-invalid');
    expect(codes({ current_slice: '../побег' })).toContain('plan-schema-invalid');
  });

  it('current_phase_approved имеет смысл только для program-плана', () => {
    expect(codes({ kind: 'program', current_phase_approved: 'yes' })).toEqual([]);
    expect(codes({ kind: 'program', current_phase_approved: 'может быть' })).toContain('plan-schema-invalid');
    expect(codes({ current_phase_approved: 'yes' })).toContain('plan-state-invalid');
  });

  it('разрешает необязательные type/title и отвергает поля вне схемы', () => {
    expect(validatePlanFrontmatter(meta({ type: 'plan', title: 'Название' })).issues).toEqual([]);
    expect(codes({ owner: 'кто-то' })).toContain('plan-schema-invalid');
  });

  it.each(Object.keys(BASE))('требует обязательное поле %s', (key) => {
    expect(codes({ [key]: undefined })).toContain('plan-schema-invalid');
  });

  it.each([
    ['kind', PLAN_KINDS],
    ['status', PLAN_STATUSES],
    ['scale', PLAN_SCALES],
    ['mode', PLAN_MODES],
    ['governance', PLAN_GOVERNANCES],
    ['risk', PLAN_RISKS],
  ] as const)('поле %s принимает только канонические значения', (field, allowed) => {
    for (const value of allowed) {
      // approval metadata обязательна для approved/active — проверяем только словарь.
      const approval = value === 'approved' || value === 'active'
        ? { approved_by: 'Оператор', approved_at: '2026-08-06' }
        : {};
      expect(codes({ [field]: value, ...approval }), `${field}=${value}`).toEqual([]);
    }
    expect(codes({ [field]: 'ЧУЖОЕ' })).toContain('plan-schema-invalid');
    expect(codes({ [field]: 'DRAFT' })).toContain('plan-schema-invalid');
  });

  it('id соответствует PLAN-nnnn', () => {
    expect(codes({ id: 'PLAN-0001' })).toEqual([]);
    expect(codes({ id: 'PLAN-00012' })).toEqual([]);
    for (const bad of ['PLAN-1', 'plan-0001', 'PLAN0001', 'PLAN-abcd', '0001']) {
      expect(codes({ id: bad }), bad).toContain('plan-schema-invalid');
    }
  });

  it('даты обязаны быть реальными YYYY-MM-DD', () => {
    expect(codes({ created: '2026-02-28' })).toEqual([]);
    for (const bad of ['06-08-2026', '2026-8-6', '2026-13-01', '2026-02-30', 'ГГГГ-ММ-ДД']) {
      expect(codes({ created: bad }), bad).toContain('plan-schema-invalid');
    }
  });

  it('profiles и sources обязаны быть flow-массивами с непустыми элементами', () => {
    expect(codes({ profiles: '[]', sources: '[]' })).toEqual([]);
    for (const bad of ['none', 'null', 'WEB_UI', '[WEB_UI', '[WEB_UI, ]', '[,]']) {
      expect(codes({ profiles: bad }), bad).toContain('plan-schema-invalid');
    }
    expect(codes({ profiles: '[web_ui]' })).toContain('plan-schema-invalid');
  });

  it('sources принимают project-relative путь и внешний URI, но не выход за пределы проекта', () => {
    expect(codes({ sources: '[maestro/inbox/README.md, https://example.invalid/x, git+ssh://host/repo.git]' })).toEqual([]);
    for (const bad of ['[../secret.md]', '[/etc/passwd]', '[wiki\\hot.md]']) {
      expect(codes({ sources: bad }), bad).toContain('plan-schema-invalid');
    }
  });

  it('supersedes — только null или другой PLAN-id (path/registry resolution отложены)', () => {
    expect(codes({ supersedes: 'null' })).toEqual([]);
    expect(codes({ supersedes: 'PLAN-0001' })).toEqual([]);
    expect(codes({ supersedes: 'PLAN-0007' })).toContain('plan-state-invalid');
    for (const bad of ['wiki/plans/0001-starter.md', 'none', 'PLAN']) {
      expect(codes({ supersedes: bad }), bad).toContain('plan-schema-invalid');
    }
  });

  it('approved и active требуют approved_by и approved_at', () => {
    for (const status of ['approved', 'active'] as const) {
      expect(codes({ status })).toContain('plan-approval-missing');
      expect(codes({ status, approved_by: 'Оператор' })).toContain('plan-approval-missing');
      expect(codes({ status, approved_at: '2026-08-06' })).toContain('plan-approval-missing');
      expect(codes({ status, approved_by: 'Оператор', approved_at: '2026-08-06' })).toEqual([]);
      expect(codes({ status, approved_by: 'Оператор', approved_at: '2026-08-06T10:00:00Z' })).toEqual([]);
      expect(codes({ status, approved_by: 'Оператор', approved_at: 'вчера' })).toContain('plan-schema-invalid');
    }
  });

  it('не утверждённые статусы не имеют права нести approval metadata', () => {
    for (const status of ['draft', 'in_review', 'rejected'] as const) {
      expect(codes({ status, approved_by: 'Оператор', approved_at: '2026-08-06' })).toContain('plan-approval-unexpected');
    }
  });

  it('active_phase допустим только у program-плана', () => {
    expect(codes({ kind: 'program', active_phase: '01-platform-shell-mvp' })).toEqual([]);
    expect(codes({ kind: 'feature', active_phase: '01-platform-shell-mvp' })).toContain('plan-state-invalid');
  });
});

describe('0.3 Phase 1: project-owned plan artifacts', () => {
  it('свежий проект получает plan location, README, шаблон и один draft plan', async () => {
    const target = await fresh();
    for (const path of ['wiki/plans/README.md', 'wiki/plans/TEMPLATE.md', 'wiki/plans/0001-starter.md']) {
      expect(existsSync(join(target, path)), path).toBe(true);
    }
    const starter = await readUtf8(target, 'wiki/plans/0001-starter.md');
    expect(starter).toContain('id: PLAN-0001');
    expect(starter).toContain('status: draft');
  });

  it('свежий проект объявляет active_plan: none и проходит doctor без единой находки', async () => {
    const target = await fresh();
    expect(await readUtf8(target, 'wiki/hot.md')).toContain('active_plan: none');
    const report = await doctorProject(target, { strict: true });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('README и TEMPLATE не считаются планами и не валидируются схемой', async () => {
    const target = await fresh();
    const report = await doctorProject(target, { strict: true });
    expect(report.findings.filter((finding) => finding.path?.startsWith('wiki/plans/'))).toEqual([]);
  });
});

describe('0.3 Phase 1: doctor plan validation', () => {
  it('отвергает план с нарушенной схемой', async () => {
    const target = await fresh();
    await writePlan(target, 'bad.md', { risk: 'катастрофический' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-schema-invalid', path: 'wiki/plans/bad.md' }));
  });

  it('отвергает approved план без человеческой approval metadata', async () => {
    const target = await fresh();
    await writePlan(target, 'approved.md', { id: 'PLAN-0002', status: 'approved' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-approval-missing', path: 'wiki/plans/approved.md' }));
  });

  it('принимает ровно один active план, синхронный с hot.md', async () => {
    const target = await fresh();
    await writePlan(target, 'active.md', { id: 'PLAN-0002', status: 'active', approved_by: 'Оператор', approved_at: '2026-08-06' });
    await setHotField(target, 'active_plan', 'plans/active.md');
    const report = await doctorProject(target, { strict: true });
    expect(report.findings).toEqual([]);
  });

  it('отвергает два active плана в одном project scope', async () => {
    const target = await fresh();
    const approval = { status: 'active', approved_by: 'Оператор', approved_at: '2026-08-06' };
    await writePlan(target, 'active-a.md', { id: 'PLAN-0002', ...approval });
    await writePlan(target, 'active-b.md', { id: 'PLAN-0003', ...approval });
    await setHotField(target, 'active_plan', 'plans/active-a.md');
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => finding.code === 'plan-multiple-active')).toBe(true);
  });

  it('отвергает active_plan вне wiki и на несуществующий файл', async () => {
    for (const declared of ['../secret.md', '/etc/passwd', 'plans/отсутствует.md', 'plans/starter.txt']) {
      const target = await fresh();
      await setHotField(target, 'active_plan', declared);
      const report = await doctorProject(target);
      expect(report.ok, declared).toBe(false);
      expect(report.findings.some((finding) => finding.code === 'hot-active-plan-invalid'), declared).toBe(true);
    }
  });

  it('отвергает рассинхронизацию hot.md и фактического состояния планов', async () => {
    const target = await fresh();
    await setHotField(target, 'active_plan', 'plans/0001-starter.md');
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'hot-active-plan-mismatch', path: 'wiki/hot.md' }));
  });

  it('обратная совместимость: hot.md 0.2 без active_plan читается как none', async () => {
    const target = await fresh();
    await setHotField(target, 'active_plan', null);
    expect((await readUtf8(target, 'wiki/hot.md')).split('---')[1]).not.toContain('active_plan');
    const report = await doctorProject(target, { strict: true });
    expect(report.findings).toEqual([]);
  });

  it('обратная совместимость: 0.2 hot.md без active_plan не скрывает active план', async () => {
    const target = await fresh();
    await writePlan(target, 'active.md', { id: 'PLAN-0002', status: 'active', approved_by: 'Оператор', approved_at: '2026-08-06' });
    await setHotField(target, 'active_plan', null);
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'hot-active-plan-mismatch', path: 'wiki/hot.md' }));
  });

  it('разрешает supersedes внутри project scope и отвергает неразрешимый id', async () => {
    const target = await fresh();
    await writePlan(target, 'v2.md', { id: 'PLAN-0002', supersedes: 'PLAN-0001' });
    expect((await doctorProject(target, { strict: true })).findings).toEqual([]);

    await writePlan(target, 'v3.md', { id: 'PLAN-0003', supersedes: 'PLAN-0404' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-supersedes-unresolved', path: 'wiki/plans/v3.md' }));
  });

  it('отвергает повторяющийся plan id', async () => {
    const target = await fresh();
    await writePlan(target, 'copy.md', { id: 'PLAN-0001' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-duplicate-id', path: 'wiki/plans/copy.md' }));
  });

  it('проверяет только project-relative sources и не трогает внешние provenance-ссылки', async () => {
    const target = await fresh();
    await writePlan(target, 'external.md', { id: 'PLAN-0002', sources: '[https://example.invalid/brief, git+ssh://host/repo.git]' });
    expect((await doctorProject(target, { strict: true })).findings).toEqual([]);

    await writePlan(target, 'local.md', { id: 'PLAN-0003', sources: '[maestro/inbox/README.md]' });
    expect((await doctorProject(target, { strict: true })).findings).toEqual([]);

    await writePlan(target, 'missing.md', { id: 'PLAN-0004', sources: '[maestro/inbox/нет-такого.md]' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-source-missing', path: 'wiki/plans/missing.md' }));
  });

  /**
   * DEFERRED BY DESIGN: cross-scope supersedes (program-планы, другие репозитории,
   * артефакты вне wiki/plans) требует plan registry, которого в минимальном контракте нет.
   * Половинчатая проверка запрещена, поэтому такие ссылки отвергаются форматом схемы,
   * а не «резолвятся наугад». Тест фиксирует это решение, чтобы Phase 2+ менял его осознанно.
   */
  it('DEFERRED: supersedes вне wiki/plans не резолвится, а отвергается схемой', async () => {
    const target = await fresh();
    await writePlan(target, 'cross.md', { id: 'PLAN-0002', supersedes: 'wiki/programs/game-platform/plans/01.md' });
    const report = await doctorProject(target);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'plan-schema-invalid', path: 'wiki/plans/cross.md' }));
    expect(report.findings.some((finding) => finding.code === 'plan-supersedes-unresolved')).toBe(false);
  });
});

/**
 * Граница 0.3 beta: активный план живёт ровно в `wiki/plans/`.
 *
 * `wiki/programs/<слаг>/` в этой бете — проектные материалы программы; doctor их
 * не перечисляет и планами не признаёт. Опасно здесь не само сужение, а молчаливое
 * расхождение двух слоёв: если preflight считает доказанным то, чего doctor не
 * видит, гейт разрешает код по документу, который никто не проверял. Поэтому оба
 * слоя читают ОДИН предикат из `core/plan.ts` и обязаны отвечать одинаково.
 */
describe('0.3 Phase 3: doctor и preflight согласованы на PROGRAM-раскладке', () => {
  const APPROVED_PHASE: Record<string, string> = {
    id: 'PLAN-0002',
    kind: 'phase',
    status: 'active',
    scale: 'program',
    approved_by: 'Оператор',
    approved_at: '2026-08-06',
    blocking_questions: '0',
    spec_delta: 'none',
    current_slice: 'shell-routing',
  };

  /** Проект с фазовым планом ровно по раскладке из protocols/plan.md. */
  async function programProject(): Promise<string> {
    const target = await fresh();
    await mkdir(join(target, 'wiki/programs/portal/plans'), { recursive: true });
    await writeFile(join(target, 'wiki/programs/portal/plans/0002-shell.md'), planDoc(APPROVED_PHASE), 'utf8');
    await setHotField(target, 'active_plan', 'programs/portal/plans/0002-shell.md');
    return target;
  }

  it('doctor отвергает active_plan вне wiki/plans', async () => {
    const report = await doctorProject(await programProject());
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'hot-active-plan-invalid', path: 'wiki/hot.md' }),
    );
  });

  it('preflight на том же проекте тоже закрывает гейт, а не разрешает сборку', async () => {
    const decision = await buildPreflight(await programProject(), { scale: 'program' });
    expect(decision.ok).toBe(false);
    expect(decision.slice).toBeNull();
    expect(decision.findings.map((item) => item.code)).toContain('preflight-plan-path-invalid');
  });

  it('плоский wiki/plans остаётся зелёным в обоих слоях', async () => {
    const target = await fresh();
    await writePlan(target, 'active.md', { ...APPROVED_PHASE, kind: 'feature', scale: 'feature' });
    await setHotField(target, 'active_plan', 'plans/active.md');

    expect((await doctorProject(target, { strict: true })).findings).toEqual([]);
    const decision = await buildPreflight(target, { scale: 'feature' });
    expect(decision.ok, JSON.stringify(decision.findings)).toBe(true);
    expect(decision.slice).toBe('shell-routing');
  });
});
