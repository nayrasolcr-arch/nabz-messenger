// Authentication routes (public): register, login, refresh, logout, logout-all.
import { Hono } from 'hono';
import { ApiError, badRequest, conflict, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword, dummyVerify, randomToken, sha256Hex, safeEqualStrings } from '../lib/crypto';
import { rateLimit, clientIp } from '../lib/ratelimit';
import { registerSchema, loginSchema, refreshSchema } from '../lib/schemas';
import { intVar } from '../lib/vars';
import { toPublicUser, type SessionRow } from '../types';
import { getAuth } from '../lib/auth';

export const authRoutes = new Hono<{ Bindings: Env }>();


function parseOrThrow<T>(schema: { safeParse(v: unknown): { success: boolean; data?: T; error?: { issues: unknown[] } } }, body: unknown): T {
  const res = schema.safeParse(body);
  if (!res.success || !res.data) {
    throw badRequest('VALIDATION_ERROR', 'Invalid request body', res.error?.issues ?? []);
  }
  return res.data;
}

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
}

authRoutes.post('/register', async (c) => {
  const env = c.env;
  if (env.ALLOW_REGISTRATION !== 'true') {
    throw new ApiError(403, 'REGISTRATION_CLOSED', 'Registration is disabled');
  }
  const ip = clientIp(c.req.raw);
  const rl = await rateLimit(env, `register:${ip}`, intVar(env.REGISTER_RL_LIMIT, 5), 60 * 60 * 1000);
  if (!rl.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts', { retry_after: rl.retryAfterSec });

  const body = parseOrThrow(registerSchema, await jsonBody(c));

  if (env.INVITE_CODE) {
    const ok = safeEqualStrings(body.invite_code ?? '', env.INVITE_CODE);
    if (!ok) throw new ApiError(403, 'INVALID_INVITE', 'A valid invite code is required');
  }

  const now = Date.now();
  const iterations = intVar(env.PBKDF2_ITERATIONS, 50_000);
  const passwordHash = await hashPassword(body.password, iterations);
  const userId = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
      .bind(userId, body.username, body.display_name, passwordHash, now)
      .run();
  } catch (e) {
    const msg = String((e as Error).message ?? '');
    if (msg.includes('UNIQUE') || msg.includes('idx_users_username')) {
      throw conflict('USERNAME_TAKEN', 'This username is already registered');
    }
    throw e;
  }

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(userId).first();
  return c.json({ user: toPublicUser(user as never) }, 201);
});

authRoutes.post('/login', async (c) => {
  const env = c.env;
  const ip = clientIp(c.req.raw);
  const body = parseOrThrow(loginSchema, await jsonBody(c));

  const rlIp = await rateLimit(env, `login-ip:${ip}`, intVar(env.LOGIN_RL_LIMIT, 20), 10 * 60 * 1000);
  if (!rlIp.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts', { retry_after: rlIp.retryAfterSec });
  const rlUser = await rateLimit(env, `login-user:${body.username.toLowerCase()}`, intVar(env.LOGIN_USER_RL_LIMIT, 10), 10 * 60 * 1000);
  if (!rlUser.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts', { retry_after: rlUser.retryAfterSec });

  const iterations = intVar(env.PBKDF2_ITERATIONS, 50_000);
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?1 COLLATE NOCASE')
    .bind(body.username)
    .first();

  let verified: boolean;
  if (!user) {
    await dummyVerify(iterations); // equalize timing, prevent user enumeration
    verified = false;
  } else {
    verified = await verifyPassword(body.password, user.password_hash as string);
  }
  if (!verified || !user) throw unauthorized('BAD_CREDENTIALS', 'Invalid username or password');

  const now = Date.now();
  const sessionTtlMs = intVar(env.SESSION_TTL_HOURS, 24) * 3600_000;
  const refreshTtlMs = intVar(env.REFRESH_TTL_DAYS, 30) * 86_400_000;

  // Upsert device
  let device = await env.DB.prepare('SELECT * FROM devices WHERE user_id = ?1 AND device_uid = ?2')
    .bind(user.id, body.device_uid)
    .first();
  if (!device) {
    const deviceId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO devices (id, user_id, device_uid, name, platform, created_at, last_active_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
    )
      .bind(deviceId, user.id, body.device_uid, body.device_name ?? null, body.device_platform ?? null, now)
      .run();
    device = await env.DB.prepare('SELECT * FROM devices WHERE id = ?1').bind(deviceId).first();
  } else {
    await env.DB.prepare('UPDATE devices SET last_active_at = ?1, name = COALESCE(?2, name) WHERE id = ?3')
      .bind(now, body.device_name ?? null, device.id as string)
      .run();
  }
  if (!device) throw new Error('device upsert failed');

  const accessToken = randomToken();
  const refreshToken = randomToken();
  const sessionId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, device_id, token_hash, refresh_hash, expires_at, refresh_expires_at, created_at, last_rotated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(
      sessionId,
      user.id,
      device.id,
      await sha256Hex(accessToken),
      await sha256Hex(refreshToken),
      now + sessionTtlMs,
      now + refreshTtlMs,
      now,
    )
    .run();

  return c.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(sessionTtlMs / 1000),
    user: toPublicUser(user as never),
  });
});

