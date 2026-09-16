// Message routes: list, send, edit, delete, reply, reactions, read receipts,
// pins, typing (REST fallback; realtime path is the WebSocket).
import { Hono } from 'hono';
import { getAuth, requireAuth, requireMembership, listMemberIds } from '../lib/auth';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { sendMessageSchema, editMessageSchema, reactionSchema, readSchema, typingSchema } from '../lib/schemas';
import { publishToMembers } from '../lib/publish';
import { rateLimit } from '../lib/ratelimit';
import { intVar } from '../lib/vars';
import { sendPushToUsers } from '../lib/push';
import type { MessageRow } from '../types';

export const messageRoutes = new Hono<{ Bindings: Env }>();

messageRoutes.use('*', requireAuth);

async function messageWithMeta(db: D1Database, messageId: string, viewerId: string) {
  const msg = (await db.prepare('SELECT * FROM messages WHERE id = ?1').bind(messageId).first()) as MessageRow | null;
  if (!msg) return null;
  const reactions = await db
    .prepare(
      `SELECT emoji, GROUP_CONCAT(user_id) AS users FROM message_reactions WHERE message_id = ?1 GROUP BY emoji`,
    )
    .bind(messageId)
    .all<{ emoji: string; users: string }>();
  const reply = msg.reply_to_message_id
    ? await db
        .prepare(
          `SELECT m.id, m.type, m.body, m.created_at, u.display_name AS sender_name
           FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?1`,
        )
        .bind(msg.reply_to_message_id)
        .first()
    : null;
  const attachment = msg.attachment_id
    ? await db
        .prepare('SELECT id, kind, mime_type, size_bytes, duration_ms, waveform FROM attachments WHERE id = ?1')
        .bind(msg.attachment_id)
        .first()
    : null;
  if (attachment && typeof attachment.waveform === 'string') {
    try {
      attachment.waveform = JSON.parse(attachment.waveform as string);
    } catch {
      attachment.waveform = null;
    }
  }
  const myReaction = await db
    .prepare('SELECT emoji FROM message_reactions WHERE message_id = ?1 AND user_id = ?2')
    .bind(messageId, viewerId)
    .all<{ emoji: string }>();
  const sender = msg.sender_id
    ? await db.prepare('SELECT id, username, display_name FROM users WHERE id = ?1').bind(msg.sender_id).first()
    : null;
  return {
    id: msg.id,
    conversation_id: msg.conversation_id,
    type: msg.type,
    body: msg.deleted_at ? null : msg.body,
    reply_to: reply ?? null,
    attachment: attachment ?? null,
    pinned_at: msg.pinned_at,
    edited_at: msg.edited_at,
    deleted_at: msg.deleted_at,
    created_at: msg.created_at,
    sender: sender ? { id: sender.id, username: sender.username, display_name: sender.display_name } : null,
    reactions: (reactions.results ?? []).map((r) => ({ emoji: r.emoji, user_ids: (r.users ?? '').split(',') })),
    my_reactions: (myReaction.results ?? []).map((r) => r.emoji),
  };
}

messageRoutes.get('/conversations/:id/messages', async (c) => {
  const convId = c.req.param('id');
  await requireMembership(c.env.DB, getAuth(c).userId, convId);
  const before = c.req.query('before'); // created_at cursor (ms)
  const after = c.req.query('after');
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 100);

  let rows;
  if (after) {
    rows = await c.env.DB.prepare(
      `SELECT id FROM messages WHERE conversation_id = ?1 AND created_at > ?2 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT ?3`,
    )
      .bind(convId, parseInt(after, 10) || 0, limit)
      .all<{ id: string }>();
  } else {
    rows = await c.env.DB.prepare(
      `SELECT id FROM messages WHERE conversation_id = ?1 AND deleted_at IS NULL
       AND (?2 IS NULL OR created_at < ?2) ORDER BY created_at DESC LIMIT ?3`,
    )
      .bind(convId, before ? parseInt(before, 10) : null, limit)
      .all<{ id: string }>();
  }

  const items = [];
  for (const row of rows.results ?? []) {
    const full = await messageWithMeta(c.env.DB, row.id, getAuth(c).userId);
    if (full) items.push(full);
  }
  if (!after) items.reverse(); // chronological order for paging backwards
  return c.json({ items });
});

