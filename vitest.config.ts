import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@app': resolvePath('./src/app.ts'),
      '@core': resolvePath('./src/core'),
      '@modules': resolvePath('./src/modules'),
      '@shared': resolvePath('./src/shared'),
      '@prisma-client': resolvePath('./src/generated/prisma/client.ts'),
      '@tests': resolvePath('./tests'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['src/**/*.integration.test.ts'],
          // Real databases, real Redis, real password hashing, and both providers running at
          // once: the default 5s is a coin toss on a loaded machine, not a signal.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.types.ts', 'src/server.ts'],
    },
  },
});
