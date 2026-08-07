import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCreateArgs } from '../src/cli/create.js';
import { parseMaestroArgs } from '../src/cli/maestro.js';
import { VERSION } from '../src/core/meta.js';
import { PLAN_GATE_KEYS, PLAN_STATUSES } from '../src/core/plan.js';
import { QUICK_CRITERIA } from '../src/core/preflight.js';
import { DEFAULT_OUTPUT_PATH } from '../src/core/sources/index.js';

/**
 * Phase 5 контракт Planning Gate: документация как проверяемый интерфейс.
 *
 * Документация обещает новичку конкретные команды и конкретный маршрут. Обещание
 * дрейфует молча: CLI меняется, а README остаётся. Поэтому здесь проверяется не
 * стиль текста, а ровно то, что можно доказать механически — команды разбираются
 * настоящим парсером, словари берутся из владельцев контракта, а ссылки и якоря
 * существуют. Нормативные правила планирования остаются в `protocols/plan.md`:
 * документация обязана направлять туда, а не переписывать их своими словами.
 */

const root = resolve('.');
const README = 'README.md';
const GUIDE = 'docs/USER_GUIDE.md';
const PROTOCOL = 'protocols/plan.md';

async function doc(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8');
}

/** Разбивает строку команды на аргументы, сохраняя кавычки как границы значения. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of line.matchAll(pattern)) tokens.push(match[1] ?? match[2] ?? '');
  return tokens;
}

/** Собирает вызовы CLI из документации, склеивая перенос строки обратным слешем. */
function cliInvocations(markdown: string, binary: string): string[][] {
  const lines = markdown.split('\n');
  const found: string[][] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i] as string;
    if (!line.includes(`dist/bin/${binary}.js`)) continue;
    while (line.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      line = `${line.trimEnd().slice(0, -1)} ${lines[i + 1] as string}`;
      i += 1;
    }
    // Команда внутри строки таблицы обёрнута в backticks: берём саму команду, а не ячейку.
    if (line.includes('`')) {
      const inline = line.split('`').find((part) => part.includes(`dist/bin/${binary}.js`));
      if (inline !== undefined) line = inline;
    }
    const tokens = tokenize(line);
    const start = tokens.findIndex((token) => token.endsWith(`dist/bin/${binary}.js`));
    found.push(tokens.slice(start + 1));
  }
  return found;
}

/** Якорь GitHub: нижний регистр, пробелы в дефис, прочая пунктуация отбрасывается. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .trim()
    .replace(/ /g, '-');
}

function headings(markdown: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6} +(.+)$/gm)) anchors.add(slug(match[1] as string));
  return anchors;
}

/** Локальные ссылки документа: без внешних URL и без чистых якорей одного файла. */
function localLinks(markdown: string): { target: string; anchor: string | null }[] {
  const links: { target: string; anchor: string | null }[] = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = match[1] as string;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
    const [target, anchor] = href.split('#');
    links.push({ target: target as string, anchor: anchor ?? null });
  }
  return links;
}

