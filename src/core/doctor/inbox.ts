import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathHasSymlink } from './fs-utils.js';
import { critical, warning } from './types.js';
import type { DoctorFinding } from './types.js';

export async function checkInbox(root: string, findings: DoctorFinding[]): Promise<void> {
  const inboxPath = 'maestro/inbox';
  const dir = join(root, inboxPath);
  if (await pathHasSymlink(root, inboxPath)) {
    findings.push(critical('inbox-symlink', 'Inbox path не должен содержать symbolic link.', inboxPath));
    return;
  }
  if (!existsSync(dir)) return;
  const entries = (await readdir(dir)).filter((name) => name !== 'README.md' && name !== '.gitkeep');
  if (entries.length > 0) findings.push(warning('inbox-not-empty', 'Inbox содержит необработанные материалы.', 'maestro/inbox'));
}
