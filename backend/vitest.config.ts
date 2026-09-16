import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        compatibilityDate: '2025-09-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          // test-friendly overrides (per-user limits stay low for rate-limit tests)
          REGISTER_RL_LIMIT: '1000',
          LOGIN_RL_LIMIT: '1000',
          LOGIN_USER_RL_LIMIT: '4',
          SEND_RL_LIMIT: '1000',
          AI_RL_LIMIT: '1000',
          SEARCH_RL_LIMIT: '1000',
          REFRESH_RL_LIMIT: '1000',
          ALLOW_REGISTRATION: 'true',
          AI_MOCK: '1',
          PBKDF2_ITERATIONS: '1000',
          // D1 migrations applied in test/apply-migrations.ts
          TEST_MIGRATIONS: await readD1Migrations('migrations'),
        },
      },
    }),
  ],
  test: {
    testTimeout: 30_000,
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
