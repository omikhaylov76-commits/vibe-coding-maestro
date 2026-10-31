import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCreateCli } from '../src/cli/create.js';
import { runMaestroCli } from '../src/cli/maestro.js';
import { doctorProject } from '../src/core/doctor.js';
import { initProject } from '../src/core/init.js';
import { planBodyDigest } from '../src/core/plan.js';
import { cleanupTempDirs, FIXED_NOW, makeTempDir, readUtf8 } from './helpers.js';

const execFileAsync = promisify(execFile);
afterEach(cleanupTempDirs);

/** Находки независимого ревью 0.3.0: каждая закреплена тестом, который без исправления красный. */

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, all: () => [...out, ...err].join('\n') };
}

async function maestro(...argv: string[]): Promise<{ code: number; text: string }> {
  const cli = collect();
  const code = await runMaestroCli(argv, cli.io);
  return { code, text: cli.all() };
}

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFileAsync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd })).stdout.trim();

async function fixtureProject(id: string): Promise<string> {
  const data = JSON.parse(await readFile(join(process.cwd(), 'tests/fixtures/published', `${id}.json`), 'utf8')) as { folder: string; files: Record<string, string> };
  const root = join(await makeTempDir('review-'), data.folder);
  for (const [path, content] of Object.entries(data.files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content, 'utf8');
  }
  return root;
}

