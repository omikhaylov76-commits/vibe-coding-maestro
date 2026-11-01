import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import { runMaestroCli } from '../src/cli/maestro.js';
import { initProject } from '../src/core/init.js';
import { VERSION } from '../src/core/meta.js';
import { cleanupTempDirs, makeTempDir, readUtf8, snapshotTree } from './helpers.js';

afterEach(cleanupTempDirs);

/**
 * Путь нового пользователя целиком, через те же команды, что он набирает:
 * create → doctor → план → утверждение → объявление → preflight → работа →
 * передача → upgrade. Агент правит файлы так, как велят протоколы, и ни один
 * шаг не должен покраснеть от того, что протокол сам попросил сделать.
 */

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    all: () => [...out, ...err].join('\n'),
  };
}

async function maestro(...argv: string[]): Promise<{ code: number; text: string }> {
  const cli = collect();
  const code = await runMaestroCli(argv, cli.io);
  return { code, text: cli.all() };
}

async function setField(root: string, path: string, key: string, value: string): Promise<void> {
  const text = await readUtf8(root, path);
  const pattern = new RegExp(`^${key}: .*$`, 'm');
  expect(text, `${path}: ${key}`).toMatch(pattern);
  await writeFile(join(root, path), text.replace(pattern, `${key}: ${value}`), 'utf8');
}

async function addField(root: string, path: string, after: string, line: string): Promise<void> {
  const text = await readUtf8(root, path);
  const pattern = new RegExp(`^(${after}: .*)$`, 'm');
  expect(text, `${path}: ${after}`).toMatch(pattern);
  await writeFile(join(root, path), text.replace(pattern, `$1\n${line}`), 'utf8');
}

