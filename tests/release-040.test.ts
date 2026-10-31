import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';

afterEach(cleanupTempDirs);

/** Шаблон пакета с LF: в checkout на Windows он может прийти с CRLF, а init пишет LF. */
const template = async (path: string): Promise<string> => (await readFile(join(process.cwd(), 'templates/project', path), 'utf8')).replace(/\r\n/g, '\n');

async function newProject(): Promise<string> {
  const root = join(await makeTempDir('release-040-'), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

describe('0.4.0: ключи API без поиска файлов', () => {
  it('settings.json не запрещает .env, а .gitignore и doctor по-прежнему не пускают его в git', async () => {
    const root = await newProject();
    const settings = JSON.parse(await readUtf8(root, '.claude/settings.json')) as { permissions: { deny: string[]; ask: string[] } };
    expect(settings.permissions.deny.filter((rule) => rule.includes('.env'))).toEqual([]);
    const gitignore = (await readUtf8(root, '.gitignore')).split('\n');
    for (const line of ['.env', '.env.*', '!.env.example']) expect(gitignore).toContain(line);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('правила Maestro описывают оба способа и честную оговорку', async () => {
    const rules = await template('.claude/rules/maestro.md');
    expect(rules).toContain('запиши его в `.env`');
    expect(rules).toContain('в ответах не повторяй');
    expect(rules).toContain('`touch .env && open -e .env`');
    expect(rules).toContain('остаётся в истории');
    // Окно для ключа: сначала имя переменной, чтобы человек вставил значение после `=`.
    expect(rules).toContain('после `=`');
    expect(rules).toContain('`cut -d= -f1 .env`');
    // Старый запрет снимается только по «да» человека.
    expect(rules).toMatch(/Read.*\.env[\s\S]*«да»/);
  });
});

describe('0.4.0: субагенты и секреты', () => {
  it.each(['.claude/agents/explorer.md', '.claude/agents/code-reviewer.md'])('%s не открывает .env', async (path) => {
    expect(await template(path)).toContain('`.env`');
  });
});

describe('0.4.0: .gitignore шаблона', () => {
  it('новый проект не отдаёт в git временные рабочие копии и личные настройки', async () => {
    const root = await newProject();
    const lines = (await readUtf8(root, '.gitignore')).split('\n');
    expect(lines).toContain('.claude/worktrees/');
    expect(lines).toContain('.claude/settings.local.json');
  });
});

describe('0.4.0: паспорт проекта', () => {
  it('создаётся у каждой глубины и принадлежит проекту', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      expect(canonicalOwnershipInventory(depth)['wiki/passport.md'], depth).toBe('project-owned');
    }
    const root = await newProject();
    expect(await readUtf8(root, 'wiki/passport.md')).toBe(await template('wiki/passport.md'));
    expect(await readUtf8(root, 'wiki/index.md')).toContain('[passport.md](passport.md)');
  });

  it('содержит все разделы, «не применимо» и запрет значений секретов', async () => {
    const passport = await template('wiki/passport.md');
    for (const heading of [
      '## Репозиторий',
      '## Где работает',
      '## Домен и DNS',
      '## Данные, базы, резервные копии',
      '## Внешние сервисы и чей аккаунт',
      '## Переменные окружения',
      '## Расписания и фоновые задачи',
      '## Как запустить, обновить, откатить',
    ]) expect(passport, heading).toContain(heading);
    expect(passport).toContain('Тег сдачи');
    expect(passport).toContain('«не применимо»');
    expect(passport).toContain('«Пока нет» значит «ещё не заполнено»');
    expect(passport).toContain('значения — никогда');
    expect(passport).toContain('без кода');
    // Подстановок нет: upgrade создаёт паспорт и в проекте, где имя проекта не восстановить.
    expect(passport).not.toContain('{{');
  });
});

describe('0.4.0: протокол «Завершение»', () => {
  it('управляемый файл Maestro, подключён из router и правил', async () => {
    expect(canonicalOwnershipInventory('light')['protocols/completion.md']).toBe('managed');
    expect(await template('protocols/build.md')).toContain('[завершение проекта](completion.md)');
    expect(await template('.claude/rules/maestro.md')).toContain('`protocols/completion.md`');
  });

  it('чек-лист сдачи, закрытие без сдачи и упаковка командой pack', async () => {
    const completion = await template('protocols/completion.md');
    for (const item of ['Критерии «готово»', 'зелёные', 'Тег сдачи', '`wiki/passport.md`', 'Документы для заказчика', 'смените все пароли и ключи', 'Итоговая передача', '`status: completed`', '`active_plan: none`', 'Уроки']) {
      expect(completion, item).toContain(item);
    }
    expect(completion).toContain('### Закрытие внутреннего проекта без сдачи');
    expect(completion).toContain('vibe-maestro pack --path . --tag vX.Y.Z');
    expect(completion).toContain('<a id="VCM-COMPLETION"></a>');
  });
});

describe('0.4.0: новая сессия после закрытой порции', () => {
  it.each(['.claude/rules/maestro.md', 'protocols/build.md', 'protocols/handoff.md'])('%s: передача дел, новая сессия, вторая крупная порция только с согласия', async (path) => {
    const text = await template(path);
    expect(text).toContain('новую сессию');
    expect(text).toMatch(/[Вв]торую крупную порцию в той же сессии без (его )?согласия( человека)? не начина/);
  });
});