messageRoutes.post('/conversations/:id/messages', async (c) => {
  const convId = c.req.param('id');
  const me = getAuth(c).userId;
  await requireMembership(c.env.DB, me, convId);

  const rl = await rateLimit(c.env, `send:${me}`, intVar(c.env.SEND_RL_LIMIT, 60), 60_000);
  if (!rl.allowed) throw tooMany(rl.retryAfterSec);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = sendMessageSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);
  const { type, body: text, reply_to_message_id, attachment_id } = parsed.data;

  if (reply_to_message_id) {
    const parent = await c.env.DB.prepare(
      'SELECT id, conversation_id, deleted_at FROM messages WHERE id = ?1',
    )
      .bind(reply_to_message_id)
      .first();
    if (!parent || parent.conversation_id !== convId || parent.deleted_at !== null) {
      throw badRequest('INVALID_REPLY', 'reply_to_message_id must reference a message in this conversation');
    }
  }
  if (attachment_id) {
    const att = await c.env.DB.prepare('SELECT id, owner_id, conversation_id FROM attachments WHERE id = ?1')
      .bind(attachment_id)
      .first();
    if (!att || att.owner_id !== me || (att.conversation_id !== null && att.conversation_id !== convId)) {
      throw badRequest('INVALID_ATTACHMENT', 'attachment_id is not available for this conversation');
    }
  }

  const now = Date.now();
  const msgId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, type, body, reply_to_message_id, attachment_id, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(msgId, convId, me, type, text ?? null, reply_to_message_id ?? null, attachment_id ?? null, now),
    c.env.DB.prepare(`UPDATE conversations SET last_message_id = ?1, last_message_at = ?2 WHERE id = ?3`).bind(
      msgId,
      now,
      convId,
    ),
    c.env.DB.prepare(
      `UPDATE conversation_members SET last_read_message_id = ?1, last_read_at = ?2 WHERE conversation_id = ?3 AND user_id = ?4`,
    ).bind(msgId, now, convId, me),
  ]);

  const full = await messageWithMeta(c.env.DB, msgId, me);
  const memberIds = await listMemberIds(c.env.DB, convId);

  await publishToMembers(c.env, convId, memberIds, { t: 'message.new', conversation_id: convId, message: full }, me);

  // Push notifications for offline members (mention detection: @username)
  const others = memberIds.filter((id) => id !== me);
  if (others.length > 0) {
    let mentioned = false;
    if (text && type === 'text') {
      const meUser = await c.env.DB.prepare('SELECT username FROM users WHERE id = ?1').bind(me).first();
      // mention of OTHER members, not self
      const res = await c.env.DB.prepare(
        `SELECT id, username FROM users WHERE id IN (SELECT user_id FROM conversation_members WHERE conversation_id = ?1)
          AND id != ?2 AND instr(?3, '@' || username) > 0`,
      )
        .bind(convId, me, text)
        .all<{ id: string }>();
      mentioned = (res.results ?? []).length > 0;
      if (mentioned) {
        await sendPushToUsers(c.env, c.env.DB, (res.results ?? []).map((r) => r.id), {
          title: 'Mention',
          body: text.slice(0, 120),
          kind: 'mention',
          conversationId: convId,
        });
      }
    }
    const conv = await c.env.DB.prepare('SELECT type, title FROM conversations WHERE id = ?1').bind(convId).first();
    const senderName = String(full?.sender?.display_name ?? 'New message');
    const convTitle = conv?.type === 'group' ? (conv?.title as string) : senderName;
    await sendPushToUsers(c.env, c.env.DB, others, {
      title: convTitle,
      body: text ? text.slice(0, 120) : type === 'voice' ? 'Voice message' : 'Sent an attachment',
      kind: 'message',
      conversationId: convId,
    });
  }

  return c.json({ message: full }, 201);
});

