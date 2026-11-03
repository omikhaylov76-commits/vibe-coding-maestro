import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { legacyPlanBodyDigest, planBodyDigest, planDigestMatches } from '../src/core/plan.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';
import { collectIo } from './published.js';

afterEach(cleanupTempDirs);

describe('0.4.4: строка итога у закрытой порции не сбивает отпечаток', () => {
  const PLAN = 'wiki/plans/0002-quick.md';
  const RESULT = ' → [итог](../handoffs/2026-11-03-vhod.md)';
  const WORK = [
    '## Порядок работ', '',
    '1. [ ] Порция один — вход.',
    '2. [ ] Порция два — выход;',
    '   продолжение пункта.',
    '3. Порция три без отметки.', '',
    '## Как проверим', '',
    '- [ ] тест входа зелёный', '',
  ].join('\n');

  /** Утверждённый объявленный мини-план; `digestOf` — каким способом посчитан отпечаток. */
  async function approved(body: string, digestOf: (text: string) => string = planBodyDigest): Promise<string> {
    const root = join(await makeTempDir('digest-'), 'проект');
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
    await writeFile(join(root, 'wiki/handoffs/2026-11-03-vhod.md'), '# Передача\n', 'utf8');
    return root;
  }

  async function edit(root: string, from: string, to: string): Promise<void> {
    const text = await readFile(join(root, PLAN), 'utf8');
    expect(text).toContain(from);
    await writeFile(join(root, PLAN), text.replace(from, to), 'utf8');
  }

  async function gate(root: string): Promise<{ preflight: number; doctor: string[] }> {
    const cli = collectIo();
    return {
      preflight: await runMaestroCli(['preflight', '--path', root], cli.io),
      doctor: (await doctorProject(root)).findings.map((item) => item.code),
    };
  }

  async function expectClosed(root: string): Promise<void> {
    const state = await gate(root);
    expect(state.preflight).not.toBe(0);
    expect(state.doctor).toContain('plan-changed-after-approval');
  }

  const OPEN = { preflight: 0, doctor: [] };

  it('[x] и точный хвост после утверждения: гейт открыт, doctor зелёный; отпечаток тот же', async () => {
    const root = await approved(WORK);
    const before = planBodyDigest(await readFile(join(root, PLAN), 'utf8'));
    await edit(root, '1. [ ] Порция один — вход.', `1. [x] Порция один — вход.${RESULT}`);
    expect(await gate(root)).toEqual(OPEN);
    expect(planBodyDigest(await readFile(join(root, PLAN), 'utf8'))).toBe(before);
  });

  it('гейт закрывают: хвост у [ ], второй хвост, другой текст ссылки, ссылка не в ../handoffs/, другой разделитель', async () => {
    const item = '1. [ ] Порция один — вход.';
    const closed = '1. [x] Порция один — вход.';
    for (const changed of [
      `${item}${RESULT}`,
      `${closed}${RESULT}${RESULT}`,
      `${closed} → [передача](../handoffs/2026-11-03-vhod.md)`,
      `${closed} → [итог](../audits/2026-11-03-vhod.md)`,
      `${closed} → [итог](../handoffs/../audits/vhod.md)`,
      `${closed} → [итог](../handoffs/2026-11-03-vhod.md#итог)`,
      `${closed} -> [итог](../handoffs/2026-11-03-vhod.md)`,
      `${closed} и ещё порция${RESULT} и хвост`,
    ]) {
      const root = await approved(WORK);
      await edit(root, item, changed);
      await expectClosed(root);
    }
  });

  it('правка текста пункта закрывает гейт, даже с хвостом', async () => {
    const root = await approved(WORK);
    await edit(root, '1. [ ] Порция один — вход.', `1. [x] Порция один — вход и выход.${RESULT}`);
    await expectClosed(root);
  });

  it('[x] у пункта без отметки закрывает гейт: отметку ставят только там, где есть [ ]', async () => {
    const root = await approved(WORK);
    await edit(root, '3. Порция три без отметки.', `3. [x] Порция три без отметки.${RESULT}`);
    await expectClosed(root);
  });

  it('многострочный пункт: хвост на строке с [x] — открыт, на строке продолжения — закрыт', async () => {
    const onMark = await approved(WORK);
    await edit(onMark, '2. [ ] Порция два — выход;', `2. [x] Порция два — выход;${RESULT}`);
    expect(await gate(onMark)).toEqual(OPEN);

    const onContinuation = await approved(WORK);
    await edit(onContinuation, '2. [ ] Порция два — выход;\n   продолжение пункта.', `2. [x] Порция два — выход;\n   продолжение пункта.${RESULT}`);
    await expectClosed(onContinuation);
  });

  it('CRLF и пробелы в конце строки не мешают: строка итога узнаётся так же', async () => {
    const root = await approved(WORK);
    const text = (await readFile(join(root, PLAN), 'utf8')).replace('1. [ ] Порция один — вход.', `1. [X] Порция один — вход.${RESULT}  `);
    await writeFile(join(root, PLAN), text.replace(/\n/g, '\r\n'), 'utf8');
    expect(planDigestMatches(/approved_digest: (\S+)/.exec(text)?.[1] ?? '', text.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('опора: на тексте без хвостов отпечатки равны посчитанным кодом настоящих 0.4.3 и 0.4.2', () => {
    const sample = ['---', 'type: plan', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension', 'governance: standard', 'risk: low', 'profiles: []', 'sources: []', 'supersedes: null', '---', '', '# Вход', '', '## Как проверим', '', '- [x] тест входа зелёный', '- [ ] doctor зелёный', ''].join('\n');
    // Посчитано `dist/core/plan.js` опубликованных create-vibe-maestro@0.4.3 и @0.4.2; в CI меток git нет.
    expect(planBodyDigest(sample)).toBe('f2d72a1db58004e1a011e6d4782d8f3682d9772cd32a9adc6886884e9d9a81d3');
    expect(legacyPlanBodyDigest(sample)).toBe('36833b4c708a75ff4ab79c00474166729f88407366a7fa7fbcd40598ea44bc83');
  });

  it('план с отпечатком 0.4.3: без правок зелёный, после [ ]→[x] с хвостом зелёный', async () => {
    const root = await approved(WORK.replace('- [ ] тест', '- [x] тест'));
    expect(await gate(root)).toEqual(OPEN);
    await edit(root, '1. [ ] Порция один — вход.', `1. [x] Порция один — вход.${RESULT}`);
    expect(await gate(root)).toEqual(OPEN);
  });

  it('план с отпечатком 0.4.2 без отметок: без правок зелёный, после [ ]→[x] с хвостом зелёный', async () => {
    const root = await approved(WORK, legacyPlanBodyDigest);
    expect(await gate(root)).toEqual(OPEN);
    await edit(root, '1. [ ] Порция один — вход.', `1. [x] Порция один — вход.${RESULT}`);
    expect(await gate(root)).toEqual(OPEN);
  });

  it('план с отпечатком 0.4.2 и отметками при утверждении: без правок зелёный, после [ ]→[x] с хвостом зелёный, хвост у прежней отметки — зелёный', async () => {
    const ticked = WORK.replace('- [ ] тест', '- [x] тест').replace('2. [ ] Порция два', '2. [x] Порция два');
    const root = await approved(ticked, legacyPlanBodyDigest);
    expect(await gate(root)).toEqual(OPEN);
    await edit(root, '1. [ ] Порция один — вход.', `1. [x] Порция один — вход.${RESULT}`);
    expect(await gate(root)).toEqual(OPEN);

    const tail = await approved(ticked, legacyPlanBodyDigest);
    await edit(tail, '2. [x] Порция два — выход;', `2. [x] Порция два — выход;${RESULT}`);
    expect(await gate(tail)).toEqual(OPEN);
  });

  it('строка итога уже была в тексте при утверждении отпечатком 0.4.3 или 0.4.2: без правок зелёный', async () => {
    const withResult = WORK.replace('1. [ ] Порция один — вход.', `1. [x] Порция один — вход.${RESULT}`);
    const digest043 = (text: string): string => legacyPlanBodyDigest(text.replace(/^1\. \[x\]/m, '1. [ ]').replace('- [x]', '- [ ]'));
    expect(await gate(await approved(withResult, digest043))).toEqual(OPEN);
    expect(await gate(await approved(withResult, legacyPlanBodyDigest))).toEqual(OPEN);
  });
});
