import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { CHECKSUMS_PATH, contentChecksum, loadChecksums, loadManifest } from './manifest.js';

const execFileAsync = promisify(execFile);

export type FindingLevel = 'error' | 'warning';

export interface DoctorFinding {
  level: FindingLevel;
  code: string;
  message: string;
  path?: string;
}

export interface DoctorReport {
  ok: boolean;
  root: string;
  findings: DoctorFinding[];
}

function finding(code: string, message: string, path?: string): DoctorFinding {
  return { level: 'error', code, message, ...(path === undefined ? {} : { path }) };
}

async function checkWikiLinks(root: string, findings: DoctorFinding[]): Promise<void> {
  const indexPath = join(root, 'wiki/index.md');
  if (!existsSync(indexPath)) return;
  let text: string;
  try {
    text = await readFile(indexPath, 'utf8');
  } catch (error) {
    findings.push(finding('text-unreadable', `Не удалось прочитать wiki/index.md: ${error instanceof Error ? error.message : String(error)}`, 'wiki/index.md'));
    return;
  }

  const links = text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const raw = match[1]?.split('#')[0]?.trim();
    if (!raw || /^(?:https?:|mailto:)/i.test(raw)) continue;
    const target = resolve(dirname(indexPath), raw);
    if (!existsSync(target)) {
      findings.push(finding('wiki-link-broken', `Битая ссылка в wiki/index.md: ${raw}`, 'wiki/index.md'));
    }
  }
}

async function checkTrackedEnv(root: string, findings: DoctorFinding[]): Promise<void> {
  if (!existsSync(join(root, '.git'))) return;
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    for (const path of stdout.split('\0').filter(Boolean).sort()) {
      const base = path.split('/').at(-1) ?? path;
      if ((base === '.env' || base.startsWith('.env.')) && base !== '.env.example') {
        findings.push(finding('git-env-tracked', 'Секретный env-файл отслеживается Git.', path));
      }
    }
  } catch (error) {
    findings.push(
      finding(
        'git-check-failed',
        `Не удалось проверить Git index: ${error instanceof Error ? error.message : String(error)}`,
        '.git',
      ),
    );
  }
}

export async function doctorProject(rootInput: string): Promise<DoctorReport> {
  const root = resolve(rootInput);
  const findings: DoctorFinding[] = [];

  let manifest;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    findings.push(finding('manifest-invalid', `Манифест отсутствует или повреждён: ${error instanceof Error ? error.message : String(error)}`, '.maestro/manifest.json'));
    return { ok: false, root, findings };
  }

  const checksums = await loadChecksums(root);
  if (checksums === null) {
    findings.push(finding('checksums-invalid', 'Контрольные суммы отсутствуют или повреждены.', CHECKSUMS_PATH));
  }

  for (const entry of manifest.managed) {
    if (entry.kind !== 'managed') continue;
    const absolute = join(root, entry.path);
    if (!existsSync(absolute)) {
      findings.push(finding('managed-missing', 'Управляемый файл отсутствует.', entry.path));
      continue;
    }
    const expected = checksums?.files[entry.path];
    if (expected === undefined) continue;
    try {
      const actual = contentChecksum(entry.path, await readFile(absolute));
      if (actual !== expected) {
        findings.push(finding('managed-modified', 'Управляемый файл изменён относительно установленной версии.', entry.path));
      }
    } catch (error) {
      findings.push(finding('text-unreadable', `Не удалось прочитать файл: ${error instanceof Error ? error.message : String(error)}`, entry.path));
    }
  }

  await checkWikiLinks(root, findings);
  await checkTrackedEnv(root, findings);
  return { ok: findings.every((item) => item.level !== 'error'), root, findings };
}
