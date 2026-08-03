import { describe, expect, it } from 'vitest';
import { canonicalizeVerifiedMacVarAlias } from '../src/core/platform-paths.js';

describe('platform-owned path aliases', () => {
  it('канонизирует только подтверждённый системный macOS alias /var', async () => {
    const result = await canonicalizeVerifiedMacVarAlias('/var/folders/project', 'darwin', {
      isSymlink: async (path) => path === '/var',
      realpath: async () => '/private/var',
    });
    expect(result).toBe('/private/var/folders/project');
  });

  it('не доверяет произвольному symlink prefix даже на macOS', async () => {
    const result = await canonicalizeVerifiedMacVarAlias('/tmp-link/project', 'darwin', {
      isSymlink: async () => true,
      realpath: async () => '/outside',
    });
    expect(result).toBe('/tmp-link/project');
  });

  it('не канонизирует /var, если alias не symlink или ведёт не в /private/var', async () => {
    const notLink = await canonicalizeVerifiedMacVarAlias('/var/project', 'darwin', {
      isSymlink: async () => false,
      realpath: async () => '/private/var',
    });
    const wrongTarget = await canonicalizeVerifiedMacVarAlias('/var/project', 'darwin', {
      isSymlink: async () => true,
      realpath: async () => '/user-controlled',
    });
    expect(notLink).toBe('/var/project');
    expect(wrongTarget).toBe('/var/project');
  });

  it('не применяет macOS alias policy на других платформах', async () => {
    expect(await canonicalizeVerifiedMacVarAlias('/var/project', 'linux')).toBe('/var/project');
    expect(await canonicalizeVerifiedMacVarAlias('C:\\var\\project', 'win32')).toBe('C:\\var\\project');
  });
});