describe('путь нового пользователя (0.3.0)', () => {
  it('от create до upgrade без единого ложного красного', async () => {
    const parent = await makeTempDir('journey-');
    const root = join(parent, 'Мой лендинг');

    // 1. Создание одной командой.
    const created = collect();
    expect(await runCreateCli(['--yes', '--target', root, '--name', 'Мой лендинг', '--start', 'idea'], created.io, { isTty: false })).toBe(0);
    expect(created.stdout()).toContain('Doctor: всё сходится.');

    // Правила Maestro подключаются сами и называют точную версию; двери проекта ссылаются на них.
    expect(await readUtf8(root, '.claude/rules/maestro.md')).toContain(`create-vibe-maestro@${VERSION} vibe-maestro doctor`);
    expect(await readUtf8(root, 'CLAUDE.md')).toContain('.claude/rules/maestro.md');
    const settings = JSON.parse(await readUtf8(root, '.claude/settings.json')) as { permissions: { deny: string[]; ask: string[] } };
    // С 0.4.0 агент может сам записать ключ в .env; от git его защищают .gitignore и doctor.
    expect(settings.permissions.deny.some((rule) => rule.includes('.env'))).toBe(false);
    expect(settings.permissions.deny).toContain('Edit(/wiki/plans/TEMPLATE.md)');
    expect(settings.permissions.ask).toContain('Bash(git push *)');

    // 2. Гейт закрыт: плана нет.
    let gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(1);
    expect(gate.text).toContain('preflight-plan-absent');

    // 3. Черновик плана по шаблону.
    const planPath = 'wiki/plans/0002-landing.md';
    const template = await readUtf8(root, 'wiki/plans/TEMPLATE.md');
    await writeFile(join(root, planPath), template
      .replace('PLAN-XXXX', 'PLAN-0002')
      .replace('title: Название плана', 'title: Лендинг')
      .replace(/YYYY-MM-DD/g, '2026-11-01'), 'utf8');
    expect((await maestro('doctor', '--path', root, '--strict')).code).toBe(0);

    // 4. «План утверждаю»: агент записывает поля, как велит wiki/plans/README.md.
    await setField(root, planPath, 'status', 'approved');
    await setField(root, planPath, 'approved_by', 'Олег');
    await setField(root, planPath, 'approved_at', '2026-11-01');
    await setField(root, planPath, 'current_slice', '01-hero');
    // Без объявления гейт подсказывает, что утверждённый план есть.
    gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(1);
    expect(gate.text).toContain('Утверждённый план есть, но не объявлен');
    await setField(root, 'wiki/hot.md', 'active_plan', 'plans/0002-landing.md');

    // Объявленный утверждённый план: doctor и preflight согласны.
    expect((await maestro('doctor', '--path', root, '--strict')).code).toBe(0);
    gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(0);
    expect(gate.text).toContain('Разрешённая порция: 01-hero');
    expect(gate.text).toContain('preflight-digest-missing');
    const digest = /Отпечаток плана: ([0-9a-f]{64})/.exec(gate.text)?.[1];
    expect(digest).toBeDefined();
    await addField(root, planPath, 'approved_at', `approved_digest: ${digest}`);
    gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(0);
    expect(gate.text).not.toContain('preflight-digest-missing');

    // 5. Работа началась.
    await setField(root, planPath, 'status', 'active');
    expect((await maestro('doctor', '--path', root, '--strict')).code).toBe(0);
    expect((await maestro('preflight', '--path', root)).code).toBe(0);

    // 6. Тихая правка цели после утверждения замечается обеими проверками.
    const approved = await readUtf8(root, planPath);
    await writeFile(join(root, planPath), approved.replace('Что должно стать правдой после выполнения. Одна фраза.', 'Магазин с оплатой.'), 'utf8');
    gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(1);
    expect(gate.text).toContain('preflight-plan-changed');
    expect((await maestro('doctor', '--path', root)).text).toContain('plan-changed-after-approval');
    await writeFile(join(root, planPath), approved, 'utf8');

    // 7. Запись хода работы по образцу и её объявление в hot.md.
    await cp(join(root, 'maestro/templates/progress.md'), join(root, 'wiki/progress/hero.md'));
    expect((await maestro('doctor', '--path', root)).text).toContain('hot-active-progress-mismatch');
    await setField(root, 'wiki/hot.md', 'active_progress', 'progress/hero.md');
    expect((await maestro('doctor', '--path', root, '--strict')).code).toBe(0);

    // 8. Передача по образцу, запись в карте и правки дверей проекта — всё это законно.
    await mkdir(join(root, 'wiki/handoffs'), { recursive: true });
    await cp(join(root, 'maestro/templates/handoff.md'), join(root, 'wiki/handoffs/2026-11-01-hero.md'));
    const index = await readUtf8(root, 'wiki/index.md');
    await writeFile(join(root, 'wiki/index.md'), `${index}\n- [handoffs/2026-11-01-hero.md](handoffs/2026-11-01-hero.md) — первая передача.\n- [../protocols/plan.md](../protocols/plan.md) — как устроено планирование.\n`, 'utf8');
    await writeFile(join(root, 'CLAUDE.md'), `${await readUtf8(root, 'CLAUDE.md')}\n## Стек\n\n- Astro, без backend.\n`, 'utf8');
    await writeFile(join(root, '.claude/rules/project.md'), `${await readUtf8(root, '.claude/rules/project.md')}\n- Тесты: npm test.\n`, 'utf8');
    const editedSettings = { permissions: { deny: settings.permissions.deny, ask: settings.permissions.ask.filter((rule) => rule !== 'Bash(git push *)') } };
    await writeFile(join(root, '.claude/settings.json'), `${JSON.stringify(editedSettings, null, 2)}\n`, 'utf8');
    const doctor = await maestro('doctor', '--path', root, '--strict');
    // С 0.4.2 doctor честно говорит, что копии в облаке нет; это info, а не замечание.
    const [verdict, ...notes] = doctor.text.split('\n');
    expect(verdict).toBe('Vibe Coding Maestro doctor: всё сходится.');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^- git-no-remote: Копии проекта в облаке нет/);
    expect(doctor.code).toBe(0);

    // 9. Обновлять нечего; клон под другим именем — тот же проект.
    expect((await maestro('upgrade', '--path', root)).text).toContain('уже соответствует канону');
    const clone = join(parent, 'landing-clone');
    await cp(root, clone, { recursive: true });
    const cloned = await maestro('doctor', '--path', clone, '--strict');
    expect(cloned.code).toBe(0);
    expect(cloned.text).toContain('project-folder-renamed');
  });
});

