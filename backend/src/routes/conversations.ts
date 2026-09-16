// Conversation routes: list, create (private/group), details.
import { Hono } from 'hono';
import { getAuth, requireAuth, requireMembership } from '../lib/auth';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { createConversationSchema } from '../lib/schemas';
import { publishToMembers } from '../lib/publish';

export const conversationRoutes = new Hono<{ Bindings: Env }>();

conversationRoutes.use('*', requireAuth);

conversationRoutes.get('/', async (c) => {
  const userId = getAuth(c).userId;
  const res = await c.env.DB.prepare(
    `SELECT c.id, c.type, c.title, c.created_by, c.last_message_at, c.created_at, m.role, m.last_read_at,
            lm.body AS last_body, lm.type AS last_type, lm.sender_id AS last_sender_id,
            lm.deleted_at AS last_deleted,
            (SELECT COUNT(*) FROM messages x
              WHERE x.conversation_id = c.id AND x.deleted_at IS NULL
                AND x.created_at > COALESCE(m.last_read_at, 0)
                AND x.sender_id IS NOT NULL AND x.sender_id != ?1
                AND x.type != 'system') AS unread_count
     FROM conversations c
     JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ?1
     LEFT JOIN messages lm ON lm.id = c.last_message_id
     ORDER BY COALESCE(lm.created_at, c.created_at) DESC
     LIMIT 200`,
  )
    .bind(userId)
    .all();

  const convs = res.results ?? [];
  // Attach member info for each conversation (2nd query; N<=200, 20 users total)
  const memberRows = await c.env.DB.prepare(
    `SELECT cm.conversation_id, u.id, u.username, u.display_name, u.avatar_attachment_id, u.last_seen_at, cm.role
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?1)`,
  )
    .bind(userId)
    .all();

  const membersByConv = new Map<string, unknown[]>();
  for (const row of memberRows.results ?? []) {
    const arr = membersByConv.get(row.conversation_id as string) ?? [];
    arr.push({
      user: {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        avatar_attachment_id: row.avatar_attachment_id,
        last_seen_at: row.last_seen_at,
      },
      role: row.role,
    });
    membersByConv.set(row.conversation_id as string, arr);
  }

  const items = convs.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    created_by: row.created_by,
    created_at: row.created_at,
    my_role: row.role,
    unread_count: row.unread_count,
    last_message: row.last_body !== undefined && row.last_message_at !== null
      ? {
          body: row.last_deleted ? null : row.last_body,
          type: row.last_type,
          sender_id: row.last_sender_id,
          created_at: row.last_message_at,
        }
      : null,
    members: membersByConv.get(row.id as string) ?? [],
  }));

  return c.json({ items });
});

conversationRoutes.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);
  }
  const { type, title, member_ids } = parsed.data;
  const me = getAuth(c).userId;
  const now = Date.now();
  const db = c.env.DB;

  // validate target users exist
  const uniqueIds = [...new Set(member_ids.filter((id) => id !== me))];
  for (const uid of uniqueIds) {
    const exists = await db.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first();
    if (!exists) throw notFound('USER_NOT_FOUND', `User ${uid} does not exist`);
  }

  if (type === 'private') {
    if (uniqueIds.length !== 1) throw badRequest('VALIDATION_ERROR', 'Private conversation needs exactly one other member');
    const other = uniqueIds[0];
    // dedupe: find existing private conversation between the two users
    const existing = await db
      .prepare(
        `SELECT c.id FROM conversations c
         WHERE c.type = 'private'
           AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?1)
           AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?2)
         LIMIT 1`,
      )
      .bind(me, other)
      .first();
    if (existing) {
      return c.json({ conversation_id: existing.id as string, existed: true });
    }
    const convId = crypto.randomUUID();
    const batch = [
      db.prepare(`INSERT INTO conversations (id, type, created_by, created_at) VALUES (?1, 'private', ?2, ?3)`)
        .bind(convId, me, now),
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`)
        .bind(convId, me, now),
      db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)`)
        .bind(convId, other, now),
    ];
    await db.batch(batch);
    await publishToMembers(c.env, convId, [me, other], {
      t: 'conversation.new',
      conversation_id: convId,
    });
    return c.json({ conversation_id: convId, existed: false }, 201);
  }

  // group
  const maxMembers = parseInt(c.env.MAX_GROUP_MEMBERS ?? '50', 10);
  if (uniqueIds.length + 1 > maxMembers) {
    throw badRequest('GROUP_TOO_LARGE', `Groups are limited to ${maxMembers} members`);
  }
  const convId = crypto.randomUUID();
  const batch = [
    db.prepare(`INSERT INTO conversations (id, type, title, created_by, created_at) VALUES (?1, 'group', ?2, ?3, ?4)`)
      .bind(convId, title, me, now),
    db.prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?1, ?2, 'owner', ?3)`)
      .bind(convId, me, now),
    ...uniqueIds.map(
      (uid) =>
        db
          .prepare(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?1, ?2, 'member', ?3)`)
          .bind(convId, uid, now),
    ),
  ];
  await db.batch(batch);

  const memberIds = [me, ...uniqueIds];
  await publishToMembers(c.env, convId, memberIds, { t: 'conversation.new', conversation_id: convId });
  return c.json({ conversation_id: convId, existed: false }, 201);
});

