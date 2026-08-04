import { basename } from 'node:path';
import { doctorProject } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import type { StartingPoint } from '../core/meta.js';
import type { ProjectDepth } from '../core/manifest.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';
import type { CliRenderer } from './renderer.js';

export interface CreateRunOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  force: boolean;
  git: boolean;
  json: boolean;
  depth: ProjectDepth;
}

export async function executeCreate(options: CreateRunOptions, io: CliIo, renderer?: CliRenderer): Promise<number> {
  const result = await initProject({
    target: options.target,
    startingPoint: options.startingPoint,
    force: options.force,
    git: options.git,
    depth: options.depth,
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  if (!result.ok) {
    if (options.json) io.out(JSON.stringify(result, null, 2));
    else if (renderer) renderer.failure(result.error ?? 'Не удалось подготовить проект.');
    else io.err(result.error ?? 'Не удалось подготовить проект.');
    return EXIT_FAILED;
  }

  const report = await doctorProject(result.target);
  const output = { init: result, doctor: report };
  if (options.json) {
    io.out(JSON.stringify(output, null, 2));
  } else {
    if (!renderer) io.out(`Проект подготовлен: ${result.target}`);
    for (const warning of result.warnings) {
      if (renderer) renderer.warning(warning);
      else io.err(`Предупреждение: ${warning}`);
    }
    if (renderer) {
      if (report.ok) renderer.success({ action: 'create', target: result.target, name: options.name ?? basename(result.target), doctorOk: true });
      else renderer.failure(`Проверка нашла проблем: ${report.findings.length}.`);
    } else io.out(report.ok ? 'Doctor: всё сходится.' : `Doctor: найдено проблем — ${report.findings.length}.`);
  }
  return report.ok ? EXIT_OK : EXIT_FAILED;
}
