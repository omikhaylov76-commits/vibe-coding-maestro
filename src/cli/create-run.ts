import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { doctorProject } from '../core/doctor.js';
import { describeFsError } from '../core/fs-errors.js';
import { createGithubCopy, githubCreateCommand, githubRepoName } from '../core/github.js';
import type { GhRunner } from '../core/github.js';
import { initProject } from '../core/init.js';
import type { InitResult } from '../core/init.js';
import type { StartingPoint } from '../core/meta.js';
import type { ProjectDepth } from '../core/manifest.js';
import { onDiskBasename } from '../core/platform-paths.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';
import type { CliRenderer } from './renderer.js';

const execFileAsync = promisify(execFile);

export interface CreateRunOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  git: boolean;
  json: boolean;
  depth: ProjectDepth;
  /** Завести закрытую копию на GitHub после первого коммита. */
  github?: boolean;
  /** Флаги, переданные явно, а не взятые по умолчанию. */
  explicit?: { depth?: boolean; startingPoint?: boolean };
}

/** Итог шага «копия в облаке»: адрес, либо почему её нет. */
export type CloudOutcome =
  | { status: 'created'; url: string }
  | { status: 'none' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; later: string };

export async function executeCreate(options: CreateRunOptions, io: CliIo, renderer?: CliRenderer, gh?: GhRunner): Promise<number> {
  try {
    return await createAndCheck(options, io, renderer, gh);
  } catch (cause) {
    // initProject сам переводит ошибки записи; сюда доходит только непредвиденное.
    const message = describeFsError(cause, options.target);
    if (options.json) io.out(JSON.stringify({ ok: false, error: message }, null, 2));
    else if (renderer) renderer.failure(message);
    else io.err(message);
    return EXIT_FAILED;
  }
}

async function hasRemote(root: string): Promise<boolean> {
  const remotes = await execFileAsync('git', ['remote'], { cwd: root, encoding: 'utf8' }).catch(() => null);
  return remotes !== null && remotes.stdout.trim() !== '';
}

/**
 * Копия на GitHub — только для проекта, чей репозиторий и первый коммит сделал этот create.
 * Сбой gh не отменяет созданный проект: человек получает причину и команду на потом.
 */
async function cloudStep(options: CreateRunOptions, result: InitResult, gh?: GhRunner): Promise<CloudOutcome> {
  if (options.github !== true) return { status: 'none' };
  if (result.existingProject === true) {
    return {
      status: 'skipped',
      reason: (await hasRemote(result.target))
        ? '--github не применён: это готовый проект, и копия в облаке (remote) у него уже есть. Create не меняет готовый проект.'
        : '--github не применён: create не меняет готовый проект. Завести копию в облаке поможет `/start`.',
    };
  }
  const name = githubRepoName(onDiskBasename(result.target));
  if (result.gitCreated !== true) {
    return {
      status: 'skipped',
      reason: `--github не применён: первый коммит не сделан (репозиторий Git уже был или шаги Git пропущены). Когда коммит будет, из папки проекта: ${githubCreateCommand(name)}`,
    };
  }
  const copy = await createGithubCopy(result.target, name, gh);
  if (copy.ok) return { status: 'created', url: copy.url };
  // Репозиторий мог успеть появиться, а отправка — нет: тогда нужна только отправка.
  const later = (await hasRemote(result.target)) ? 'git push -u origin main' : githubCreateCommand(name);
  return { status: 'failed', reason: copy.reason, later };
}

function cloudLine(cloud: CloudOutcome): string {
  return cloud.status === 'created' ? `Копия в облаке: ${cloud.url}` : 'Копии в облаке нет — завести её поможет /start.';
}

async function createAndCheck(options: CreateRunOptions, io: CliIo, renderer?: CliRenderer, gh?: GhRunner): Promise<number> {
  const result = await initProject({
    target: options.target,
    startingPoint: options.startingPoint,
    git: options.git,
    depth: options.depth,
    requested: {
      ...(options.explicit?.depth === true ? { depth: options.depth } : {}),
      ...(options.explicit?.startingPoint === true ? { startingPoint: options.startingPoint } : {}),
    },
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  if (!result.ok) {
    if (options.json) io.out(JSON.stringify(result, null, 2));
    else if (renderer) renderer.failure(result.error ?? 'Не удалось подготовить проект.');
    else io.err(result.error ?? 'Не удалось подготовить проект.');
    return EXIT_FAILED;
  }

  const cloud = await cloudStep(options, result, gh);
  const warnings = [...result.warnings];
  if (cloud.status === 'skipped') warnings.push(cloud.reason);
  if (cloud.status === 'failed') warnings.push(`Копию на GitHub завести не удалось: ${cloud.reason}. Проект создан и работает на этом компьютере. Повторить можно из папки проекта: ${cloud.later}`);

  const report = await doctorProject(result.target);
  const output = { init: result, ...(options.github === true ? { github: cloud } : {}), doctor: report };
  if (options.json) {
    io.out(JSON.stringify(output, null, 2));
  } else {
    if (!renderer) io.out(`Проект подготовлен: ${result.target}`);
    for (const warning of warnings) {
      if (renderer) renderer.warning(warning);
      else io.err(`Предупреждение: ${warning}`);
    }
    if (renderer) {
      if (report.ok) renderer.success({ action: 'create', target: result.target, name: options.name ?? basename(result.target), doctorOk: true, cloud: cloud.status === 'created' ? cloud.url : null });
      else renderer.failure(`Проверка нашла проблем: ${report.findings.length}.`);
    } else {
      io.out(cloudLine(cloud));
      io.out(report.ok ? 'Doctor: всё сходится.' : `Doctor: найдено проблем — ${report.findings.length}.`);
    }
  }
  return report.ok ? EXIT_OK : EXIT_FAILED;
}
