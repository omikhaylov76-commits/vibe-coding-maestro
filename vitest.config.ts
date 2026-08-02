import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Тесты создают временные каталоги и запускают git — параллельные файлы допустимы,
    // но внутри файла порядок последовательный.
    sequence: { concurrent: false },
  },
});