/** Утверждённый и объявленный план с отпечатком, как велит протокол. */
async function approvedProject(): Promise<{ root: string; plan: string }> {
  const root = join(await makeTempDir('approved-'), 'проект');
  expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
  const plan = 'wiki/plans/0001-starter.md';
  let text = await readUtf8(root, plan);
  text = text.replace(/^status: .*$/m, 'status: approved')
    .replace(/^approved_by: .*$/m, 'approved_by: Человек')
    .replace(/^approved_at: .*$/m, 'approved_at: 2026-11-01')
    .replace(/^blocking_questions: .*$/m, 'blocking_questions: 0')
    .replace(/^current_slice: .*$/m, 'current_slice: 01-start');
  text = text.replace(/^(approved_at: .*)$/m, `$1\napproved_digest: ${planBodyDigest(text)}`);
  await writeFile(join(root, plan), text, 'utf8');
  const hot = (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: plans/0001-starter.md');
  await writeFile(join(root, 'wiki/hot.md'), hot, 'utf8');
  expect((await maestro('preflight', '--path', root)).code).toBe(0);
  return { root, plan };
}

describe('ревью 0.3.0', () => {
  it('файл Maestro, не добавленный в Git после upgrade, виден в doctor', async () => {
    const root = await fixtureProject('0.3.0-beta.4-standard');
    await git(root, 'init', '-q', '-b', 'main');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'beta');
    expect((await maestro('upgrade', '--path', root, '--apply')).code).toBe(0);
    await git(root, 'commit', '-q', '-am', 'upgrade'); // типичная ошибка: -a не берёт новые файлы
    const report = await doctorProject(root, { strict: true });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'git-managed-untracked', path: '.claude/rules/maestro.md' }));
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'add new files');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });

  it('смена классификации утверждённого плана закрывает гейт так же, как правка текста', async () => {
    const { root, plan } = await approvedProject();
    const text = await readUtf8(root, plan);
    await writeFile(join(root, plan), text.replace(/^risk: low$/m, 'risk: critical'), 'utf8');
    const gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(1);
    expect(gate.text).toContain('preflight-plan-changed');
    // Ход работы (порция, статус) отпечаток не трогает.
    await writeFile(join(root, plan), text.replace(/^current_slice: .*$/m, 'current_slice: 02-next').replace(/^status: approved$/m, 'status: active'), 'utf8');
    expect((await maestro('preflight', '--path', root)).code).toBe(0);
  });

  it('значения frontmatter в YAML-кавычках читаются как строки', async () => {
    const { root, plan } = await approvedProject();
    const text = await readUtf8(root, plan);
    await writeFile(join(root, plan), text
      .replace(/^status: approved$/m, 'status: "approved"')
      .replace(/^approved_at: (.*)$/m, "approved_at: '$1'")
      .replace(/^current_slice: (.*)$/m, 'current_slice: "$1"'), 'utf8');
    const hot = (await readUtf8(root, 'wiki/hot.md')).replace(/^active_plan: .*$/m, 'active_plan: "plans/0001-starter.md"');
    await writeFile(join(root, 'wiki/hot.md'), hot, 'utf8');
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
    expect((await maestro('preflight', '--path', root)).code).toBe(0);
  });

  it('закрытая порция: preflight говорит «порция не выбрана», а не «поля нет»', async () => {
    const { root, plan } = await approvedProject();
    const text = (await readUtf8(root, plan)).replace(/^current_slice: .*$/m, 'current_slice: null');
    await writeFile(join(root, plan), text, 'utf8');
    const gate = await maestro('preflight', '--path', root);
    expect(gate.code).toBe(1);
    expect(gate.text).toContain('preflight-slice-closed');
    expect(gate.text).not.toContain('preflight-gate-fields-missing');
  });

  it('команда Maestro старой версии в переданном как есть CLAUDE.md замечается', async () => {
    const root = await fixtureProject('0.3.0-beta.4-standard');
    await writeFile(join(root, 'CLAUDE.md'), `${await readUtf8(root, 'CLAUDE.md')}\n## Наше\n- стек: Astro\n`, 'utf8');
    const upgrade = await maestro('upgrade', '--path', root, '--apply');
    expect(upgrade.code).toBe(0);
    expect(upgrade.text).toContain('переданы как есть: CLAUDE.md');
    const report = await doctorProject(root, { strict: true });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'entry-stale-command', path: 'CLAUDE.md', level: 'warning' }));
    expect(report.ok).toBe(false);
  });

  it('битый .claude/settings.json даёт предупреждение', async () => {
    const root = join(await makeTempDir('settings-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await writeFile(join(root, '.claude/settings.json'), '{ "permissions": { "deny": ["Read(.env)",] } }\n', 'utf8');
    const report = await doctorProject(root, { strict: true });
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'settings-json-invalid' }));
  });

  it('несовпадение active_progress называет ожидаемый путь', async () => {
    const root = join(await makeTempDir('progress-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    await mkdir(join(root, 'wiki/progress'), { recursive: true });
    await writeFile(join(root, 'wiki/progress/01.md'), '---\nstatus: active\n---\n# 01\n', 'utf8');
    const hot = (await readUtf8(root, 'wiki/hot.md')).replace(/^active_progress: .*$/m, 'active_progress: wiki/progress/01.md');
    await writeFile(join(root, 'wiki/hot.md'), hot, 'utf8');
    const finding = (await doctorProject(root)).findings.find((item) => item.code === 'hot-active-progress-mismatch');
    expect(finding?.message).toContain('active_progress: progress/01.md');
  });

  it('повторный create в существующем репозитории без записей не просит «добавить вручную»', async () => {
    const root = join(await makeTempDir('rerun-git-'), 'проект');
    const first = collect();
    expect(await runCreateCli(['--yes', '--target', root], first.io, { isTty: false })).toBe(0);
    const again = collect();
    expect(await runCreateCli(['--yes', '--target', root], again.io, { isTty: false })).toBe(0);
    expect(again.all()).not.toContain('добавьте');
  });

  it('create в папку, где есть только .git, проходит: неиндексированные файлы — предупреждение, а не провал', async () => {
    const root = join(await makeTempDir('git-only-'), 'проект');
    await mkdir(root, { recursive: true });
    await git(root, 'init', '-q', '-b', 'main');
    const cli = collect();
    expect(await runCreateCli(['--yes', '--target', root], cli.io, { isTty: false })).toBe(0);
    expect(cli.all()).toContain('git add');
    const report = await doctorProject(root);
    expect(report.ok).toBe(true);
    expect(report.findings.every((item) => item.code === 'git-managed-untracked' && item.level === 'warning')).toBe(true);
  });

  it('метка .maestro/creating снимается только после стартового коммита', async () => {
    const source = await readFile(join(process.cwd(), 'src/core/init.ts'), 'utf8');
    const commit = source.indexOf('await initGitRepository(target, ownedPaths');
    const unmark = source.indexOf('await rm(join(target, CREATING_MARKER_PATH)');
    expect(commit).toBeGreaterThan(0);
    expect(unmark).toBeGreaterThan(commit);
  });

  it('правила Maestro называют все управляемые места, и settings.json их защищает', async () => {
    const root = join(await makeTempDir('rules-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    const rules = await readUtf8(root, '.claude/rules/maestro.md');
    const settings = JSON.parse(await readUtf8(root, '.claude/settings.json')) as { permissions: { deny: string[] } };
    for (const place of ['protocols/', 'maestro/templates/', 'maestro/runbooks/', '.claude/commands/', '.claude/agents/', 'wiki/plans/README.md', 'wiki/plans/TEMPLATE.md']) {
      expect(rules, place).toContain(place);
      expect(settings.permissions.deny.some((rule) => rule.includes(place.replace(/\/$/, ''))), place).toBe(true);
    }
    expect(await readUtf8(root, 'wiki/plans/README.md')).not.toContain('больше не\nпереписывает содержимое');
  });
});

describe('0.3.1', () => {
  it('команда в сообщении doctor отделена от точки обратными кавычками', async () => {
    const root = await fixtureProject('0.3.0-beta.4-standard');
    const message = (await doctorProject(root)).findings.find((item) => item.code === 'project-outdated')?.message ?? '';
    expect(message).toMatch(/`npx --package create-vibe-maestro@0\.3\.0-beta\.4 vibe-maestro doctor --path [^`]+`\./);
    expect(message).toMatch(/`npx --package create-vibe-maestro@\S+ vibe-maestro upgrade --path [^`]+`/);
    expect(message).not.toMatch(/--path [^`\s]+\.\s/);
  });

  it('повторный create предупреждает о явных --depth и --start, которые не применены', async () => {
    const root = join(await makeTempDir('rerun-flags-'), 'проект');
    expect(await runCreateCli(['--yes', '--no-git', '--target', root, '--depth', 'light', '--start', 'idea'], collect().io, { isTty: false })).toBe(0);
    const again = collect();
    expect(await runCreateCli(['--yes', '--no-git', '--target', root, '--depth', 'advanced', '--start', 'materials'], again.io, { isTty: false })).toBe(0);
    expect(again.all()).toContain('--depth advanced не применён');
    expect(again.all()).toContain('--start materials не применён');
    // Без явных флагов предупреждений нет.
    const quiet = collect();
    expect(await runCreateCli(['--yes', '--no-git', '--target', root], quiet.io, { isTty: false })).toBe(0);
    expect(quiet.all()).not.toContain('не применён');
  });

  it('upgrade с 0.3.0 меняет только закреплённую версию', async () => {
    const root = join(await makeTempDir('from-030-'), 'проект');
    expect((await initProject({ target: root, startingPoint: 'idea', git: false, now: FIXED_NOW })).ok).toBe(true);
    const { VERSION } = await import('../src/core/meta.js');
    const { contentChecksum, loadChecksums, loadManifest, MANIFEST_PATH, CHECKSUMS_PATH } = await import('../src/core/manifest.js');
    // Проект в том виде, в каком его записала 0.3.0: та же разметка, другая версия в командах.
    const pinned = ['.claude/commands/build.md', '.claude/rules/maestro.md', 'protocols/build.md', 'protocols/plan.md'];
    const checksums = (await loadChecksums(root))?.files ?? {};
    for (const path of pinned) {
      const text = (await readUtf8(root, path)).split(`create-vibe-maestro@${VERSION}`).join('create-vibe-maestro@0.3.0');
      await writeFile(join(root, path), text, 'utf8');
      checksums[path] = contentChecksum(path, text);
    }
    await writeFile(join(root, CHECKSUMS_PATH), `${JSON.stringify({ files: Object.fromEntries(Object.keys(checksums).sort().map((key) => [key, checksums[key]])) }, null, 2)}\n`, 'utf8');
    const manifest = await loadManifest(root);
    manifest.product.version = '0.3.0';
    await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const result = await maestro('upgrade', '--path', root, '--apply');
    expect(result.code, result.text).toBe(0);
    expect(result.text).toContain(`0.3.0 → ${VERSION}`);
    for (const path of pinned) expect(await readUtf8(root, path), path).toContain(`create-vibe-maestro@${VERSION}`);
    expect((await doctorProject(root, { strict: true })).findings).toEqual([]);
  });
});
