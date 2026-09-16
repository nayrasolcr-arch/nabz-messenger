// Applies D1 migrations once before the whole test run.
import { applyD1Migrations, env } from 'cloudflare:test';

// The pool provides DB + TEST_MIGRATIONS at runtime; typing differs across
// pool-worker versions, so access them through a structural cast.
const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
