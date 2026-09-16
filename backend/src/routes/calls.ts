// Voice call routes: call lifecycle + ICE configuration.
// Media never touches the server: WebRTC peer-to-peer (Opus codec), the server
// only does signaling over the WebSocket (see RealtimeHub) and stores call state.
import { Hono } from 'hono';
import { getAuth, requireAuth, requireMembership, listMemberIds } from '../lib/auth';
import { badRequest, notFound } from '../lib/errors';
import { callEndSchema } from '../lib/schemas';
import { publishToMembers } from '../lib/publish';

export const callRoutes = new Hono<{ Bindings: Env }>();

callRoutes.use('*', requireAuth);

const RING_TIMEOUT_MS = 60_000;

async function callState(env: Env, callId: string) {
  const call = await env.DB.prepare('SELECT * FROM calls WHERE id = ?1').bind(callId).first();
  if (!call) throw notFound('CALL_NOT_FOUND', 'Call not found');
  return call;
}

/** Sweep stale ringing calls to "missed" + insert a system message. */
async function sweepMissedCalls(env: Env): Promise<void> {
  const stale = await env.DB.prepare(
    `SELECT * FROM calls WHERE status = 'ringing' AND created_at < ?1 LIMIT 10`,
  )
    .bind(Date.now() - RING_TIMEOUT_MS)
    .all();
  for (const call of stale.results ?? []) {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(`UPDATE calls SET status = 'missed', ended_at = ?1, end_reason = 'timeout' WHERE id = ?2`)
        .bind(now, call.id),
      env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_id, type, body, created_at)
         VALUES (?1, ?2, NULL, 'call', ?3, ?4)`,
      ).bind(crypto.randomUUID(), call.conversation_id, JSON.stringify({ call_state: 'missed', call_id: call.id }), now),
      env.DB.prepare(`UPDATE conversations SET last_message_at = ?1 WHERE id = ?2`).bind(now, call.conversation_id),
    ]);
    const memberIds = await listMemberIds(env.DB, call.conversation_id as string);
    await publishToMembers(env, call.conversation_id as string, memberIds, {
      t: 'call.ended',
      call_id: call.id,
      status: 'missed',
    });
  }
}

// ICE/TURN configuration (TURN credentials stay server-side and are only
// delivered over authenticated HTTPS; they are short-lived when a provider is configured).
callRoutes.get('/ice-servers', async (c) => {
  const iceServers: Array<{ urls: string[]; username?: string; credential?: string }> = (c.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((urls) => ({ urls: [urls] }));
  if (c.env.TURN_URLS && c.env.TURN_USERNAME && c.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: c.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
      username: c.env.TURN_USERNAME,
      credential: c.env.TURN_CREDENTIAL,
    });
  }
  return c.json({ ice_servers: iceServers, ttl_seconds: 3600 });
});

callRoutes.post('/', async (c) => {
  let body: { conversation_id?: string; kind?: string };
  try {
    body = (await c.req.json()) as { conversation_id?: string; kind?: string };
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const convId = String(body.conversation_id ?? '');
  if (!convId) throw badRequest('VALIDATION_ERROR', 'conversation_id required');
  const me = getAuth(c).userId;
  await requireMembership(c.env.DB, me, convId);

  // A conversation can only have one live call
  const live = await c.env.DB.prepare(
    `SELECT id FROM calls WHERE conversation_id = ?1 AND status IN ('ringing','active') LIMIT 1`,
  )
    .bind(convId)
    .first();
  if (live) throw badRequest('CALL_IN_PROGRESS', 'A call is already active in this conversation');

  await sweepMissedCalls(c.env);

  const now = Date.now();
  const callId = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO calls (id, conversation_id, initiator_id, kind, status, created_at) VALUES (?1, ?2, ?3, ?4, 'ringing', ?5)`,
    ).bind(callId, convId, me, body.kind === 'video' ? 'video' : 'audio', now),
    c.env.DB.prepare(`INSERT INTO call_participants (call_id, user_id, state, joined_at) VALUES (?1, ?2, 'active', ?3)`).bind(
      callId,
      me,
      now,
    ),
  ]);

  const memberIds = await listMemberIds(c.env.DB, convId);
  const initiator = await c.env.DB.prepare('SELECT id, username, display_name FROM users WHERE id = ?1').bind(me).first();
  await publishToMembers(c.env, convId, memberIds, {
    t: 'call.ringing',
    call_id: callId,
    conversation_id: convId,
    initiator: initiator ?? null,
    kind: body.kind === 'video' ? 'video' : 'audio',
  }, me);

  return c.json({ call: { id: callId, status: 'ringing', created_at: now, conversation_id: convId } }, 201);
});

