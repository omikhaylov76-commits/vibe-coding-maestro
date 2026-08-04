import { doctorProject } from '../core/doctor.js';
import type { CliIo } from './io.js';
import { EXIT_FAILED, EXIT_OK } from './io.js';

export interface DoctorRunOptions {
  path: string;
  json: boolean;
  strict?: boolean;
}

export async function executeDoctorCommand(options: DoctorRunOptions, io: CliIo): Promise<number> {
  const report = await doctorProject(options.path, { strict: options.strict });
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    io.out('Vibe Coding Maestro doctor: всё сходится.');
  } else {
    io.err(`Vibe Coding Maestro doctor: найдено проблем — ${report.findings.length}.`);
    for (const item of report.findings) {
      io.err(`- ${item.code}${item.path ? ` (${item.path})` : ''}: ${item.message}`);
    }
  }
  return report.ok ? EXIT_OK : EXIT_FAILED;
}
