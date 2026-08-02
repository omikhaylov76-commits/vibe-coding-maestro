import { scanSkills } from '../core/skills.js';
import type { CliIo } from './io.js';
import { EXIT_OK } from './io.js';

export interface SkillsRunOptions { path: string; json: boolean }

export async function executeSkillsCommand(options: SkillsRunOptions, io: CliIo): Promise<number> {
  const report = await scanSkills(options.path);
  if (options.json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(`Skill Inventory: найдено ${report.skills.length}; предупреждений ${report.results.length}.`);
    for (const skill of report.skills) io.out(`- ${skill.path}${skill.frontmatter.name ? ` — ${skill.frontmatter.name}` : ''}`);
    for (const result of report.results) io.out(`! ${result.code}${result.path ? ` (${result.path})` : ''}: ${result.message}`);
    io.out(`Рекомендаций trusted registry v${report.registryVersion}: ${report.recommendations.length}.`);
    io.out(report.notice);
  }
  return EXIT_OK;
}
