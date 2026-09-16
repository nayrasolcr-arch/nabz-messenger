// AI assistant routes: dedicated AI chat per user, backed by Workers AI
// (free tier) or an OpenAI-compatible provider. Credentials stay server-side.
import { Hono } from 'hono';
import { getAuth, requireAuth } from '../lib/auth';
import { badRequest, tooMany } from '../lib/errors';
import { aiChatSchema } from '../lib/schemas';
import { generateAiReply, type ChatMessage } from '../lib/ai';
import { rateLimit } from '../lib/ratelimit';
import { intVar } from '../lib/vars';

export const aiRoutes = new Hono<{ Bindings: Env }>();

aiRoutes.use('*', requireAuth);

async function ensureAiConversation(env: Env, userId: string): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare('SELECT id FROM ai_conversations WHERE user_id = ?1').bind(userId).first();
  if (existing) return { id: existing.id as string, created: false };
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO ai_conversations (id, user_id, title, created_at) VALUES (?1, ?2, 'AI Assistant', ?3)`).bind(
      id,
      userId,
      Date.now(),
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO conversations (id, type, title, created_by, created_at)
       SELECT ?1, 'ai', 'AI Assistant', ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM conversations WHERE type = 'ai' AND created_by = ?2)`,
    ).bind(crypto.randomUUID(), userId, Date.now()),
  ]);
  return { id, created: true };
}

aiRoutes.post('/chat', async (c) => {
  const me = getAuth(c).userId;
  const rl = await rateLimit(c.env, `ai:${me}`, intVar(c.env.AI_RL_LIMIT, 20), 60_000);
  if (!rl.allowed) throw tooMany(rl.retryAfterSec);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest('INVALID_JSON', 'Body must be valid JSON');
  }
  const parsed = aiChatSchema.safeParse(body);
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', 'Invalid body', parsed.error.issues);

  if (!c.env.AI && !c.env.AI_API_KEY && c.env.AI_MOCK !== '1') {
    throw badRequest('AI_NOT_CONFIGURED', 'No AI provider is configured on the server');
  }

  const aiConv = await ensureAiConversation(c.env, me);
  const now = Date.now();
  const userMsgId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO ai_messages (id, ai_conversation_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(userMsgId, aiConv.id, 'user', parsed.data.content, now)
    .run();

  // Build compact history (last 20 turns)
  const histRows = await c.env.DB.prepare(
    `SELECT role, content FROM ai_messages WHERE ai_conversation_id = ?1 ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(aiConv.id)
    .all<{ role: 'user' | 'assistant' | 'system'; content: string }>();
  const history: ChatMessage[] = (histRows.results ?? []).reverse().map((r) => ({ role: r.role, content: r.content }));

  let reply: string;
  try {
    reply = await generateAiReply(c.env, history);
  } catch (e) {
    const msg = String((e as Error).message ?? '');
    if (msg === 'AI_NOT_CONFIGURED') throw badRequest('AI_NOT_CONFIGURED', 'No AI provider is configured on the server');
    throw badRequest('AI_PROVIDER_ERROR', 'The AI provider failed to respond');
  }

  const assistantMsgId = crypto.randomUUID();
  await c.env.DB.prepare(
    'INSERT INTO ai_messages (id, ai_conversation_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(assistantMsgId, aiConv.id, 'assistant', reply, Date.now())
    .run();

  return c.json({ reply, user_message_id: userMsgId, assistant_message_id: assistantMsgId });
});

aiRoutes.get('/history', async (c) => {
  const me = getAuth(c).userId;
  const aiConv = await c.env.DB.prepare('SELECT id FROM ai_conversations WHERE user_id = ?1').bind(me).first();
  if (!aiConv) return c.json({ items: [] });
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10) || 50, 200);
  const rows = await c.env.DB.prepare(
    `SELECT id, role, content, created_at FROM ai_messages WHERE ai_conversation_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(aiConv.id, limit)
    .all();
  return c.json({ items: (rows.results ?? []).reverse() });
});

aiRoutes.delete('/history', async (c) => {
  const me = getAuth(c).userId;
  const aiConv = await c.env.DB.prepare('SELECT id FROM ai_conversations WHERE user_id = ?1').bind(me).first();
  if (aiConv) {
    await c.env.DB.prepare('DELETE FROM ai_messages WHERE ai_conversation_id = ?1').bind(aiConv.id).run();
  }
  return c.json({ ok: true });
});
