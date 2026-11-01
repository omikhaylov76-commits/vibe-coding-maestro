import { readFile, readdir } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';

type Capability = {
  id: string;
  status: 'keep' | 'adapt' | 'reject';
  ownerPath: string | null;
  contractId: string | null;
  depths: Array<'light' | 'standard' | 'advanced'>;
  rationale: string;
};
type Ledger = { schemaVersion: 1; capabilities: Capability[] };

const root = resolve('.');
const projectTemplate = join(root, 'templates/project');
const ledgerPath = join(root, 'registry/capabilities.v1.json');
const schemaPath = join(root, 'schemas/capabilities.v1.schema.json');

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function links(markdown: string): string[] {
  return Array.from(markdown.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/g))
    .map((match) => match[1])
    .filter((target): target is string => target !== undefined);
}

async function reachableFromBuildRouter(): Promise<Set<string>> {
  const start = 'protocols/build.md';
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const markdown = await readFile(join(projectTemplate, current), 'utf8');
    for (const target of links(markdown)) {
      const next = posix.normalize(posix.join(posix.dirname(current), target));
      if (next.startsWith('protocols/') && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

async function protocolMarkdownFiles(dir = join(projectTemplate, 'protocols')): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await protocolMarkdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

describe('Phase 3: capability anti-loss contracts', () => {
  it('ledger соответствует schema и имеет уникальные capability id', async () => {
    const schema = await json<object>(schemaPath);
    const ledger = await json<Ledger>(ledgerPath);
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(validate(ledger), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(new Set(ledger.capabilities.map((item) => item.id)).size).toBe(ledger.capabilities.length);
  });

  it('ledger явно сохраняет все обязательные интеллектуальные capabilities', async () => {
    const ledger = await json<Ledger>(ledgerPath);
    const active = new Set(ledger.capabilities.filter((item) => item.status !== 'reject').map((item) => item.id));
    for (const id of [
      'human-authority',
      'destructive-confirmation',
      'clarification-gate',
      'discovery-before-code',
      'project-start',
      'design-before-code',
      'role-capability-declaration',
      'constitution-check',
      'spec-delta',
      'complexity-tracking',
      'seam-analysis',
      'task-context-capsule',
      'context-budget',
      'tdd-feature-loop',
      'live-evidence',
      'deterministic-verification',
      'quality-gate',
      'plan-audit',
      'independent-review',
      'advanced-council',
      'retrospective',
      'evidence-lessons',
      'controlled-handoff',
      'icebox',
      'hot-first-status',
    ]) {
      expect(active, id).toContain(id);
    }
  });

  it('каждая сохраняемая capability имеет ровно один contract anchor во всей library', async () => {
    const ledger = await json<Ledger>(ledgerPath);
    const active = ledger.capabilities.filter((item) => item.status !== 'reject');
    const contractIds = active.map((item) => item.contractId);
    expect(new Set(contractIds).size).toBe(contractIds.length);
    const files = await protocolMarkdownFiles();
    const library = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n');
    for (const capability of active) {
      expect(capability.ownerPath).toMatch(/^protocols\/.+\.md$/);
      expect(capability.contractId).toMatch(/^VCM-[A-Z0-9-]+$/);
      const owner = await readFile(join(projectTemplate, capability.ownerPath!), 'utf8');
      const anchor = `<a id="${capability.contractId}"></a>`;
      expect(owner).toContain(anchor);
      expect(library.split(anchor).length - 1, capability.contractId!).toBe(1);
    }
  });

  it('router applicability не активирует capability вне заявленных depth', async () => {
    const ledger = await json<Ledger>(ledgerPath);
    // С 0.4.3 у build.md, audit.md и wiki.md разделы разной глубины, поэтому «всегда» — по контрактам.
    const always = new Set([
      'VCM-HUMAN-AUTHORITY', 'VCM-DESTRUCTIVE-CONFIRMATION', 'VCM-ROLE-CAPABILITIES', 'VCM-CLARIFICATION',
      'VCM-CONSTITUTION', 'VCM-SPEC-DELTA', 'VCM-TASK-CAPSULE', 'VCM-CONTEXT-BUDGET',
      'VCM-TDD-LOOP', 'VCM-LIVE-EVIDENCE', 'VCM-DETERMINISTIC-VERIFICATION', 'VCM-QUALITY-GATE',
      'VCM-HOT-FIRST', 'VCM-WIKI', 'VCM-ICEBOX', 'VCM-HANDOFF', 'VCM-DISCOVERY', 'VCM-START',
    ]);
    const found = ledger.capabilities.filter((item) => item.status !== 'reject' && always.has(item.contractId!));
    expect(found.map((item) => item.contractId).sort()).toEqual([...always].sort());
    for (const capability of found) expect(capability.depths, capability.id).toEqual(['light', 'standard', 'advanced']);
    // Разделы только для старших глубин названы в маршруте build.md с той же оговоркой.
    const router = await readFile(join(projectTemplate, 'protocols/build.md'), 'utf8');
    for (const capability of ledger.capabilities.filter((item) => item.status !== 'reject' && !item.depths.includes('light'))) {
      const line = router.split('\n').find((text) => text.includes(`#${capability.contractId})`));
      if (line !== undefined) expect(line, capability.id).toMatch(capability.depths.includes('standard') ? /^\d+\. Standard\/Advanced:/ : /^\d+\. Advanced:/);
    }
  });

  it('все active owners достижимы из build router по Markdown-ссылкам', async () => {
    const ledger = await json<Ledger>(ledgerPath);
    const reachable = await reachableFromBuildRouter();
    for (const capability of ledger.capabilities.filter((item) => item.status !== 'reject')) {
      expect(reachable, `${capability.id}: ${capability.ownerPath}`).toContain(capability.ownerPath!);
    }
  });

  it('reject-записи честно не объявляют владельца или contract', async () => {
    const ledger = await json<Ledger>(ledgerPath);
    for (const capability of ledger.capabilities.filter((item) => item.status === 'reject')) {
      expect(capability.ownerPath).toBeNull();
      expect(capability.contractId).toBeNull();
    }
  });
});
