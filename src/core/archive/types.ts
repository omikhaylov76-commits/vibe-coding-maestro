export interface ArchiveBlocker {
  code: string;
  message: string;
  path?: string;
}

export const blocker = (code: string, message: string, path?: string): ArchiveBlocker => ({ code, message, ...(path === undefined ? {} : { path }) });