callRoutes.post('/:id/accept', async (c) => {
  const callId = c.req.param('id');
  const me = getAuth(c).userId;
  const call = await callState(c.env, callId);
  await requireMembership(c.env.DB, me, call.conversation_id as string);

  if (call.status !== 'ringing') throw badRequest('NOT_RINGING', `Call is ${call.status}`);
  if (Date.now() - (call.created_at as number) > RING_TIMEOUT_MS) {
    throw badRequest('CALL_EXPIRED', 'Call already timed out');
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE calls SET status = 'active', answered_at = ?1 WHERE id = ?2`).bind(now, callId),
    c.env.DB.prepare(`UPDATE call_participants SET state = 'active', joined_at = ?1 WHERE call_id = ?2 AND user_id = ?3`)
      .bind(now, callId, me),
  ]);
  await publishToMembers(c.env, call.conversation_id as string, await listMemberIds(c.env.DB, call.conversation_id as string), {
    t: 'call.accepted',
    call_id: callId,
    user_id: me,
  });
  return c.json({ ok: true, status: 'active', answered_at: now });
});

callRoutes.post('/:id/reject', async (c) => {
  const callId = c.req.param('id');
  const me = getAuth(c).userId;
  const call = await callState(c.env, callId);
  await requireMembership(c.env.DB, me, call.conversation_id as string);
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE call_participants SET state = 'declined', left_at = ?1 WHERE call_id = ?2 AND user_id = ?3`)
    .bind(now, callId, me)
    .run();
  // if nobody else may answer (private call), end it as rejected
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ?1 AND state IN ('invited','ringing','active')`,
  )
    .bind(callId)
    .first<{ n: number }>();
  if ((remaining?.n ?? 0) === 0) {
    await c.env.DB.prepare(`UPDATE calls SET status = 'rejected', ended_at = ?1, end_reason = 'decline' WHERE id = ?2`)
      .bind(now, callId)
      .run();
  }
  await publishToMembers(c.env, call.conversation_id as string, await listMemberIds(c.env.DB, call.conversation_id as string), {
    t: 'call.rejected',
    call_id: callId,
    user_id: me,
  }, me);
  return c.json({ ok: true });
});

callRoutes.post('/:id/end', async (c) => {
  const callId = c.req.param('id');
  const me = getAuth(c).userId;
  const call = await callState(c.env, callId);
  await requireMembership(c.env.DB, me, call.conversation_id as string);

  let body: { reason?: string };
  try {
    body = (await c.req.json()) as { reason?: string };
  } catch {
    body = {};
  }
  const parsed = callEndSchema.safeParse(body);
  const reason = parsed.success ? parsed.data.reason : 'hangup';
  const now = Date.now();

  const wasStatus = call.status as string;
  const finalStatus = wasStatus === 'ringing' ? 'missed' : 'ended';
  const duration = call.answered_at ? Math.max(0, now - (call.answered_at as number)) : 0;
  const sysMsgId = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE calls SET status = ?1, ended_at = ?2, end_reason = ?3 WHERE id = ?4`)
      .bind(finalStatus, now, reason, callId),
    c.env.DB.prepare(`UPDATE call_participants SET state = 'left', left_at = ?1 WHERE call_id = ?2 AND user_id = ?3`)
      .bind(now, callId, me),
    c.env.DB.prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, type, body, created_at) VALUES (?1, ?2, NULL, 'call', ?3, ?4)`,
    ).bind(
      sysMsgId,
      call.conversation_id,
      JSON.stringify({ call_state: finalStatus, call_id: callId, duration_ms: duration, kind: call.kind }),
      now,
    ),
    c.env.DB.prepare(`UPDATE conversations SET last_message_id = ?1, last_message_at = ?2 WHERE id = ?3`)
      .bind(sysMsgId, now, call.conversation_id),
  ]);

  const memberIds = await listMemberIds(c.env.DB, call.conversation_id as string);
  await publishToMembers(c.env, call.conversation_id as string, memberIds, {
    t: 'call.ended',
    call_id: callId,
    status: finalStatus,
    duration_ms: duration,
    ended_by: me,
  });

  if (finalStatus === 'missed') {
    const initiatorId = call.initiator_id as string;
    const others = memberIds.filter((id) => id !== initiatorId);
    if (others.length > 0) {
      await import('../lib/push').then((m) =>
        m.sendPushToUsers(c.env, c.env.DB, others, {
          title: 'Missed call',
          body: 'You missed a voice call',
          kind: 'call_missed',
          conversationId: call.conversation_id as string,
          callId,
        }),
      );
    }
  }
  return c.json({ ok: true, status: finalStatus, duration_ms: duration });
});

callRoutes.get('/:id', async (c) => {
  const callId = c.req.param('id');
  const call = await callState(c.env, callId);
  await requireMembership(c.env.DB, getAuth(c).userId, call.conversation_id as string);
  const participants = await c.env.DB.prepare(
    `SELECT cp.*, u.username, u.display_name FROM call_participants cp JOIN users u ON u.id = cp.user_id WHERE cp.call_id = ?1`,
  )
    .bind(callId)
    .all();
  return c.json({ call, participants: participants.results ?? [] });
});
