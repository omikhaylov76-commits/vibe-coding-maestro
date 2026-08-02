import { lstat, opendir, open, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { tryLoadManifest } from './manifest.js';
import { packageRoot } from './paths.js';

export const SKILL_MAX_DEPTH = 4;
export const SKILL_MAX_FILES = 200;
export const SKILL_MAX_BYTES = 256 * 1024;
const ROOTS = ['.agents/skills', '.claude/skills'] as const;
const ALLOWED_SCALARS = ['name', 'description', 'version', 'license'] as const;

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  license?: string;
  platforms?: string[];
  metadata?: { tags: string[] };
}
export interface SkillResult { code: string; level: 'warning'; path?: string; message: string }
export interface SkillEntry { path: string; frontmatter: SkillFrontmatter; status: 'ok' | 'warning' }
export interface SkillRecommendation { id: string; name: string; source: string; version: string; license: string; requiredTools: string[] }
export interface SkillsReport {
  registryVersion: number;
  installed: false;
  notice: string;
  skills: SkillEntry[];
  results: SkillResult[];
  recommendations: SkillRecommendation[];
}
interface RegistryEntry extends SkillRecommendation { startingPoints: string[] }
interface Registry { version: number; skills: RegistryEntry[] }

function posix(root: string, path: string): string { return relative(root, path).split(sep).join('/'); }
function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}
function list(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  if (trimmed === '[]') return [];
  return trimmed.slice(1, -1).split(',').map(unquote).filter(Boolean);
}

/** Parses a deliberately tiny data-only YAML subset; unknown keys are ignored. */
export function parseSkillFrontmatter(text: string): { value: SkillFrontmatter; warning?: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { value: {}, warning: 'Отсутствует YAML frontmatter.' };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { value: {}, warning: 'Не закрыт YAML frontmatter.' };
  const lines = normalized.slice(4, end).split('\n');
  const value: SkillFrontmatter = {};
  let arrayKey: 'platforms' | 'tags' | null = null;
  let metadata = false;
  try {
    for (const raw of lines) {
      if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim();
      if (line.startsWith('- ')) {
        if (arrayKey === null || indent === 0) throw new Error('элемент списка без разрешённого поля');
        const item = unquote(line.slice(2));
        if (!item) throw new Error('пустой элемент списка');
        if (arrayKey === 'platforms') (value.platforms ??= []).push(item);
        else ((value.metadata ??= { tags: [] }).tags).push(item);
        continue;
      }
      const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(line);
      if (!match) throw new Error('неподдерживаемый YAML-синтаксис');
      const key = match[1] as string;
      const rawValue = match[2] ?? '';
      arrayKey = null;
      if (indent === 0) metadata = key === 'metadata';
      if (indent === 0 && (ALLOWED_SCALARS as readonly string[]).includes(key)) {
        if (!rawValue || /^[\[{]/.test(rawValue.trim())) throw new Error(`поле ${key} должно быть строкой`);
        value[key as typeof ALLOWED_SCALARS[number]] = unquote(rawValue);
      } else if (indent === 0 && key === 'platforms') {
        if (rawValue) { const items = list(rawValue); if (items === null) throw new Error('platforms должен быть списком'); value.platforms = items; }
        else { value.platforms = []; arrayKey = 'platforms'; }
      } else if (indent === 0 && key === 'metadata') {
        if (rawValue) throw new Error('metadata должен быть объектом');
      } else if (indent > 0 && metadata && key === 'tags') {
        if (rawValue) { const items = list(rawValue); if (items === null) throw new Error('metadata.tags должен быть списком'); value.metadata = { tags: items }; }
        else { value.metadata = { tags: [] }; arrayKey = 'tags'; }
      }
    }
    return { value };
  } catch (error) {
    return { value, warning: `Некорректный frontmatter: ${(error as Error).message}.` };
  }
}

async function candidates(root: string, results: SkillResult[]): Promise<string[]> {
  const found: string[] = [];
  let limited = false;
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try { entries = await opendir(dir); } catch { return; }
    const names: string[] = [];
    for await (const entry of entries) names.push(entry.name);
    names.sort();
    for (const name of names) {
      if (found.length >= SKILL_MAX_FILES) { limited = true; return; }
      const path = join(dir, name);
      let stat;
      try { stat = await lstat(path); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile() && name === 'SKILL.md') found.push(path);
      else if (stat.isDirectory() && depth < SKILL_MAX_DEPTH) await walk(path, depth + 1);
    }
  }
  for (const local of ROOTS) await walk(join(root, local), 0);
  if (limited) results.push({ code: 'file-limit-reached', level: 'warning', message: `Достигнут лимит ${SKILL_MAX_FILES} файлов SKILL.md.` });
  return found.sort((a, b) => posix(root, a).localeCompare(posix(root, b), 'en'));
}

async function readBounded(path: string): Promise<string | null> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > SKILL_MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

async function recommendations(root: string): Promise<{ version: number; items: SkillRecommendation[] }> {
  const registry = JSON.parse(await readFile(join(packageRoot(), 'registry/trusted-skills.v1.json'), 'utf8')) as Registry;
  const startingPoint = (await tryLoadManifest(root))?.project.startingPoint;
  const items = startingPoint === undefined ? [] : registry.skills
    .filter((item) => item.startingPoints.includes(startingPoint)).slice(0, 5)
    .map(({ startingPoints: _, ...item }) => item);
  return { version: registry.version, items };
}

export async function scanSkills(projectPath: string): Promise<SkillsReport> {
  const root = resolve(projectPath);
  const results: SkillResult[] = [];
  const skills: SkillEntry[] = [];
  for (const path of await candidates(root, results)) {
    const relativePath = posix(root, path);
    let text: string | null;
    try { text = await readBounded(path); } catch { results.push({ code: 'file-unreadable', level: 'warning', path: relativePath, message: 'SKILL.md не удалось безопасно прочитать.' }); continue; }
    if (text === null) { results.push({ code: 'file-too-large', level: 'warning', path: relativePath, message: `SKILL.md превышает ${SKILL_MAX_BYTES} байт.` }); continue; }
    const parsed = parseSkillFrontmatter(text);
    if (parsed.warning) results.push({ code: 'frontmatter-malformed', level: 'warning', path: relativePath, message: parsed.warning });
    skills.push({ path: relativePath, frontmatter: parsed.value, status: parsed.warning ? 'warning' : 'ok' });
  }
  const trusted = await recommendations(root);
  return { registryVersion: trusted.version, installed: false, notice: 'ничего не установлено', skills, results, recommendations: trusted.items };
}
