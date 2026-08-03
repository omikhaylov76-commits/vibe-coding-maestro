import { describe, expect, it } from 'vitest';
import { classifyProjectInput, resolveDesktopDirectory, resolveProjectInput } from '../src/cli/desktop.js';

describe('Guided First Run: имя или путь', () => {
  it.each([
    ['Мой проект', 'name'],
    ['./app', 'path'],
    ['../app', 'path'],
    ['/tmp/app', 'path'],
    ['~/Documents/app', 'path'],
    ['folder/app', 'path'],
    ['folder\\app', 'path'],
    ['C:\\work\\app', 'path'],
    ['\\\\server\\share\\app', 'path'],
  ] as const)('классифицирует %s как %s', (input, expected) => {
    expect(classifyProjectInput(input)).toBe(expected);
  });

  it('простое имя на macOS создаёт target на Desktop без изменения имени', async () => {
    const result = await resolveProjectInput('Новый проект Маестро', {
      mode: 'create', platform: 'darwin', home: '/Users/DaddyCool', cwd: '/tmp/repo',
    });
    expect(result).toEqual({
      target: '/Users/DaddyCool/Desktop/Новый проект Маестро',
      name: 'Новый проект Маестро',
      usedDesktopDefault: true,
    });
  });

  it('явный macOS путь не получает Desktop prefix', async () => {
    const result = await resolveProjectInput('/Users/DaddyCool/Projects/App', {
      mode: 'create', platform: 'darwin', home: '/Users/DaddyCool', cwd: '/tmp/repo',
    });
    expect(result.target).toBe('/Users/DaddyCool/Projects/App');
    expect(result.name).toBe('App');
    expect(result.usedDesktopDefault).toBe(false);
  });

  it('раскрывает ведущий tilde и снимает парные внешние кавычки', async () => {
    const result = await resolveProjectInput('"~/Documents/Мой проект"', {
      mode: 'create', platform: 'darwin', home: '/Users/me', cwd: '/tmp',
    });
    expect(result.target).toBe('/Users/me/Documents/Мой проект');
  });

  it('connect и check всегда трактуют простую строку как путь от cwd', async () => {
    for (const mode of ['connect', 'check'] as const) {
      const result = await resolveProjectInput('existing', {
        mode, platform: 'darwin', home: '/Users/me', cwd: '/Users/me/Projects',
      });
      expect(result.target).toBe('/Users/me/Projects/existing');
      expect(result.usedDesktopDefault).toBe(false);
    }
  });

  it('Windows plain name использует USERPROFILE/Desktop через win32 semantics', async () => {
    const result = await resolveProjectInput('My Project', {
      mode: 'create', platform: 'win32', home: 'C:\\Users\\Alex', cwd: 'D:\\repo',
    });
    expect(result.target).toBe('C:\\Users\\Alex\\Desktop\\My Project');
  });

  it('Linux читает безопасный XDG_DESKTOP_DIR и иначе использует HOME/Desktop', async () => {
    expect(await resolveDesktopDirectory({
      platform: 'linux', home: '/home/alex',
      readXdgConfig: async () => 'XDG_DESKTOP_DIR="$HOME/Рабочий стол"\n',
    })).toBe('/home/alex/Рабочий стол');
    expect(await resolveDesktopDirectory({
      platform: 'linux', home: '/home/alex', readXdgConfig: async () => 'garbage',
    })).toBe('/home/alex/Desktop');
  });

  it('пустой ввод и отсутствие home дают понятную ошибку, не cwd fallback', async () => {
    await expect(resolveProjectInput('   ', {
      mode: 'create', platform: 'darwin', home: '/Users/me', cwd: '/tmp/repo',
    })).rejects.toThrow('Введите название проекта или путь');
    await expect(resolveDesktopDirectory({ platform: 'darwin', home: '' })).rejects.toThrow('домашнюю папку');
  });
});
