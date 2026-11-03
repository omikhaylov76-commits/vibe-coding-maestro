import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMaestroCli } from '../src/cli/maestro.js';
import { HANDOFF_LIMIT, HOT_LIMIT, LOG_LIMIT, PLAN_LIMIT } from '../src/core/archive/limits.js';
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

describe('0.4.4: doctor сообщает о длине памяти, ничего не блокируя', () => {
  async function project(): Promise<string> {
    const root = join(await makeTempDir('memory-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    return root;
  }

  /** Дописывает к файлу строк до размера ровно `size` знаков (перевод строки — один знак). */
  async function grow(root: string, path: string, size: number, eol = '\n'): Promise<void> {
    const text = (await readUtf8(root, path).catch(() => '# Текст\n')).replace(/\r\n/g, '\n');
    const missing = size - Array.from(text).length;
    expect(missing).toBeGreaterThan(0);
    await writeFile(join(root, path), `${text}${'я'.repeat(missing - 1)}\n`.replace(/\n/g, eol), 'utf8');
  }

  async function memory(root: string): Promise<{ code: string; level: string; path?: string; message: string }[]> {
    return (await doctorProject(root)).findings.filter((item) => item.code.startsWith('memory-'));
  }

  it('ниже порога и на самом пороге — ничего; выше — одна info с числом знаков, ориентиром и что делать', async () => {
    const root = await project();
    await grow(root, 'wiki/log.md', LOG_LIMIT);
    await grow(root, 'wiki/hot.md', HOT_LIMIT);
    expect(await memory(root)).toEqual([]);

    await grow(root, 'wiki/log.md', LOG_LIMIT + 1);
    await grow(root, 'wiki/hot.md', HOT_LIMIT + 1);
    const found = await memory(root);
    expect(found.map((item) => [item.code, item.level, item.path])).toEqual([
      ['memory-hot-long', 'info', 'wiki/hot.md'],
      ['memory-log-long', 'info', 'wiki/log.md'],
    ]);
    expect(found[0]?.message).toContain('6 001 знаков при ориентире 6 000');
    expect(found[0]?.message).toContain('перепишите его коротко');
    expect(found[1]?.message).toContain('20 001 знаков при ориентире 20 000');
    expect(found[1]?.message).toContain('archive --path');
  });

  it('--strict и preflight не падают от длинной памяти', async () => {
    const root = await project();
    await grow(root, 'wiki/log.md', LOG_LIMIT + 1);
    expect((await doctorProject(root, { strict: true })).ok).toBe(true);
    const cli = collectIo();
    expect(await runMaestroCli(['doctor', '--path', root, '--strict'], cli.io)).toBe(0);
  });

  it('план — только объявленный; сообщение называет archive --section', async () => {
    const root = await project();
    const text = ['---', 'type: plan', 'title: Вход', 'id: PLAN-0002', 'kind: mini', 'status: approved', 'scale: quick', 'mode: extension',
      'governance: standard', 'risk: low', 'profiles: []', 'created: 2026-11-01', 'updated: 2026-11-01', 'sources: []',
      'supersedes: null', 'approved_by: Человек', 'approved_at: 2026-11-01', 'active_phase: null', '---', '', '# Вход', ''].join('\n');
    await writeFile(join(root, 'wiki/plans/0002-quick.md'), text, 'utf8');
    await grow(root, 'wiki/plans/0002-quick.md', PLAN_LIMIT + 1);
    expect(await memory(root)).toEqual([]);

    await writeFile(join(root, 'wiki/hot.md'), (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0002-quick.md'), 'utf8');
    const found = await memory(root);
    expect(found.map((item) => [item.code, item.path])).toEqual([['memory-plan-long', 'wiki/plans/0002-quick.md']]);
    expect(found[0]?.message).toContain('archive --path');
    expect(found[0]?.message).toContain('--section "<начало заголовка>"');
  });

  it('передачи: только с самой поздней датой в имени (несколько в один день — все); прочие имена не проверяются', async () => {
    const root = await project();
    const long = 'я'.repeat(HANDOFF_LIMIT + 1);
    for (const name of ['2026-10-30-old.md', '2026-11-02-a.md', '2026-11-02-b.md', 'черновик.md', '2026-11-40-bad.md']) await writeFile(join(root, 'wiki/handoffs', name), long, 'utf8');
    await writeFile(join(root, 'wiki/handoffs/2026-11-02-short.md'), 'коротко', 'utf8');
    expect((await memory(root)).map((item) => [item.code, item.path])).toEqual([
      ['memory-handoff-long', 'wiki/handoffs/2026-11-02-a.md'],
      ['memory-handoff-long', 'wiki/handoffs/2026-11-02-b.md'],
    ]);
  });

  it('CRLF не меняет счёт', async () => {
    const root = await project();
    await grow(root, 'wiki/log.md', LOG_LIMIT, '\r\n');
    expect(await memory(root)).toEqual([]);
    await grow(root, 'wiki/log.md', LOG_LIMIT + 1, '\r\n');
    expect((await memory(root)).map((item) => item.code)).toEqual(['memory-log-long']);
  });
});

describe('0.4.4: договор текстов о памяти', () => {
  const template = (path: string): Promise<string> => readFile(join(process.cwd(), 'templates/project', path), 'utf8');
  const RESULT_LINE = '` → [итог](../handoffs/<имя файла>.md)`';
  const ARCHIVES = ['wiki/log/', 'wiki/plans/archive/', 'wiki/audits/archive/'];

  it('одно правило об итоге порции: в протоколах передачи и работы, в README планов и шаблоне плана — одна и та же строка', async () => {
    for (const path of ['protocols/handoff.md', 'protocols/build.md', 'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md']) {
      const text = (await template(path)).replace(/\s+/g, ' ');
      expect(text, path).toContain('Итог порции — в передаче; в плане одна строка');
      expect(text, path).toContain(RESULT_LINE);
    }
    for (const path of ['protocols/handoff.md', 'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md']) {
      expect((await template(path)).replace(/\s+/g, ' '), path).toMatch(/[Ии]тог, приёмку и переход к следующей порции (?:в план|сюда) не (?:пиши|пишут)/);
    }
    expect(await template('maestro/templates/handoff.md')).toContain('Итог порции — здесь, а не в плане');
  });

  it('строка итога из шаблона — та, что отпечаток пропускает: другое имя файла, без пробела', () => {
    const line = (tail: string): string => `---\nid: PLAN-0001\n---\n\n1. [x] Порция.${tail}\n`;
    expect(planBodyDigest(line(' → [итог](../handoffs/2026-11-03-vhod.md)'))).toBe(planBodyDigest(line('')));
  });

  it('пороги в тексте равны порогам в коде', async () => {
    const number = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    expect(await template('protocols/build.md')).toContain(`до ${number(HOT_LIMIT)} знаков, примерно 60 строк`);
    expect(await template('protocols/handoff.md')).toContain(`до ${number(HANDOFF_LIMIT)} знаков`);
    expect(await template('protocols/wiki.md')).toContain(`порога (${number(LOG_LIMIT)} знаков)`);
    expect(await template('wiki/log.md')).toContain(`${number(LOG_LIMIT)} знаков`);
    expect(await template('protocols/build.md')).not.toContain('до 60 строк');
  });

  it('архив читается поиском: правило есть везде, где решают, что читать', async () => {
    for (const path of ['.claude/rules/maestro.md', 'protocols/wiki.md', 'protocols/plan.md', 'protocols/build.md']) {
      const text = await template(path);
      for (const archive of ARCHIVES) expect(text, `${path}: ${archive}`).toContain(archive);
      expect(text, path).toContain('ищи по имени или слову и читай найденный кусок');
    }
    expect(await template('protocols/status.md')).toContain('архив не читай');
    expect(await template('protocols/wiki.md')).toContain('в отличие от `wiki/attic/`');
  });

  it('archive запускает агент при передаче, сам; при завершении — до итоговой передачи', async () => {
    const handoff = await template('protocols/handoff.md');
    const steps = ['Добавь одну запись в конец `wiki/log.md`', 'vibe-maestro archive --path .', 'Запусти `doctor`'].map((step) => handoff.indexOf(step));
    expect(steps.every((at) => at !== -1)).toBe(true);
    expect([...steps].sort((left, right) => left - right)).toEqual(steps);
    expect(handoff).toContain('без вопроса человеку');
    expect(handoff).toContain('«убрал старое в архив, ничего не удалено»');
    const completion = await template('protocols/completion.md');
    expect(completion.indexOf('vibe-maestro archive --path .')).toBeLessThan(completion.indexOf('Итоговая передача дел'));
  });

  it('новый план: порции списком с [ ]; раздел правок — ниже порядка работ и выше «Утверждение»; стартовый план — тоже с [ ]', async () => {
    const plan = await template('wiki/plans/TEMPLATE.md');
    expect(plan).toContain('1. [ ] Первая порция');
    expect(plan.indexOf('## Порядок работ')).toBeLessThan(plan.indexOf('## Правки после утверждения'));
    expect(plan.indexOf('## Правки после утверждения')).toBeLessThan(plan.indexOf('## Утверждение'));
    expect(await template('wiki/plans/0001-starter.md')).toContain('1. [ ] Пройти `/start`');
    for (const path of ['protocols/plan.md', 'protocols/build.md', 'wiki/plans/README.md']) expect(await template(path), path).toContain('### Правка N — суть (дата)');
  });

  it('правила Maestro — не длиннее 45 строк', async () => {
    expect((await template('.claude/rules/maestro.md')).trimEnd().split('\n').length).toBeLessThanOrEqual(45);
  });

  it.each(['light', 'standard', 'advanced'] as const)('свежий проект %s: doctor --strict зелёный, ссылок на папки архива нет', async (depth) => {
    const root = join(await makeTempDir('fresh-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', depth, git: false, now: FIXED_NOW })).ok).toBe(true);
    expect((await doctorProject(root, { strict: true })).findings.filter((item) => item.level !== 'info')).toEqual([]);
    const index = await readUtf8(root, 'wiki/index.md');
    expect(index).toContain('`plans/archive/`');
    expect(index).not.toMatch(/\]\((?:log|plans\/archive|audits\/archive)\//);
  });
});
