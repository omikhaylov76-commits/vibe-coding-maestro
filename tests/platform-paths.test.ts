import { describe, expect, it } from 'vitest';
import { canonicalizeSystemTempPrefix } from '../src/core/platform-paths.js';

describe('platform-owned path aliases', () => {
  it('канонизирует только подтверждённый системный macOS alias /var', async () => {
    const result = await canonicalizeSystemTempPrefix('/var/folders/project', {
      platform: 'darwin',
      isSymlink: async (path) => path === '/var',
      realpath: async () => '/private/var',
    });
    expect(result).toBe('/private/var/folders/project');
  });

  it('не доверяет произвольному symlink prefix даже на macOS', async () => {
    const result = await canonicalizeSystemTempPrefix('/tmp-link/project', {
      platform: 'darwin',
      isSymlink: async () => true,
      realpath: async () => '/outside',
    });
    expect(result).toBe('/tmp-link/project');
  });

  it('не канонизирует /var, если alias не symlink или ведёт не в /private/var', async () => {
    const notLink = await canonicalizeSystemTempPrefix('/var/project', {
      platform: 'darwin',
      isSymlink: async () => false,
      realpath: async () => '/private/var',
    });
    const wrongTarget = await canonicalizeSystemTempPrefix('/var/project', {
      platform: 'darwin',
      isSymlink: async () => true,
      realpath: async () => '/user-controlled',
    });
    expect(notLink).toBe('/var/project');
    expect(wrongTarget).toBe('/var/project');
  });

  it('не применяет macOS alias policy на других платформах', async () => {
    expect(await canonicalizeSystemTempPrefix('/var/project', { platform: 'linux' })).toBe('/var/project');
    expect(await canonicalizeSystemTempPrefix('C:\\var\\project', { platform: 'win32' })).toMatch(/var/);
  });
});
