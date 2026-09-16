/// <reference types="@cloudflare/workers-types" />

// Environment bindings & variables for Nabz backend.
// Secrets (set via `wrangler secret put`, NEVER in source):
//   INVITE_CODE, TURN_USERNAME, TURN_CREDENTIAL, FCM_SERVICE_ACCOUNT_JSON, AI_API_KEY
interface Env {
  // Bindings
  DB: D1Database;
  ATTACHMENTS: KVNamespace;
  REALTIME_HUB: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  AI?: WorkersAIBinding;

  // Vars (wrangler.toml)
  ENVIRONMENT: string;
  PBKDF2_ITERATIONS: string;
  SESSION_TTL_HOURS: string;
  REFRESH_TTL_DAYS: string;
  MAX_MESSAGE_LENGTH: string;
  MAX_ATTACHMENT_BYTES: string;
  ALLOW_REGISTRATION: string;
  MAX_GROUP_MEMBERS: string;
  AI_MODEL: string;
  STUN_URLS: string;

  // Optional secrets / future configuration
  INVITE_CODE?: string;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MOCK?: string;
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;

  // Rate limit overrides (tests; production defaults in lib code)
  REGISTER_RL_LIMIT?: string;
  LOGIN_RL_LIMIT?: string;
  LOGIN_USER_RL_LIMIT?: string;
  SEND_RL_LIMIT?: string;
  AI_RL_LIMIT?: string;
  SEARCH_RL_LIMIT?: string;
  REFRESH_RL_LIMIT?: string;
}

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

interface WorkersAIBinding {
  run(model: string, input: unknown): Promise<{ response?: string } & Record<string, unknown>>;
}

// Test environment (cloudflare:test)
interface ProvidedEnv extends Env {
  TEST_MIGRATIONS: D1Migration[];
}
