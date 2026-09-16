// Nabz backend entrypoint.
// - /api/v1/*  : versioned HTTPS API (Hono)
// - /ws        : realtime WebSocket (forwarded to RealtimeHub DO)
// - /health    : public smoke-test endpoint for CI

import { Hono } from 'hono';
import { ApiError } from './lib/errors';
import { requireAuth } from './lib/auth';
import { authRoutes, authProtectedRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { conversationRoutes } from './routes/conversations';
import { messageRoutes } from './routes/messages';
import { attachmentRoutes } from './routes/attachments';
import { callRoutes } from './routes/calls';
import { searchRoutes } from './routes/search';
import { aiRoutes } from './routes/ai';
import { pushRoutes } from './routes/push';

const app = new Hono<{ Bindings: Env }>();

// Security headers on every response
app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('x-frame-options', 'DENY');
  c.header('referrer-policy', 'no-referrer');
  c.header('cache-control', 'no-store');
});

app.get('/health', async (c) => {
  let db = 'down';
  try {
    await c.env.DB.prepare('SELECT 1').first();
    db = 'ok';
  } catch {
    db = 'down';
  }
  return c.json({ ok: true, service: 'nabz-backend', version: '1.0.0', time: new Date().toISOString(), db });
});

const publicApi = new Hono<{ Bindings: Env }>();
publicApi.route('/auth', authRoutes);

const protectedApi = new Hono<{ Bindings: Env }>();
protectedApi.use('*', requireAuth);
protectedApi.route('/auth', authProtectedRoutes);
protectedApi.route('/users', userRoutes);
protectedApi.route('/conversations', conversationRoutes);
protectedApi.route('/calls', callRoutes);
protectedApi.route('/search', searchRoutes);
protectedApi.route('/ai', aiRoutes);
protectedApi.route('/push', pushRoutes);
// messages/attachments register their own protected sub-paths
protectedApi.route('/', messageRoutes);
protectedApi.route('/', attachmentRoutes);

app.route('/api/v1', publicApi);
app.use('/api/v1/*', requireAuth);
app.route('/api/v1', protectedApi);

// 404 + error envelope
app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404));
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details ?? undefined } }, err.status as 400);
  }
  console.error('unhandled error:', err instanceof Error ? err.message : err);
  return c.json({ error: { code: 'INTERNAL', message: 'Internal server error' } }, 500);
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const id = env.REALTIME_HUB.idFromName('global');
      return env.REALTIME_HUB.get(id).fetch(request);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

export { RealtimeHub } from './durable/RealtimeHub';
export { RateLimiter } from './durable/RateLimiter';