describe('0.3.0: отдельные договорённости', () => {
  it('frontmatter понимает комментарии и блочные списки', async () => {
    const root = join(await makeTempDir('frontmatter-'), 'проект');
    expect(await runCreateCli(['--yes', '--no-git', '--target', root], collect().io, { isTty: false })).toBe(0);
    const plan = (await readUtf8(root, 'wiki/plans/0001-starter.md'))
      .replace(/^profiles: \[\]$/m, '# профили риска\nprofiles:\n  - SECURITY\n  - DATA');
    await writeFile(join(root, 'wiki/plans/0001-starter.md'), plan, 'utf8');
    await writeFile(join(root, 'wiki/concepts/без-шапки.md'), '# Заметка без frontmatter\n', 'utf8');
    const doctor = await maestro('doctor', '--path', root, '--strict');
    expect(doctor.text).toBe('Vibe Coding Maestro doctor: всё сходится.');
  });

  it('повторный create без --name в другой день не переписывает имя и даты', async () => {
    const root = join(await makeTempDir('rerun-'), 'папка');
    const first = await initProject({ target: root, name: 'Красивое имя', startingPoint: 'idea', git: false, now: new Date('2026-08-02T10:00:00.000Z') });
    expect(first.ok, first.error).toBe(true);
    expect(await readUtf8(root, 'maestro/inbox/README.md')).toContain('Красивое имя');
    const before = await snapshotTree(root);
    // Тот же проект без --name и через три месяца: ни имя, ни даты в файлах Maestro не меняются.
    const again = await initProject({ target: root, startingPoint: 'idea', git: false, now: new Date('2026-11-01T10:00:00.000Z') });
    expect(again.ok, again.error).toBe(true);
    expect(await snapshotTree(root)).toEqual(before);
  });

  it('прерванный create оставляет метку, и doctor и create говорят, что делать', async () => {
    const root = join(await makeTempDir('interrupted-'), 'проект');
    expect(await runCreateCli(['--yes', '--no-git', '--target', root], collect().io, { isTty: false })).toBe(0);
    await writeFile(join(root, '.maestro/creating'), '2026-11-01T00:00:00.000Z\n', 'utf8');
    const doctor = await maestro('doctor', '--path', root);
    expect(doctor.code).toBe(1);
    expect(doctor.text).toContain('create-interrupted');
    const again = collect();
    expect(await runCreateCli(['--yes', '--no-git', '--target', root], again.io, { isTty: false })).toBe(1);
    expect(again.stderr()).toContain('был прерван');
  });

  it('upgrade оставляет .claude/settings.json, который проект завёл сам до 0.3.0', async () => {
    const data = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/published/0.3.0-beta.3-standard.json'), 'utf8')) as { folder: string; files: Record<string, string> };
    const root = join(await makeTempDir('own-settings-'), data.folder);
    for (const [path, content] of Object.entries(data.files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content, 'utf8');
    }
    const own = '{\n  "permissions": { "allow": ["Bash(git push *)"] }\n}\n';
    await writeFile(join(root, '.claude/settings.json'), own, 'utf8');
    const result = await maestro('upgrade', '--path', root, '--apply');
    expect(result.code, result.text).toBe(0);
    expect(await readUtf8(root, '.claude/settings.json')).toBe(own);
    expect(result.text).toContain('Передано проекту');
  });
});