authRoutes.post('/refresh', async (c) => {
  const env = c.env;
  const body = parseOrThrow(refreshSchema, await jsonBody(c));
  const rl = await rateLimit(env, `refresh:${clientIp(c.req.raw)}`, intVar(env.REFRESH_RL_LIMIT, 60), 10 * 60 * 1000);
  if (!rl.allowed) throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts', { retry_after: rl.retryAfterSec });

  const refreshHash = await sha256Hex(body.refresh_token);

  // Reuse detection: a previously-rotated refresh token presented again => revoke the whole family.
  const revoked = await env.DB.prepare('SELECT user_id FROM revoked_refresh_tokens WHERE refresh_hash = ?1')
    .bind(refreshHash)
    .first();
  if (revoked) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL')
      .bind(Date.now(), revoked.user_id)
      .run();
    throw unauthorized('REFRESH_REUSE', 'Refresh token reuse detected; all sessions revoked');
  }

  const session = await env.DB.prepare('SELECT * FROM sessions WHERE refresh_hash = ?1')
    .bind(refreshHash)
    .first<SessionRow>();
  if (!session) throw unauthorized('INVALID_REFRESH', 'Refresh token not recognized');

  if (session.revoked_at !== null) {
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL')
      .bind(Date.now(), session.user_id)
      .run();
    throw unauthorized('REFRESH_REUSE', 'Refresh token reuse detected; all sessions revoked');
  }
  if (session.refresh_expires_at < Date.now()) throw unauthorized('REFRESH_EXPIRED', 'Refresh token expired');

  const now = Date.now();
  const sessionTtlMs = intVar(env.SESSION_TTL_HOURS, 24) * 3600_000;
  const refreshTtlMs = intVar(env.REFRESH_TTL_DAYS, 30) * 86_400_000;
  const accessToken = randomToken();
  const refreshToken = randomToken();

  await env.DB.batch([
    env.DB.prepare('INSERT INTO revoked_refresh_tokens (refresh_hash, user_id, detected_at) VALUES (?1, ?2, ?3)')
      .bind(refreshHash, session.user_id, now),
    env.DB.prepare(
      `UPDATE sessions SET token_hash = ?1, refresh_hash = ?2, expires_at = ?3, refresh_expires_at = ?4,
         last_rotated_at = ?5, revoked_at = NULL WHERE id = ?6`,
    ).bind(
      await sha256Hex(accessToken),
      await sha256Hex(refreshToken),
      now + sessionTtlMs,
      now + refreshTtlMs,
      now,
      session.id,
    ),
  ]);

  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(session.user_id).first();
  return c.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: Math.floor(sessionTtlMs / 1000),
    user: toPublicUser(user as never),
  });
});

// Logout endpoints require an authenticated session, so they live on the
// PROTECTED router (mounted at /api/v1/auth after the requireAuth middleware).
export const authProtectedRoutes = new Hono<{ Bindings: Env }>();

authProtectedRoutes.post('/logout', async (c) => {
  const auth = getAuth(c);
  await c.env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE id = ?2').bind(Date.now(), auth.sessionId).run();
  return c.json({ ok: true });
});

authProtectedRoutes.post('/logout-all', async (c) => {
  const auth = getAuth(c);
  await c.env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL')
    .bind(Date.now(), auth.userId)
    .run();
  return c.json({ ok: true });
});
