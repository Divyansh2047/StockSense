import { defineConfig } from 'vitest/config';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://stocksense:stocksense@127.0.0.1:5432/stocksense_test';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
      JWT_SECRET: 'test-only-secret-that-is-comfortably-longer-than-32',
      OTP_DEV_ECHO: 'true',
    },
    // Tests share one database, so run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