describe('Phase 5: версия публикуется одинаково везде', () => {
  it('package, lock, runtime и документация называют одну версию 0.3.0-beta.1', async () => {
    const expected = '0.3.0-beta.1';
    const pkg = JSON.parse(await doc('package.json')) as { version: string };
    const lock = JSON.parse(await doc('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };
    expect(pkg.version).toBe(expected);
    expect(lock.version).toBe(expected);
    expect(lock.packages['']?.version).toBe(expected);
    // VERSION читается из package.json: это и есть версия, которую печатает `--version`.
    expect(VERSION).toBe(expected);
    expect(await doc(README)).toContain(expected);
    expect(await doc(GUIDE)).toContain(expected);
  });
});

describe('Phase 5: команды документации совпадают с настоящим CLI', () => {
  it('каждый документированный вызов vibe-maestro разбирается парсером без ошибки', async () => {
    const invocations = [
      ...cliInvocations(await doc(README), 'vibe-maestro'),
      ...cliInvocations(await doc(GUIDE), 'vibe-maestro'),
    ];
    expect(invocations.length).toBeGreaterThanOrEqual(10);
    for (const argv of invocations) {
      const parsed = parseMaestroArgs(argv);
      expect(parsed.kind, argv.join(' ')).not.toBe('error');
    }
  });

  it('каждый документированный вызов create-vibe-maestro разбирается парсером без ошибки', async () => {
    const invocations = [
      ...cliInvocations(await doc(README), 'create-vibe-maestro'),
      ...cliInvocations(await doc(GUIDE), 'create-vibe-maestro'),
    ].filter((argv) => argv.length > 0);
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const argv of invocations) {
      const parsed = parseCreateArgs(argv);
      expect(parsed.kind, argv.join(' ')).not.toBe('error');
    }
  });

  it('справка CLI и документация описывают один набор команд', async () => {
    const help = parseMaestroArgs(['--help']);
    expect(help.kind).toBe('help');
    const guide = await doc(GUIDE);
    for (const command of ['doctor', 'skills', 'sources', 'upgrade', 'preflight']) {
      expect(guide, command).toContain(`vibe-maestro.js ${command}`);
    }
  });

  it('документированные словари гейта берутся у владельцев контракта, а не выдумываются', async () => {
    const guide = await doc(GUIDE);
    for (const criterion of QUICK_CRITERIA) expect(guide, criterion).toContain(criterion);
    for (const key of PLAN_GATE_KEYS) expect(guide, key).toContain(key);
    for (const status of ['draft', 'in_review', 'approved', 'active'] as const) {
      expect(PLAN_STATUSES, status).toContain(status);
      expect(guide, status).toContain(status);
    }
    expect(guide).toContain(DEFAULT_OUTPUT_PATH);
  });

  it('документированные коды preflight существуют в реализации гейта', async () => {
    const source = await doc('src/core/preflight.ts');
    const guide = await doc(GUIDE);
    const documented = [...guide.matchAll(/`(preflight-[a-z-]+)`/g)].map((match) => match[1] as string);
    expect(documented.length).toBeGreaterThanOrEqual(5);
    for (const code of new Set(documented)) expect(source, code).toContain(`'${code}'`);
  });
});

describe('Phase 5: главный путь новичка объявлен и упорядочен', () => {
  it('README ведёт по одному маршруту от идеи до handoff', async () => {
    const readme = await doc(README);
    const order = ['Обсудите идею', '/plan', 'классификаци', 'draft', 'план утверждаю', 'preflight', '/build', 'doctor', '/handoff'];
    let cursor = -1;
    for (const anchor of order) {
      const index = readme.indexOf(anchor, cursor + 1);
      expect(index, anchor).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('README и руководство всегда говорят, из какой папки запускать команды', async () => {
    for (const path of [README, GUIDE]) {
      const text = await doc(path);
      expect(text, path).toContain('Откуда запускать команды');
      expect(text, path).toMatch(/папк[аиу] проекта/i);
      expect(text, path).toContain('--path');
    }
  });

  it('README объявляет адаптивную глубину и разделение человек/агент', async () => {
    const readme = await doc(README);
    for (const scale of ['`QUICK`', '`FEATURE`', '`PROJECT`', '`PROGRAM`']) expect(readme, scale).toContain(scale);
    expect(readme).toMatch(/mini-plan/i);
    expect(readme).toContain('| Человек | Агент |');
    expect(readme).toContain('CODE_ALLOWED: NO');
  });

  it('README остаётся короткой входной страницей со ссылками в руководство', async () => {
    const readme = await doc(README);
    expect(readme.split('\n').length).toBeLessThan(350);
    for (const anchor of ['#два-примера-от-идеи-до-первой-порции', '#инвентаризация-существующих-исходников', '#preflight-механический-гейт-перед-кодом', '#обновление-проекта-с-02-на-03', '#если-что-то-пошло-не-так']) {
      expect(readme, anchor).toContain(anchor);
    }
  });
});

describe('Phase 5: руководство описывает обе законченные истории', () => {
  it('пример лендинга остаётся лёгким: один план и никакого program pack', async () => {
    const guide = await doc(GUIDE);
    const example = guide.slice(guide.indexOf('### Пример A.'), guide.indexOf('### Пример B.'));
    expect(example).not.toBe('');
    expect(example).toContain('scale: PROJECT');
    expect(example).toContain('WEB_UI');
    expect(example.toLowerCase()).toMatch(/один документ|один план/);
    expect(example.toLowerCase()).toMatch(/бюрократ|без program pack|никакого program pack/);
    expect(example).not.toContain('wiki/programs/');
  });

  it('пример игрового портала сохраняет источники и утверждает фазы по одной', async () => {
    const guide = await doc(GUIDE);
    const example = guide.slice(guide.indexOf('### Пример B.'), guide.indexOf('## Инвентаризация'));
    expect(example).not.toBe('');
    expect(example).toContain('scale: PROGRAM');
    expect(example).toContain('mode: INTEGRATION');
    expect(example).toContain('wiki/programs/');
    expect(example.toLowerCase()).toMatch(/read-only|только на чтение/);
    expect(example.toLowerCase()).toMatch(/wrap|оболочк/);
    expect(example).toContain('FUTURE_PHASES_CODE_ALLOWED: NO');
    expect(example.toLowerCase()).toMatch(/не переписыва|нетронут|не сливают/);
  });

  it('руководство честно описывает границы sources, preflight и upgrade', async () => {
    const guide = await doc(GUIDE);
    const sources = guide.slice(guide.indexOf('## Инвентаризация'), guide.indexOf('## Preflight'));
    expect(sources).toContain('--write');
    expect(sources).toContain('--replace');
    expect(sources).toContain('--output');
    expect(sources.toLowerCase()).toMatch(/по умолчанию не пишется ничего|не записывается ничего/);
    expect(sources.toLowerCase()).toContain('не converter');
    expect(sources.toLowerCase()).toMatch(/секрет/);

    const preflight = guide.slice(guide.indexOf('## Preflight'), guide.indexOf('## Обновление проекта'));
    expect(preflight).toContain('--scale quick');
    expect(preflight).toContain('Build preflight: разрешено');
    expect(preflight).toContain('Build preflight: заблокировано');
    expect(preflight.toLowerCase()).toMatch(/ничего не пишет/);

    const upgrade = guide.slice(guide.indexOf('## Обновление проекта'), guide.indexOf('## Если что-то пошло не так'));
    expect(upgrade).toContain('--apply');
    expect(upgrade).toContain('.maestro/upgrade-staging/');
    expect(upgrade).toContain('upgrade-managed-modified');
    expect(upgrade.toLowerCase()).toMatch(/dry-run|ни один байт/);
    expect(upgrade.toLowerCase()).toMatch(/откат|rollback/);
  });

  it('troubleshooting покрывает все объявленные тупики новичка', async () => {
    const guide = await doc(GUIDE);
    const section = guide.slice(guide.indexOf('## Если что-то пошло не так'));
    for (const symptom of [
      'preflight-plan-absent',
      'preflight-plan-not-approved',
      'preflight-approval-missing',
      'preflight-gate-fields-missing',
      'preflight-spec-delta',
      'write-output-exists',
      'upgrade-managed-modified',
      'upgrade-path-collision',
    ]) {
      expect(section, symptom).toContain(symptom);
    }
    expect(section.toLowerCase()).toMatch(/два активных плана/);
  });
});

describe('Phase 5: документация не подменяет владельца правил', () => {
  it('README и руководство называют Cowork и Claude Code дверями в один protocols/plan.md', async () => {
    for (const path of [README, GUIDE]) {
      const text = await doc(path);
      expect(text, path).toContain(PROTOCOL);
      expect(text, path).toMatch(/двер/i);
      expect(text, path).toContain('cowork-plan.md');
    }
  });

  it('документация не объявляет собственный contract anchor планирования', async () => {
    for (const path of [README, GUIDE]) {
      const text = await doc(path);
      expect(text, path).not.toContain('VCM-PLANNING-GATE');
      expect(text, path).not.toContain('<a id=');
    }
  });

  it('документация не обещает автоматического утверждения или converter существующих репозиториев', async () => {
    for (const path of [README, GUIDE]) {
      const text = (await doc(path)).toLowerCase();
      expect(text, path).not.toMatch(/агент утверждает план|автоматически утвержда/);
      expect(text, path).not.toMatch(/автоматически (преобразу|конверти|мигриру)/);
    }
  });
});

describe('Phase 5: ссылки и packaging', () => {
  it('все локальные ссылки README и руководства ведут в существующие файлы и заголовки', async () => {
    for (const path of [README, GUIDE]) {
      const text = await doc(path);
      for (const link of localLinks(text)) {
        const target = posix.normalize(posix.join(posix.dirname(path), link.target));
        expect(existsSync(join(root, target)), `${path} → ${link.target}`).toBe(true);
        if (link.anchor === null || !target.endsWith('.md')) continue;
        const anchors = headings(await doc(target));
        expect(anchors.has(decodeURIComponent(link.anchor)), `${path} → ${link.target}`).toBe(true);
      }
    }
  });

  it('внутренние якоря содержания руководства существуют', async () => {
    const guide = await doc(GUIDE);
    const anchors = headings(guide);
    const referenced = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((match) => decodeURIComponent(match[1] as string));
    expect(referenced.length).toBeGreaterThanOrEqual(10);
    for (const anchor of referenced) expect(anchors.has(anchor), anchor).toBe(true);
  });

  it('документация входит в публикуемый пакет', async () => {
    const pkg = JSON.parse(await doc('package.json')) as { files: string[] };
    expect(pkg.files).toContain('docs');
    expect(pkg.files).toContain('README.md');
    for (const path of [GUIDE, 'docs/THREAT_MODEL.md', 'docs/MIGRATION_V1.md']) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
    expect(dirname(join(root, GUIDE))).toBe(join(root, 'docs'));
  });
});
