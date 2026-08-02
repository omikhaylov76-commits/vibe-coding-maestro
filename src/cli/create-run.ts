import { doctorProject } from '../core/doctor.js';
import { initProject } from '../core/init.js';
import type { StartingPoint } from '../core/meta.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface CreateRunOptions {
  target: string;
  name?: string;
  startingPoint: StartingPoint;
  force: boolean;
  git: boolean;
  json: boolean;
}

export async function executeCreate(options: CreateRunOptions, io: CliIo): Promise<number> {
  const result = await initProject({
    target: options.target,
    startingPoint: options.startingPoint,
    force: options.force,
    git: options.git,
    ...(options.name === undefined ? {} : { name: options.name }),
  });

  if (!result.ok) {
    if (options.json) io.out(JSON.stringify(result, null, 2));
    else io.err(result.error ?? 'Не удалось подготовить проект.');
    return EXIT_FAILED;
  }

  const report = await doctorProject(result.target);
  const output = { init: result, doctor: report };
  if (options.json) {
    io.out(JSON.stringify(output, null, 2));
  } else {
    io.out(`Проект подготовлен: ${result.target}`);
    for (const warning of result.warnings) {
      io.err(`Предупреждение: ${warning}`);
    }
    io.out(report.ok ? 'Doctor: всё сходится.' : `Doctor: найдено проблем — ${report.findings.length}.`);
  }
  return report.ok ? EXIT_OK : EXIT_FAILED;
}
