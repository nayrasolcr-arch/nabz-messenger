// Search across the user's conversations.
import { Hono } from 'hono';
import { getAuth, requireAuth } from '../lib/auth';
import { rateLimit } from '../lib/ratelimit';
import { intVar } from '../lib/vars';
import { tooMany } from '../lib/errors';

export const searchRoutes = new Hono<{ Bindings: Env }>();

searchRoutes.use('*', requireAuth);

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

searchRoutes.get('/', async (c) => {
  const me = getAuth(c).userId;
  const rl = await rateLimit(c.env, `search:${me}`, intVar(c.env.SEARCH_RL_LIMIT, 30), 60_000);
  if (!rl.allowed) throw tooMany(rl.retryAfterSec);

  const q = (c.req.query('q') ?? '').trim().slice(0, 100);
  const conversationId = c.req.query('conversation_id') ?? null;
  if (q.length < 2) return c.json({ items: [] });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '30', 10) || 30, 50);

  const pattern = `%${escapeLike(q)}%`;
  const binds: unknown[] = [me, pattern];
  let convFilter = '';
  if (conversationId) {
    convFilter = ' AND m.conversation_id = ?3 ';
    binds.push(conversationId);
  }

  const rows = await c.env.DB.prepare(
    `SELECT m.id FROM messages m
     WHERE m.deleted_at IS NULL AND m.type IN ('text')
       AND m.body LIKE ?2 ESCAPE '\\'
       AND m.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?1)
       ${convFilter}
     ORDER BY m.created_at DESC LIMIT ${limit}`,
  )
    .bind(...binds)
    .all<{ id: string }>();

  const items = [];
  for (const row of rows.results ?? []) {
    const msg = await c.env.DB.prepare(
      `SELECT m.*, u.username AS sender_username, u.display_name AS sender_display_name, c.type AS conv_type, c.title AS conv_title
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ?1`,
    )
      .bind(row.id)
      .first();
    if (msg) {
      items.push({
        id: msg.id,
        conversation_id: msg.conversation_id,
        conversation_title: msg.conv_type === 'group' ? msg.conv_title : msg.sender_display_name,
        body: msg.body,
        created_at: msg.created_at,
        sender: msg.sender_id ? { id: msg.sender_id, username: msg.sender_username, display_name: msg.sender_display_name } : null,
      });
    }
  }
  return c.json({ items });
});
