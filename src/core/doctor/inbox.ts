import { pathHasSymlink } from './fs-utils.js';
import { critical } from './types.js';
import type { DoctorFinding } from './types.js';

/**
 * `maestro/inbox/` — одно место для материалов человека: файлы там не замечание,
 * даже в `--strict`. Проверяется только, что путь не уводит за пределы проекта.
 */
export async function checkInbox(root: string, findings: DoctorFinding[]): Promise<void> {
  const inboxPath = 'maestro/inbox';
  if (await pathHasSymlink(root, inboxPath)) {
    findings.push(critical('inbox-symlink', 'Inbox path не должен содержать symbolic link.', inboxPath));
  }
}
