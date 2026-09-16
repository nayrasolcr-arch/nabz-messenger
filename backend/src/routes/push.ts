// Push notification registration (device tokens) + misc endpoints.
import { Hono } from 'hono';
import { getAuth, requireAuth } from '../lib/auth';
import { badRequest } from '../lib/errors';
import { pushRegisterSchema } from '../lib/schemas';

export const pushRoutes = new Hono<{ Bindings: Env }>();

pushRoutes.use('*', requireAuth);

pushRoutes.post('/register', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = pushRegisterSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);
  const me = getAuth(c).userId;
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT id FROM devices WHERE user_id = ?1 AND device_uid = ?2')
    .bind(me, parsed.data.device_uid)
    .first();
  if (existing) {
    await c.env.DB.prepare(
      `UPDATE devices SET push_provider = ?1, push_token = ?2, name = COALESCE(?3, name), last_active_at = ?4 WHERE id = ?5`,
    )
      .bind(parsed.data.provider, parsed.data.push_token, parsed.data.name ?? null, now, existing.id)
      .run();
    return c.json({ ok: true, device_id: existing.id });
  }
  const deviceId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO devices (id, user_id, device_uid, name, platform, push_provider, push_token, created_at, last_active_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(deviceId, me, parsed.data.device_uid, parsed.data.name ?? null, parsed.data.platform, parsed.data.provider, parsed.data.push_token, now)
    .run();
  return c.json({ ok: true, device_id: deviceId }, 201);
});

pushRoutes.post('/unregister', async (c) => {
  const me = getAuth(c).userId;
  let body: { device_uid?: string };
  try {
    body = (await c.req.json()) as { device_uid?: string };
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  if (!body.device_uid) throw badRequest('VALIDATION_ERROR', 'device_uid required');
  await c.env.DB.prepare('UPDATE devices SET push_token = NULL WHERE user_id = ?1 AND device_uid = ?2')
    .bind(me, body.device_uid)
    .run();
  return c.json({ ok: true });
});
