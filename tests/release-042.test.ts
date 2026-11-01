import { readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory } from '../src/core/inventory.js';
import { loadManifest } from '../src/core/manifest.js';
import { isReadmeName } from '../src/core/readme.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8, snapshotTree } from './helpers.js';

afterEach(cleanupTempDirs);

/** Шаблон пакета с LF: в checkout на Windows он может прийти с CRLF, а init пишет LF. */
const template = async (path: string): Promise<string> => (await readFile(join(process.cwd(), 'templates/project', path), 'utf8')).replace(/\r\n/g, '\n');

/** Раздел Markdown от заголовка до следующего заголовка того же или более высокого уровня. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = text.slice(start + heading.length);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest);
  return rest.slice(0, next === null ? undefined : next.index);
}

async function newProject(): Promise<string> {
  const root = join(await makeTempDir('release-042-'), 'проект');
  expect((await initProject({ target: root, startingPoint: 'materials', git: false, now: FIXED_NOW })).ok).toBe(true);
  return root;
}

describe('0.4.2: команда /start со своим протоколом', () => {
  it('протокол и команда — файлы Maestro; discovery входит в старт', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      const inventory = canonicalOwnershipInventory(depth);
      expect(inventory['protocols/start.md'], depth).toBe('managed');
      expect(inventory['.claude/commands/start.md'], depth).toBe('managed');
    }
    const ledger = JSON.parse(await readFile(join(process.cwd(), 'registry/capabilities.v1.json'), 'utf8')) as { capabilities: { id: string; ownerPath: string | null; contractId: string | null }[] };
    expect(ledger.capabilities.find((item) => item.id === 'project-start')).toMatchObject({ ownerPath: 'protocols/start.md', contractId: 'VCM-START' });
    expect(ledger.capabilities.find((item) => item.id === 'discovery-before-code')).toMatchObject({ ownerPath: 'protocols/start.md', contractId: 'VCM-DISCOVERY' });
    expect(await template('protocols/discovery.md')).toContain('[start](start.md)');
    expect(await template('protocols/discovery.md')).not.toContain('<a id=');
  });

  it('команда /start — тонкая ссылка на протокол', async () => {
    const command = await template('.claude/commands/start.md');
    expect(command).toContain('protocols/start.md');
    expect(command.split('\n').filter((line) => line.trim() !== '').length).toBeLessThanOrEqual(3);
    expect(command).not.toContain('<a id=');
  });

  it('сначала читает, что уже есть: исходную точку, материалы, описание, код', async () => {
    const read = section(await template('protocols/start.md'), '### 1. Сначала прочитай, что уже есть');
    for (const item of ['`starting_point`', '`maestro/inbox/`', 'Описание', 'Код', '`explorer`', 'vibe-maestro sources --path . --source <путь>', 'спроси путь', 'не правь и не удаляй']) {
      expect(read, item).toContain(item);
    }
  });

  it('как спрашивает: по одному, найденное — с источником и «верно?», UNKNOWN, черновик и продолжение', async () => {
    const ask = section(await template('protocols/start.md'), '### 2. Как спрашивать');
    expect(ask).toContain('По одному вопросу за раз');
    expect(ask).toContain('простыми словами');
    expect(ask).toContain('с источником и спроси «верно?»');
    expect(ask).toContain('Ни один блок не пропускается');
    expect(ask).toContain('«Не знаю» — нормальный ответ: запиши UNKNOWN и иди дальше');
    expect(ask).toContain('только когда без ответа нельзя');
    expect(ask).toContain('«Черновик старта»');
    expect(ask).toContain('`start: in_progress`');
    expect(ask).toContain('продолжает с первого вопроса без ответа');
  });

  it('о задаче — ровно семь вопросов в утверждённом порядке; сроки и бюджет не спрашиваются', async () => {
    const task = section(await template('protocols/start.md'), '### 3. О задаче — семь вопросов');
    const questions = task.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(questions).toHaveLength(7);
    for (const [index, start] of ['1. Что делаем', '2. Для кого', '3. Кому отдаём результат', '4. Что значит «готово»', '5. Что ещё есть, кроме прочитанного', '6. Чего не делаем', '7. Ограничения'].entries()) {
      expect(questions[index], start).toContain(start);
    }
    expect(questions[2]).toMatch(/себе.*заказчику, команде, работодателю/);
    expect(questions[6]).toMatch(/законы, правила площадок, чужие личные данные/);
    expect(task).toContain('Сроки и бюджет отдельно не спрашиваются. Назовёт человек сам — запиши');
  });

  it('как работаем — шесть вопросов, агент предлагает, у каждого значение по умолчанию', async () => {
    const work = section(await template('protocols/start.md'), '### 4. Как работаем — шесть вопросов');
    expect(work).toContain('агент предлагает ответ, человек подтверждает или меняет');
    expect(work).toContain('На «не знаю» действует предложение агента');
    const questions = work.split('\n').filter((line) => /^\d+\. /.test(line));
    expect(questions).toHaveLength(6);
    for (const question of questions) expect(question).toContain('По умолчанию:');
    expect(questions[0]).toContain('от вашего имени агент не пишет никому');
    expect(questions[1]).toMatch(/деньги, публикация, отправка в облако, сообщения людям, удаление, чужой код, смена настроек — только после «да»/);
    expect(questions[2]).toContain('По умолчанию: ждать слова «начинай»');
    expect(questions[3]).toMatch(/FACT.*HYPOTHESIS.*UNKNOWN/);
    expect(questions[3]).toContain('один раз');
    expect(questions[4]).toMatch(/в чат.*в окно/);
    expect(questions[4]).toContain('Пароли и коды подтверждения вводит человек');
    expect(questions[5]).toContain('восстановить');
    expect(questions[5]).toContain('закрытая копия в облаке');
  });

  it('финал: сводка на одном экране, ритм порций, запись только после «да», защиты — по отдельному «да»', async () => {
    const protocol = await template('protocols/start.md');
    const final = section(protocol, '### 5. Сводка и запись');
    expect(final).toContain('сводку на одном экране');
    expect(final).toContain('UNKNOWN');
    expect(final).toContain('порциями');
    expect(final).toContain('Ритм — правило Maestro, его не спрашивают');
    expect(final).toContain('только после «да» человека на сводку');
    for (const place of ['`wiki/concepts/discovery.md`', '`start: done`', 'раздел «Как работаем» файла `.claude/rules/project.md`', 'другие разделы этого файла не трогай', '`wiki/restore.md`', '`wiki/passport.md`, раздел «Репозиторий»']) {
      expect(final, place).toContain(place);
    }
    expect(final).toContain('только по отдельному «да»');
    expect(final).toContain('`/plan`');
    expect(protocol).toContain('Правила честности из `.claude/rules/maestro.md` он не отменяет и не ослабляет');
    // «Отправку без вопроса» предлагает, только когда копия в облаке есть.
    expect(section(protocol, '### 4. Как работаем — шесть вопросов')).toContain('Копия в облаке закрытая — предложи «отправку в облако без вопроса»');
  });

  it('рецепт «отправки без вопроса» в протоколе совпадает с руководством', async () => {
    const final = section(await template('protocols/start.md'), '### 5. Сводка и запись');
    const guide = await readFile(join(process.cwd(), 'docs/USER_GUIDE.md'), 'utf8');
    const block = /"allow": \[("Bash\(git push \*\)")\],\n\s+"ask": \[([\s\S]*?)\]/.exec(guide);
    expect(block).not.toBeNull();
    expect(final).toContain(`"allow": [${block?.[1]}]`);
    const forced = (block?.[2] ?? '').match(/"Bash\(git push [^"]+\)"/g) ?? [];
    expect(forced).toHaveLength(6);
    for (const rule of forced) expect(final, rule).toContain(rule);
  });

  it('перезапуск пересматривает договорённости и меняет только раздел «Как работаем»', async () => {
    const restart = section(await template('protocols/start.md'), '### 6. Перезапуск');
    expect(restart).toContain('`/start` можно запустить снова');
    expect(restart).toContain('спрашивай только об этом');
    expect(restart).toContain('меняется только раздел «Как работаем»');
  });
});

describe('0.4.2: место ответов старта', () => {
  it('discovery.md нового проекта: признак start: not_started и разделы семи вопросов', async () => {
    const root = await newProject();
    const discovery = await readUtf8(root, 'wiki/concepts/discovery.md');
    expect(discovery).toMatch(/^---\n[\s\S]*\nstart: not_started\n[\s\S]*?---\n/);
    expect(discovery).toContain('starting_point: materials');
    for (const heading of ['## Что делаем', '## Для кого', '## Кому отдаём результат', '## Что значит «готово»', '## Что ещё есть', '## Чего не делаем', '## Ограничения', '## Неизвестно (UNKNOWN)', '## Черновик старта']) {
      expect(discovery, heading).toContain(heading);
    }
    for (const value of ['`not_started`', '`in_progress`', '`done`', '`skipped`']) expect(discovery, value).toContain(value);
  });

  it('rules/project.md: раздел «Как работаем» заполняет /start, чужие разделы не трогаются', async () => {
    const rules = await template('.claude/rules/project.md');
    expect(rules).toContain('## Как работаем');
    expect(section(rules, '## Как работаем')).toContain('повторный `/start` меняет только этот раздел, другие разделы файла не трогает');
  });

  it('wiki/restore.md: файл проекта, что в облаке и чего там нет, что поставить, как забрать и проверить', async () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      expect(canonicalOwnershipInventory(depth)['wiki/restore.md'], depth).toBe('project-owned');
    }
    const restore = await template('wiki/restore.md');
    for (const heading of ['## Что лежит в облаке', '## Чего в облаке нет', '## Что поставить', '## Как забрать', '## Как проверить']) {
      expect(restore, heading).toContain(heading);
    }
    expect(restore).toContain('[паспорте](passport.md), раздел «Репозиторий»; здесь он не повторяется');
    expect(restore).toContain('`.env`');
    expect(restore).toContain('`.claude/settings.local.json`');
    // Подстановок нет: upgrade создаёт страницу и там, где имя проекта не восстановить.
    expect(restore).not.toContain('{{');
    const root = await newProject();
    expect(await readUtf8(root, 'wiki/index.md')).toContain('[restore.md](restore.md)');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('settings.json нового проекта запрещает правку команды /start', async () => {
    const root = await newProject();
    const settings = JSON.parse(await readUtf8(root, '.claude/settings.json')) as { permissions: { deny: string[] } };
    expect(settings.permissions.deny).toContain('Edit(/.claude/commands/start.md)');
  });
});

describe('0.4.2: /plan не переспрашивает', () => {
  it('Stage A читает признак старта, предлагает пройти его один раз, отказ — start: skipped', async () => {
    const plan = await template('protocols/plan.md');
    const intake = section(plan, '## Stage A — Intake');
    expect(intake).toContain('[старт](start.md)');
    expect(intake).toContain('поле `start:` в шапке `wiki/concepts/discovery.md`');
    expect(intake).toContain('Читай их и не переспрашивай');
    expect(intake).toContain('`not_started`, `in_progress` или поля нет — старт не пройден: один раз предложи «старт не пройден — пройдём сейчас?»');
    expect(intake).toContain('Отказ — запиши `start: skipped`');
    expect(intake).toContain('спрашивай только то, без чего план не составить');
    expect(intake).toContain('`skipped` — человек уже отказался: старт не предлагай');
    expect(await template('.claude/commands/plan.md')).toContain('Ответы `/start` не переспрашивай');
  });

  it('runbook Cowork больше не запрещает старту писать discovery', async () => {
    const runbook = await template('maestro/runbooks/cowork-discovery.md');
    expect(runbook).not.toContain('не переписывает');
    expect(runbook).toContain('`/start`');
    expect(runbook).toContain('`protocols/start.md`');
    expect(runbook).toContain('`maestro/inbox/`');
  });
});

describe('0.4.2: README проекта', () => {
  it('новый проект получает README, который просит переписать его своими словами и ведёт к restore.md', async () => {
    const root = await newProject();
    const readme = await readUtf8(root, 'README.md');
    expect(readme).toContain('Этот файл видят первым');
    expect(readme).toContain('перепишите его своими словами');
    expect(readme).toContain('получателя');
    expect(readme).toContain('`wiki/restore.md`');
    // README не входит в состав, который проверяет doctor: его можно удалить.
    const manifest = await loadManifest(root);
    expect(manifest.inventory.map((entry) => entry.path)).not.toContain('README.md');
    await rm(join(root, 'README.md'));
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('повторный create не возвращает удалённый README и не трогает свой', async () => {
    const root = await newProject();
    await rm(join(root, 'README.md'));
    const before = await snapshotTree(root);
    expect((await initProject({ target: root, startingPoint: 'materials', git: false, now: FIXED_NOW })).ok).toBe(true);
    expect(existsSync(join(root, 'README.md'))).toBe(false);
    expect(await snapshotTree(root)).toEqual(before);

    await writeFile(join(root, 'README.md'), 'Мой README\n', 'utf8');
    expect((await initProject({ target: root, startingPoint: 'materials', git: false, now: FIXED_NOW })).ok).toBe(true);
    expect(await readUtf8(root, 'README.md')).toBe('Мой README\n');
  });

  it('любое имя README в любом регистре и с любым расширением считается README', () => {
    for (const name of ['README', 'README.md', 'readme.md', 'Readme.txt', 'README.rst', 'README.zh.md']) expect(isReadmeName(name), name).toBe(true);
    for (const name of ['READ.md', 'my-readme.md', 'readmes', 'docs']) expect(isReadmeName(name), name).toBe(false);
  });
});

describe('0.4.2: один первый шаг везде — создание → /start → /plan', () => {
  /** `/start` назван раньше `/plan`. */
  const startThenPlan = (text: string, where: string): void => {
    const start = text.indexOf('/start');
    expect(start, `${where}: /start`).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('/plan', start), `${where}: /plan после /start`).toBeGreaterThan(start);
  };

  it('экран после создания, hot.md, стартовый план, правила Maestro и README', async () => {
    const lines: string[] = [];
    const { createRenderer } = await import('../src/cli/renderer.js');
    createRenderer((text) => lines.push(text), { isTty: false, columns: 100, env: { NO_COLOR: '1' }, unicode: false })
      .success({ action: 'create', target: '/tmp/проект', name: 'Проект', doctorOk: true });
    const screen = lines.join('');
    startThenPlan(screen.slice(screen.indexOf('Что делать дальше')), 'экран создания');
    expect(screen).toContain('maestro/inbox/');

    const root = await newProject();
    const hot = await readUtf8(root, 'wiki/hot.md');
    startThenPlan(section(hot, '## Следующий шаг'), 'hot.md');
    expect(section(hot, '## Сейчас в работе')).toContain('`/start`');
    // Агент без команд (Codex через AGENTS.md) понимает шаг по протоколу.
    expect(hot).toContain('`protocols/start.md`');

    const starter = await readUtf8(root, 'wiki/plans/0001-starter.md');
    startThenPlan(section(starter, '## Порядок работ'), '0001-starter.md');
    expect(section(starter, '## Что известно')).toContain('Его закрывает `/start`');

    const rules = await readUtf8(root, '.claude/rules/maestro.md');
    startThenPlan(rules, 'rules/maestro.md');
    expect(rules).toContain('создание → `/start` → `/plan`');
    expect(rules).toContain('`protocols/start.md`');
    expect(rules).toMatch(/команды `build`, `status`, `wiki`, `handoff`, `plan`, `start`/);

    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
    startThenPlan(readme.slice(readme.indexOf('## Что дальше после создания проекта')), 'README');
    expect(readme).toContain('создание → /start → /plan');
  });

  it('названия разделов wiki/hot.md не меняются — на них опираются скрипты', async () => {
    const hot = await template('wiki/hot.md');
    expect(hot.match(/^## .+$/gm)).toEqual(['## Сейчас в работе', '## Открытые вопросы', '## Следующий шаг']);
  });

  it('руководство: первый шаг, команда /start и признак старта', async () => {
    const guide = await readFile(join(process.cwd(), 'docs/USER_GUIDE.md'), 'utf8');
    expect(guide).toContain('### Шаг 3. Знакомство с задачей: `/start`');
    expect(guide).toContain('создание → `/start` → `/plan`');
    expect(guide).toContain('### `/start`');
    expect(guide).toContain('`not_started` → `in_progress` → `done`');
    expect(guide).toContain('### `wiki/restore.md`');
  });
});