messageRoutes.patch('/messages/:id', async (c) => {
  const msgId = c.req.param('id');
  const me = getAuth(c).userId;
  const msg = (await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(msgId).first()) as MessageRow | null;
  if (!msg || msg.deleted_at !== null) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  if (msg.sender_id !== me) throw forbidden('FORBIDDEN', 'Only the sender can edit a message');
  if (msg.type !== 'text') throw badRequest('NOT_EDITABLE', 'Only text messages can be edited');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = editMessageSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);

  const now = Date.now();
  await c.env.DB.prepare('UPDATE messages SET body = ?1, edited_at = ?2 WHERE id = ?3')
    .bind(parsed.data.body, now, msgId)
    .run();

  const full = await messageWithMeta(c.env.DB, msgId, me);
  const memberIds = await listMemberIds(c.env.DB, msg.conversation_id);
  await publishToMembers(c.env, msg.conversation_id, memberIds, {
    t: 'message.edited',
    conversation_id: msg.conversation_id,
    message: full,
  });
  return c.json({ message: full });
});

messageRoutes.delete('/messages/:id', async (c) => {
  const msgId = c.req.param('id');
  const me = getAuth(c).userId;
  const msg = (await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(msgId).first()) as MessageRow | null;
  if (!msg || msg.deleted_at !== null) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  const m = await requireMembership(c.env.DB, me, msg.conversation_id);
  const canDelete = msg.sender_id === me || (m.conversation_type === 'group' && (m.role === 'owner' || m.role === 'admin'));
  if (!canDelete) throw forbidden('FORBIDDEN', 'Not allowed to delete this message');

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE messages SET deleted_at = ?1, body = NULL, attachment_id = NULL, pinned_at = NULL, pinned_by = NULL WHERE id = ?2`,
  ).bind(now, msgId).run();

  const memberIds = await listMemberIds(c.env.DB, msg.conversation_id);
  await publishToMembers(c.env, msg.conversation_id, memberIds, {
    t: 'message.deleted',
    conversation_id: msg.conversation_id,
    message_id: msgId,
    deleted_at: now,
  });
  return c.json({ ok: true });
});

// Reactions (toggle)
messageRoutes.put('/messages/:id/reactions', async (c) => {
  const msgId = c.req.param('id');
  const me = getAuth(c).userId;
  const msg = (await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(msgId).first()) as MessageRow | null;
  if (!msg || msg.deleted_at !== null) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  await requireMembership(c.env.DB, me, msg.conversation_id);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = reactionSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid emoji', parsed.error.issues);
  const { emoji } = parsed.data;

  const existing = await c.env.DB.prepare(
    'SELECT rowid FROM message_reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3',
  )
    .bind(msgId, me, emoji)
    .first();
  let action: 'added' | 'removed';
  if (existing) {
    await c.env.DB.prepare('DELETE FROM message_reactions WHERE message_id = ?1 AND user_id = ?2 AND emoji = ?3')
      .bind(msgId, me, emoji)
      .run();
    action = 'removed';
  } else {
    await c.env.DB.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(msgId, me, emoji, Date.now())
      .run();
    action = 'added';
  }

  const full = await messageWithMeta(c.env.DB, msgId, me);
  const memberIds = await listMemberIds(c.env.DB, msg.conversation_id);
  await publishToMembers(c.env, msg.conversation_id, memberIds, {
    t: 'reaction',
    conversation_id: msg.conversation_id,
    message_id: msgId,
    action,
    emoji,
    user_id: me,
    reactions: full?.reactions ?? [],
  });
  return c.json({ action, reactions: full?.reactions ?? [] });
});

// Read receipts
messageRoutes.post('/conversations/:id/read', async (c) => {
  const convId = c.req.param('id');
  const me = getAuth(c).userId;
  await requireMembership(c.env.DB, me, convId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = readSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);

  const msg = await c.env.DB.prepare('SELECT id, conversation_id, created_at FROM messages WHERE id = ?1')
    .bind(parsed.data.message_id)
    .first();
  if (!msg || msg.conversation_id !== convId) throw badRequest('INVALID_MESSAGE', 'message_id is not in this conversation');

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO message_reads (message_id, conversation_id, user_id, read_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
    ).bind(msg.id, convId, me, now),
    c.env.DB.prepare(
      `UPDATE conversation_members SET last_read_message_id = ?1, last_read_at = ?2
       WHERE conversation_id = ?3 AND user_id = ?4 AND (last_read_at IS NULL OR last_read_at < ?2)`,
    ).bind(msg.id, now, convId, me),
  ]);

  const memberIds = await listMemberIds(c.env.DB, convId);
  await publishToMembers(c.env, convId, memberIds, {
    t: 'read',
    conversation_id: convId,
    user_id: me,
    message_id: msg.id,
    read_at: now,
  }, me);
  return c.json({ ok: true });
});

// Pins
messageRoutes.post('/messages/:id/pin', async (c) => {
  const msgId = c.req.param('id');
  const me = getAuth(c).userId;
  const msg = (await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(msgId).first()) as MessageRow | null;
  if (!msg || msg.deleted_at !== null) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  const m = await requireMembership(c.env.DB, me, msg.conversation_id);
  if (m.conversation_type === 'group') {
    if (m.role === 'member') throw forbidden('FORBIDDEN', 'Only owner/admin can pin in groups');
  } else if (m.conversation_type === 'ai') {
    throw forbidden('FORBIDDEN', 'Cannot pin in AI chat');
  }
  const now = Date.now();
  await c.env.DB.prepare('UPDATE messages SET pinned_at = ?1, pinned_by = ?2 WHERE id = ?3').bind(now, me, msgId).run();
  const memberIds = await listMemberIds(c.env.DB, msg.conversation_id);
  await publishToMembers(c.env, msg.conversation_id, memberIds, {
    t: 'message.pinned',
    conversation_id: msg.conversation_id,
    message_id: msgId,
    pinned_at: now,
  });
  return c.json({ ok: true });
});

messageRoutes.delete('/messages/:id/pin', async (c) => {
  const msgId = c.req.param('id');
  const me = getAuth(c).userId;
  const msg = (await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?1').bind(msgId).first()) as MessageRow | null;
  if (!msg) throw notFound('MESSAGE_NOT_FOUND', 'Message not found');
  await requireMembership(c.env.DB, me, msg.conversation_id);
  await c.env.DB.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?1').bind(msgId).run();
  const memberIds = await listMemberIds(c.env.DB, msg.conversation_id);
  await publishToMembers(c.env, msg.conversation_id, memberIds, {
    t: 'message.unpinned',
    conversation_id: msg.conversation_id,
    message_id: msgId,
  });
  return c.json({ ok: true });
});

messageRoutes.get('/conversations/:id/pinned', async (c) => {
  const convId = c.req.param('id');
  await requireMembership(c.env.DB, getAuth(c).userId, convId);
  const rows = await c.env.DB.prepare(
    `SELECT id FROM messages WHERE conversation_id = ?1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
     ORDER BY pinned_at DESC LIMIT 20`,
  )
    .bind(convId)
    .all<{ id: string }>();
  const items = [];
  for (const row of rows.results ?? []) {
    const full = await messageWithMeta(c.env.DB, row.id, getAuth(c).userId);
    if (full) items.push(full);
  }
  return c.json({ items });
});

// Typing indicator (REST fallback; the WebSocket path is preferred)
messageRoutes.post('/conversations/:id/typing', async (c) => {
  const convId = c.req.param('id');
  const me = getAuth(c).userId;
  await requireMembership(c.env.DB, me, convId);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = typingSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);
  const memberIds = await listMemberIds(c.env.DB, convId);
  await publishToMembers(c.env, convId, memberIds, {
    t: 'typing',
    conversation_id: convId,
    user_id: me,
    state: parsed.data.state,
  }, me);
  return c.json({ ok: true });
});
