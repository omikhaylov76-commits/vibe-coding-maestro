import { readFile, readdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { canonicalOwnershipInventory, TEMPLATE_FILES } from '../src/core/inventory.js';
import { loadChecksums, loadManifest } from '../src/core/manifest.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir } from './helpers.js';

/**
 * Phase 2 контракт Planning Gate: один canonical owner и два тонких адаптера.
 *
 * Тесты держат ровно одну границу: правила планирования живут в `protocols/plan.md`,
 * а `/plan` и Cowork-runbook только направляют туда. Как только адаптер начнёт
 * повторять словарь протокола, он станет вторым источником истины и разойдётся.
 */

const PROTOCOL = 'protocols/plan.md';
const CLAUDE_ADAPTER = '.claude/commands/plan.md';
const COWORK_ADAPTER = 'maestro/runbooks/cowork-plan.md';
const CONTRACT_ID = 'VCM-PLANNING-GATE';
const CAPABILITY_ID = 'planning-gate';

type Capability = {
  id: string;
  status: 'keep' | 'adapt' | 'reject';
  ownerPath: string | null;
  contractId: string | null;
  depths: Array<'light' | 'standard' | 'advanced'>;
  rationale: string;
};

const root = resolve('.');
const projectTemplate = join(root, 'templates/project');

async function template(path: string): Promise<string> {
  return readFile(join(projectTemplate, path), 'utf8');
}

async function ledger(): Promise<Capability[]> {
  const parsed = JSON.parse(await readFile(join(root, 'registry/capabilities.v1.json'), 'utf8')) as { capabilities: Capability[] };
  return parsed.capabilities;
}

async function protocolLibrary(dir = join(projectTemplate, 'protocols')): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await protocolLibrary(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

async function fresh(depth: 'light' | 'standard' | 'advanced' = 'standard'): Promise<string> {
  const target = await makeTempDir(`planning-${depth}-`);
  const result = await initProject({ target, name: `Planning ${depth}`, startingPoint: 'idea', git: false, now: FIXED_NOW, depth });
  expect(result.ok).toBe(true);
  return target;
}

afterEach(cleanupTempDirs);

describe('Phase 2: canonical planning protocol', () => {
  it('ledger объявляет ровно один owner планирования с уникальным contractId и всеми depth', async () => {
    const capabilities = await ledger();
    const owners = capabilities.filter((item) => item.ownerPath === PROTOCOL);
    expect(owners).toHaveLength(1);
    const planning = owners[0]!;
    expect(planning.id).toBe(CAPABILITY_ID);
    expect(planning.status).toBe('keep');
    expect(planning.contractId).toBe(CONTRACT_ID);
    expect(planning.depths).toEqual(['light', 'standard', 'advanced']);
    expect(planning.rationale.length).toBeGreaterThanOrEqual(10);
    expect(capabilities.filter((item) => item.contractId === CONTRACT_ID)).toHaveLength(1);
    expect(capabilities.filter((item) => item.id === CAPABILITY_ID)).toHaveLength(1);
  });

  it('contract anchor существует ровно один раз во всей protocol library и принадлежит plan.md', async () => {
    const anchor = `<a id="${CONTRACT_ID}"></a>`;
    const files = await protocolLibrary();
    const library = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(library.split(anchor).length - 1).toBe(1);
    expect(await template(PROTOCOL)).toContain(anchor);
  });

  it('протокол определяет один workflow планирования от intake до build handoff', async () => {
    const text = await template(PROTOCOL);
    for (const stage of ['Intake', 'Classification', 'Self-review', 'Human approval', 'Build handoff']) {
      expect(text, stage).toContain(stage);
    }
    expect(text).toMatch(/intake[^\n]*classification[^\n]*(self-review|планир)/i);
  });

  it('протокол определяет словарь утверждений, масштаб, режим и governance/risk/profile', async () => {
    const text = await template(PROTOCOL);
    for (const token of [
      'FACT', 'HUMAN_DECISION', 'HYPOTHESIS', 'AGENT_PROPOSAL', 'OPEN_QUESTION', 'UNKNOWN',
      'QUICK', 'FEATURE', 'PROJECT', 'PROGRAM',
      'GREENFIELD', 'EXTENSION', 'INTEGRATION', 'MIGRATION',
      'LIGHT', 'STANDARD', 'ADVANCED',
      'LOW', 'MEDIUM', 'HIGH', 'CRITICAL',
      'WEB_UI', 'BACKEND_SERVICE', 'CLI', 'GAME', 'MULTI_SERVICE_PLATFORM',
    ]) {
      expect(text, token).toContain(token);
    }
    expect(text).toMatch(/governance/i);
    expect(text).toMatch(/profiles/i);
    expect(text).toMatch(/confidence/i);
  });

  it('протокол требует escalation, de-escalation и пересмотр при смене классификации', async () => {
    const text = (await template(PROTOCOL)).toLowerCase();
    for (const value of ['escalation', 'de-escalation', 'pii', 'auth', 'realtime', 'платеж']) {
      expect(text, value).toContain(value);
    }
    expect(text).toMatch(/mvp|slice/);
  });

  it('протокол разделяет объём артефактов по масштабу и не бюрократизирует QUICK', async () => {
    const text = await template(PROTOCOL);
    expect(text.toLowerCase()).toMatch(/quick[^\n]*(mini-plan|мини-план)/i);
    expect(text).toContain('wiki/plans/');
    expect(text).toContain('wiki/programs/');
    expect(text.toLowerCase()).toMatch(/не создавай[^\n]*полн|без[^\n]*пакет|без бюрократ/);
  });

  it('протокол требует read-only inventory существующих исходников без молчаливой перезаписи', async () => {
    const text = (await template(PROTOCOL)).toLowerCase();
    expect(text).toContain('read-only');
    expect(text).toMatch(/не перезаписыва\w+ молча|без молчаливой перезаписи|молча не перезаписыва/);
    expect(text).toMatch(/использовать|адаптировать|заменить|отложить/);
  });

  it('протокол честно называет self-review не независимым review и держит один risk-based audit', async () => {
    const text = await template(PROTOCOL);
    expect(text.toLowerCase()).toMatch(/self-review[^.]*не[^.]*независим/);
    expect(text).toContain('audit-plan.md');
    expect(text.toLowerCase()).toMatch(/без нового риска|нового риска нет|не запускай[^\n]*повторн/);
  });

  it('протокол фиксирует human approval, phase-level approval, SPEC DELTA и CODE_ALLOWED: NO', async () => {
    const text = await template(PROTOCOL);
    expect(text).toContain('CODE_ALLOWED: NO');
    expect(text).toContain('SPEC DELTA');
    expect(text).toContain('PROGRAM_APPROVED');
    expect(text).toContain('CURRENT_PHASE_APPROVED');
    expect(text).toContain('FUTURE_PHASES_CODE_ALLOWED: NO');
    expect(text).toContain('approved_by');
    expect(text).toContain('approved_at');
    expect(text.toLowerCase()).toMatch(/агент не утверждает|человек утверждает/);
  });

  it('протокол запрещает копировать весь чат и сохранять секреты', async () => {
    const text = (await template(PROTOCOL)).toLowerCase();
    expect(text).toMatch(/не копируй весь (чат|разговор)|весь чат не/);
    expect(text).toMatch(/секрет|токен|ключ/);
    expect(text).toContain('context incomplete');
  });

  it('build router ведёт к planning gate: неизвестные идут через discovery, активный план даёт slice', async () => {
    const router = await template('protocols/build.md');
    // Точная ссылка, а не подстрока: `audit-plan.md` тоже заканчивается на plan.md.
    expect(router).toContain('(plan.md)');
    expect(router.indexOf('(discovery.md)')).toBeLessThan(router.indexOf('(plan.md)'));
    expect(router.toLowerCase()).toMatch(/slice|порци/);
  });
});

describe('Phase 2: тонкие адаптеры Planning Gate', () => {
  it('оба адаптера направляют в один и тот же canonical protocol', async () => {
    for (const path of [CLAUDE_ADAPTER, COWORK_ADAPTER]) {
      expect(await template(path), path).toContain(PROTOCOL);
    }
  });

  it('адаптеры не объявляют собственных contract anchors', async () => {
    for (const path of [CLAUDE_ADAPTER, COWORK_ADAPTER]) {
      const text = await template(path);
      expect(text, path).not.toContain('<a id=');
      expect(text, path).not.toContain(CONTRACT_ID);
    }
  });

  it('Claude adapter остаётся маршрутом с видимым approval gate, а не копией протокола', async () => {
    const text = await template(CLAUDE_ADAPTER);
    expect(text.split('\n').filter((line) => line.trim() !== '').length).toBeLessThanOrEqual(6);
    expect(text).toContain('wiki/hot.md');
    expect(text).toContain('CODE_ALLOWED: NO');
    for (const duplicated of ['GREENFIELD', 'PROGRAM_APPROVED', 'SPEC DELTA', 'HYPOTHESIS', 'audit-plan.md']) {
      expect(text, duplicated).not.toContain(duplicated);
    }
  });

  it('Cowork runbook превращает разговор в проектный черновик и не пишет код', async () => {
    const text = await template(COWORK_ADAPTER);
    expect(text.split('\n').length).toBeLessThanOrEqual(40);
    const lower = text.toLowerCase();
    expect(lower).toMatch(/скопиру|copy/);
    expect(lower).toContain('не изменяет файлы проекта');
    // \w в JS не покрывает кириллицу: перечисляем формы явно.
    expect(lower).toMatch(/не пиши код|не пишет код/);
    expect(lower).toContain('человек');
    expect(lower).toContain('diff');
    expect(lower).toMatch(/разговор|обсуждени/);
    expect(text).toContain('wiki/plans/');
    for (const stateMachine of ['in_review', 'superseded', 'PROGRAM_APPROVED']) {
      expect(text, stateMachine).not.toContain(stateMachine);
    }
  });
});

describe('Phase 2: установка и packaging Planning Gate', () => {
  it('три файла входят в trusted inventory пакета и в publishable files', async () => {
    for (const path of [PROTOCOL, CLAUDE_ADAPTER, COWORK_ADAPTER]) {
      expect(TEMPLATE_FILES, path).toContain(path);
      expect((await template(path)).trim(), path).not.toBe('');
    }
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('templates');
    const acceptance = await readFile(join(root, 'scripts/ci-acceptance.mjs'), 'utf8');
    for (const path of [PROTOCOL, CLAUDE_ADAPTER, COWORK_ADAPTER]) expect(acceptance, path).toContain(path);
  });

  it('depth projection объявляет все три файла managed на light/standard/advanced', () => {
    for (const depth of ['light', 'standard', 'advanced'] as const) {
      const inventory = canonicalOwnershipInventory(depth);
      for (const path of [PROTOCOL, CLAUDE_ADAPTER, COWORK_ADAPTER]) {
        expect(inventory[path], `${depth}:${path}`).toBe('managed');
      }
    }
  });

  it.each(['light', 'standard', 'advanced'] as const)('чистый проект %s содержит Planning Gate и проходит doctor без замечаний', async (depth) => {
    const target = await fresh(depth);
    const manifest = await loadManifest(target);
    const checksums = await loadChecksums(target);
    for (const path of [PROTOCOL, CLAUDE_ADAPTER, COWORK_ADAPTER]) {
      expect((await readFile(join(target, path), 'utf8')).trim(), path).not.toBe('');
      expect(manifest.managed).toContainEqual({ path, kind: 'managed' });
      expect(manifest.inventory).toContainEqual({ path, ownership: 'managed' });
      expect(checksums?.files[path], path).toMatch(/^[0-9a-f]{64}$/);
    }
    const report = await doctorProject(target, { strict: true });
    expect(report.findings, JSON.stringify(report.findings)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('protocols/plan.md достижим из build router по Markdown-ссылкам', async () => {
    const seen = new Set<string>();
    const queue = ['protocols/build.md'];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const markdown = await template(current);
      for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
        const target = match[1];
        if (target === undefined) continue;
        const next = posix.normalize(posix.join(posix.dirname(current), target));
        if (next.startsWith('protocols/') && !seen.has(next)) queue.push(next);
      }
    }
    expect(seen).toContain(PROTOCOL);
  });
});
