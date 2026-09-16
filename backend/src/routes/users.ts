// User + profile routes (protected).
import { Hono } from 'hono';
import { getAuth, requireAuth } from '../lib/auth';
import { notFound } from '../lib/errors';
import { updateProfileSchema } from '../lib/schemas';
import { toPublicUser } from '../types';

export const userRoutes = new Hono<{ Bindings: Env }>();

userRoutes.use('*', requireAuth);

userRoutes.get('/me', async (c) => {
  return c.json({ user: toPublicUser(getAuth(c).user) });
});

userRoutes.patch('/me', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw notFound('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid body', details: parsed.error.issues } }, 400);
  }
  const { display_name, bio, avatar_attachment_id } = parsed.data;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (display_name !== undefined) {
    sets.push('display_name = ?');
    binds.push(display_name);
  }
  if (bio !== undefined) {
    sets.push('bio = ?');
    binds.push(bio);
  }
  if (avatar_attachment_id !== undefined) {
    sets.push('avatar_attachment_id = ?');
    binds.push(avatar_attachment_id);
  }
  if (sets.length === 0) {
    return c.json({ user: toPublicUser(getAuth(c).user) });
  }
  sets.push('updated_at = ?');
  binds.push(Date.now(), getAuth(c).userId);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(getAuth(c).userId).first();
  return c.json({ user: toPublicUser(user as never) });
});

// Directory of all users (this deployment is capped at ~20 users by policy).
userRoutes.get('/', async (c) => {
  const res = await c.env.DB.prepare('SELECT * FROM users ORDER BY display_name COLLATE NOCASE LIMIT 200').all();
  const items = (res.results ?? []).map((u) => toPublicUser(u as never));
  return c.json({ items });
});

userRoutes.get('/:id', async (c) => {
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(c.req.param('id')).first();
  if (!user) throw notFound('USER_NOT_FOUND', 'User does not exist');
  return c.json({ user: toPublicUser(user as never) });
});
