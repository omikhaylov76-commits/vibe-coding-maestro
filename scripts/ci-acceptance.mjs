import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const createCli = join(root, 'dist/bin/create-vibe-maestro.js');
const maestroCli = join(root, 'dist/bin/vibe-maestro.js');
const tempRoot = await mkdtemp(join(tmpdir(), 'maestro acceptance '));
const target = join(tempRoot, 'project with spaces');
let packDir;
let installDir;

function runResult(command, args, cwd = root) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', shell: false });
}

function run(command, args, cwd = root) {
  const result = runResult(command, args, cwd);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result.stdout.trim();
}

function npm(args, cwd = root) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, 'ci-acceptance must be launched through `npm run acceptance`');
  return run(process.execPath, [npmCli, ...args], cwd);
}

try {
  run(process.execPath, [createCli, '--yes', '--target', target, '--name', 'CI Acceptance', '--start', 'idea']);
  run(process.execPath, [maestroCli, 'doctor', '--path', target]);
  assert.equal(run('git', ['branch', '--show-current'], target), 'main', 'branch must be main');
  assert.equal(run('git', ['status', '--porcelain'], target), '', 'initial status must be clean');

  const sentinel = join(target, 'sentinel user file.txt');
  await writeFile(sentinel, 'preserve me\n', 'utf8');
  run('git', ['add', 'sentinel user file.txt'], target);
  run('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'Add sentinel'], target);

  run(process.execPath, [createCli, '--yes', '--force', '--target', target, '--name', 'CI Acceptance', '--start', 'idea']);
  await access(sentinel);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve me\n', 'second init must preserve sentinel');
  run(process.execPath, [maestroCli, 'doctor', '--path', target]);
  assert.equal(run('git', ['branch', '--show-current'], target), 'main');
  assert.equal(run('git', ['status', '--porcelain'], target), '', 'status after second init must be clean');

  // Keep package-manager staging separate from user-facing path tests. Paths
  // with spaces are tested above and again as `packed project` below.
  packDir = await mkdtemp(join(tmpdir(), 'vcm-pack-'));
  installDir = await mkdtemp(join(tmpdir(), 'vcm-installed-'));
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', packDir]));
  const filename = packed[0]?.filename;
  assert.ok(filename, 'npm pack --json must return filename');
  const tarball = join(packDir, filename);
  await writeFile(join(installDir, 'package.json'), '{"private":true}\n', 'utf8');
  npm(['install', '--ignore-scripts', tarball], installDir);

  const installedRoot = join(installDir, 'node_modules/create-vibe-maestro');
  const installedCreate = join(installedRoot, 'dist/bin/create-vibe-maestro.js');
  const installedMaestro = join(installedRoot, 'dist/bin/vibe-maestro.js');
  await access(join(installedRoot, 'templates/project/wiki/hot.md'));
  await access(join(installedRoot, 'schemas/manifest.schema.json'));
  await access(join(installedRoot, 'schemas/capabilities.v1.schema.json'));
  await access(join(installedRoot, 'registry/capabilities.v1.json'));
  await access(join(installedRoot, 'docs/USER_GUIDE.md'));
  await access(join(installedRoot, 'docs/THREAT_MODEL.md'));
  await access(join(installedRoot, 'docs/assets/quick-demo.gif'));
  await access(join(installedRoot, 'templates/project/protocols/build.md'));
  await access(join(installedRoot, 'templates/project/protocols/build/step-1-rules.md'));
  run(process.execPath, [installedCreate, '--help'], installDir);
  run(process.execPath, [installedMaestro, '--version'], installDir);

  for (const depth of ['light', 'standard', 'advanced']) {
    const project = `./packed ${depth} project`;
    run(process.execPath, [installedCreate, '--yes', '--no-git', '--target', project, '--start', 'idea', '--depth', depth], installDir);
    const manifest = JSON.parse(await readFile(join(installDir, project, '.maestro/manifest.json'), 'utf8'));
    assert.equal(manifest.project.depth, depth, `packed manifest depth must be ${depth}`);
    const report = JSON.parse(run(process.execPath, [installedMaestro, 'doctor', '--path', project, '--json'], installDir));
    assert.equal(report.reportVersion, 1, 'packed doctor JSON must publish reportVersion=1');
    assert.equal(report.ok, true, `fresh packed ${depth} project must pass doctor`);
  }

  const canonicalManifestText = await readFile(join(installDir, './packed standard project', '.maestro/manifest.json'), 'utf8');

  const incompleteParent = './packed incomplete parent';
  const incompleteProject = join(incompleteParent, 'packed standard project');
  const incompleteRoot = join(installDir, incompleteProject);
  await mkdir(join(incompleteRoot, '.maestro'), { recursive: true });
  await writeFile(join(incompleteRoot, 'app.ts'), 'export const foreign = true;\n', 'utf8');
  await writeFile(join(incompleteRoot, '.maestro/manifest.json'), canonicalManifestText, 'utf8');
  const incomplete = runResult(process.execPath, [installedCreate, '--yes', '--force', '--target', incompleteProject, '--start', 'code'], installDir);
  assert.notEqual(incomplete.status, 0, 'packed --force must reject a copied canonical manifest without the complete canonical tree');
  assert.equal(await readFile(join(incompleteRoot, 'app.ts'), 'utf8'), 'export const foreign = true;\n', 'rejected incomplete project must preserve user files');
  assert.equal(await readFile(join(incompleteRoot, '.maestro/manifest.json'), 'utf8'), canonicalManifestText, 'rejected incomplete project must not rewrite manifest');
  await assert.rejects(access(join(incompleteRoot, 'protocols')), 'rejected incomplete project must not receive protocols');

  const forgedProject = './packed forged project';
  const forgedRoot = join(installDir, forgedProject);
  await mkdir(join(forgedRoot, '.maestro'), { recursive: true });
  await writeFile(join(forgedRoot, 'app.ts'), 'export const foreign = true;\n', 'utf8');
  await writeFile(join(forgedRoot, 'package.json'), '{"private":true}\n', 'utf8');
  const forgedManifest = JSON.parse(canonicalManifestText);
  forgedManifest.product.name = 'not-maestro';
  await writeFile(join(forgedRoot, '.maestro/manifest.json'), JSON.stringify(forgedManifest, null, 2), 'utf8');
  const forged = runResult(process.execPath, [installedCreate, '--yes', '--force', '--target', forgedProject, '--start', 'code'], installDir);
  assert.notEqual(forged.status, 0, 'packed --force must reject foreign structurally-valid manifest');
  await assert.rejects(access(join(forgedRoot, 'protocols')), 'rejected foreign project must not receive protocols');

  const forgedDoctorProject = './packed forged doctor project';
  run(process.execPath, [installedCreate, '--yes', '--no-git', '--target', forgedDoctorProject, '--start', 'idea'], installDir);
  const forgedDoctorManifestPath = join(installDir, forgedDoctorProject, '.maestro/manifest.json');
  const forgedDoctorManifest = JSON.parse(await readFile(forgedDoctorManifestPath, 'utf8'));
  forgedDoctorManifest.product.name = 'forged-product';
  await writeFile(forgedDoctorManifestPath, JSON.stringify(forgedDoctorManifest, null, 2), 'utf8');
  const forgedDoctor = runResult(process.execPath, [installedMaestro, 'doctor', '--path', forgedDoctorProject, '--json'], installDir);
  assert.equal(forgedDoctor.status, 1, 'packed doctor must reject forged canonical identity');
  assert.ok(JSON.parse(forgedDoctor.stdout).findings.some((finding) => finding.code === 'manifest-canonical-mismatch'), 'packed doctor must report manifest-canonical-mismatch');

  const symlinkProject = './packed symlink project';
  run(process.execPath, [installedCreate, '--yes', '--no-git', '--target', symlinkProject, '--start', 'idea'], installDir);
  const symlinkRoot = join(installDir, symlinkProject);
  const symlinkOutside = join(symlinkRoot, 'outside.txt');
  await writeFile(symlinkOutside, 'outside\n', 'utf8');
  await rm(join(symlinkRoot, '.gitignore'));
  await symlink(symlinkOutside, join(symlinkRoot, '.gitignore'), 'file');
  const symlinkDoctor = runResult(process.execPath, [installedMaestro, 'doctor', '--path', symlinkProject, '--json'], installDir);
  assert.equal(symlinkDoctor.status, 1, 'packed doctor must reject symlink at merged .gitignore');
  assert.ok(JSON.parse(symlinkDoctor.stdout).findings.some((finding) => finding.code === 'managed-symlink' && finding.path === '.gitignore'), 'packed doctor must report managed-symlink for .gitignore');

  const strictProject = './packed standard project';
  await writeFile(join(installDir, strictProject, 'maestro/inbox/note.txt'), 'todo\n', 'utf8');
  const normalWarning = runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--json'], installDir);
  assert.equal(normalWarning.status, 0, 'default packed doctor must allow warning');
  const strictWarning = runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--strict', '--json'], installDir);
  assert.equal(strictWarning.status, 1, 'packed doctor --strict must block warning');
  assert.equal(JSON.parse(strictWarning.stdout).reportVersion, 1);

  const resolvedAudit = `---
type: audit
title: Resolved critical finding
audit_id: AUD-PACKED-001
status: resolved
---
# Audit

## Finding AUD-PACKED-001-F001
- severity: critical
- target: src/auth.ts
- evidence: tests/auth.test.ts:42 reproduced the original finding
- status: resolved
- resolution: tests/auth.test.ts now passes after the fix
`;
  const resolvedAuditPath = join(installDir, strictProject, 'wiki/audits/resolved.md');
  await writeFile(resolvedAuditPath, resolvedAudit, 'utf8');
  const resolvedDoctor = runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--json'], installDir);
  assert.equal(resolvedDoctor.status, 0, 'packed doctor must accept resolved critical finding with evidence and resolution');

  await writeFile(resolvedAuditPath, resolvedAudit.replace('- evidence: tests/auth.test.ts:42 reproduced the original finding\n', ''), 'utf8');
  const evidenceDoctor = runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--json'], installDir);
  assert.equal(evidenceDoctor.status, 1, 'packed doctor must reject a finding without evidence');
  assert.ok(JSON.parse(evidenceDoctor.stdout).findings.some((finding) => finding.code === 'audit-malformed' && finding.path === 'wiki/audits/resolved.md'), 'packed doctor must report audit-malformed when evidence is missing');
  await rm(resolvedAuditPath);

  const waivedAudit = `---
type: audit
title: Waived critical finding
audit_id: AUD-PACKED-002
status: waived
---
# Audit

## Finding AUD-PACKED-002-F001
- severity: critical
- target: src/auth.ts
- evidence: tests/auth.test.ts:42 reproduced the finding
- status: waived
- resolution: accepted without a fix
`;
  await writeFile(join(installDir, strictProject, 'wiki/audits/waived.md'), waivedAudit, 'utf8');
  const waivedDoctor = runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--json'], installDir);
  assert.equal(waivedDoctor.status, 1, 'packed doctor must not allow waived to hide a critical finding');
  assert.ok(JSON.parse(waivedDoctor.stdout).findings.some((finding) => finding.code === 'audit-malformed' && finding.path === 'wiki/audits/waived.md'), 'packed doctor must reject waived audit status');

  const protocolPath = join(installDir, strictProject, 'protocols/build/step-1-rules.md');
  const protocol = await readFile(protocolPath, 'utf8');
  await writeFile(protocolPath, protocol.replace('<a id="VCM-HUMAN-AUTHORITY"></a>', ''), 'utf8');
  const drift = JSON.parse(runResult(process.execPath, [installedMaestro, 'doctor', '--path', strictProject, '--json'], installDir).stdout);
  assert.ok(drift.findings.some((finding) => finding.code === 'protocol-contract-missing'), 'packed doctor must report protocol-contract-missing');

  console.log('CI acceptance passed (source + canonical packed install)');
} finally {
  await Promise.all([
    rm(tempRoot, { recursive: true, force: true }),
    packDir ? rm(packDir, { recursive: true, force: true }) : Promise.resolve(),
    installDir ? rm(installDir, { recursive: true, force: true }) : Promise.resolve(),
  ]);
}