conversationRoutes.get('/:id', async (c) => {
  const convId = c.req.param('id');
  await requireMembership(c.env.DB, getAuth(c).userId, convId);
  const conv = await c.env.DB.prepare('SELECT * FROM conversations WHERE id = ?1').bind(convId).first();
  if (!conv) throw notFound('CONVERSATION_NOT_FOUND', 'Conversation does not exist');
  const members = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.display_name, u.avatar_attachment_id, u.last_seen_at, cm.role, cm.joined_at
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?1`,
  )
    .bind(convId)
    .all();
  return c.json({
    conversation: {
      id: conv.id,
      type: conv.type,
      title: conv.title,
      created_by: conv.created_by,
      created_at: conv.created_at,
    },
    members: members.results ?? [],
  });
});

conversationRoutes.delete('/:id', async (c) => {
  const convId = c.req.param('id');
  const m = await requireMembership(c.env.DB, getAuth(c).userId, convId);
  if (m.role !== 'owner') {
    throw forbidden('FORBIDDEN', 'Only the owner can delete a conversation');
  }
  await c.env.DB.prepare('DELETE FROM conversations WHERE id = ?1').bind(convId).run();
  return c.json({ ok: true });
});

// add member (groups only, owner/admin)
conversationRoutes.post('/:id/members', async (c) => {
  const convId = c.req.param('id');
  const m = await requireMembership(c.env.DB, getAuth(c).userId, convId);
  if (m.conversation_type !== 'group') throw badRequest('NOT_A_GROUP', 'Members can only be added to groups');
  if (m.role === 'member') throw forbidden('FORBIDDEN', 'Only owner/admin can add members');
  let body: { user_id?: string; role?: string };
  try {
    body = (await c.req.json()) as { user_id?: string; role?: string };
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const uid = String(body.user_id ?? '');
  if (!uid) throw badRequest('VALIDATION_ERROR', 'user_id required');
  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?1').bind(uid).first();
  if (!exists) throw notFound('USER_NOT_FOUND', 'User does not exist');
  const already = await c.env.DB.prepare(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ?1 AND user_id = ?2',
  )
    .bind(convId, uid)
    .first();
  if (already) return c.json({ ok: true, existed: true });
  const role = body.role === 'admin' && m.role === 'owner' ? 'admin' : 'member';
  await c.env.DB.prepare(
    `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(convId, uid, role, Date.now())
    .run();
  const memberIds = await c.env.DB.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?1')
    .bind(convId)
    .all<{ user_id: string }>();
  await publishToMembers(c.env, convId, (memberIds.results ?? []).map((r) => r.user_id), {
    t: 'member.added',
    conversation_id: convId,
    user_id: uid,
  });
  return c.json({ ok: true }, 201);
});

conversationRoutes.delete('/:id/members/:userId', async (c) => {
  const convId = c.req.param('id');
  const target = c.req.param('userId');
  const m = await requireMembership(c.env.DB, getAuth(c).userId, convId);
  if (m.conversation_type !== 'group') throw badRequest('NOT_A_GROUP', 'Members can only be removed from groups');
  const me = getAuth(c).userId;
  if (target !== me && m.role === 'member') throw forbidden('FORBIDDEN', 'Only owner/admin can remove members');
  if (target === me && m.role === 'owner') throw forbidden('FORBIDDEN', 'Owner cannot leave; delete the group instead');
  await c.env.DB.prepare('DELETE FROM conversation_members WHERE conversation_id = ?1 AND user_id = ?2')
    .bind(convId, target)
    .run();
  return c.json({ ok: true });
});
