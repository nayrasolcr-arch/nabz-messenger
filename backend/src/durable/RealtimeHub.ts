// RealtimeHub: a single Durable Object (SQLite-backed, free-tier compatible) that:
//  - terminates one authenticated WebSocket per client (hibernation API => near-zero
//    duration billing when idle; auto ping/pong keepalive)
//  - tracks presence for the whole deployment (fine for <= 20-50 users)
//  - fans out conversation events published by REST handlers
//  - routes WebRTC signaling messages for voice calls
//
// Lifecycle: connect -> auth (first message, 10s timeout alarm) -> ready/subscribe
//            -> heartbeat (WS auto ping/pong) -> reconnect (client side) -> disconnect

import { loadSessionByToken } from '../lib/auth';

interface SocketMeta {
  userId: string;
  username: string;
  conversations: string[];
  authenticated: boolean;
}

interface PublishBody {
  conversationId: string;
  memberIds: string[];
  event: Record<string, unknown>;
  excludeUserId?: string;
}

const AUTH_TIMEOUT_MS = 10_000;

export class RealtimeHub implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/publish') {
      const body = (await request.json()) as PublishBody;
      this.fanoutToConversation(body);
      return new Response('ok');
    }

    if (url.pathname === '/broadcast') {
      const body = (await request.json()) as { event: Record<string, unknown> };
      this.broadcast(body.event);
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    // WebSocket upgrade
    const pair = new WebSocketPair();
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong'),
    );
    this.state.acceptWebSocket(pair[1]);
    // Alarm API guards: some local/test runtimes do not expose state.setAlarm.
    const alarmState = this.state as unknown as { setAlarm?: (t: number) => void };
    alarmState.setAlarm?.(Date.now() + AUTH_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private meta(ws: WebSocket): SocketMeta | null {
    return (ws.deserializeAttachment() as SocketMeta | null) ?? null;
  }

  private send(ws: WebSocket, event: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // socket died mid-send; close handler will clean up
    }
  }

  private broadcast(event: Record<string, unknown>, excludeUserId?: string): void {
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (!m || !m.authenticated) continue;
      if (excludeUserId && m.userId === excludeUserId) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private fanoutToConversation(body: PublishBody): void {
    const payload = JSON.stringify(body.event);
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (!m || !m.authenticated) continue;
      if (body.excludeUserId && m.userId === body.excludeUserId) continue;
      if (!m.conversations.includes(body.conversationId)) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  /** Fan out to sockets that subscribed to a conversation (client-originated events like typing). */
  private fanoutByConversation(conversationId: string, event: Record<string, unknown>, excludeUserId?: string): void {
    const payload = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (!m || !m.authenticated) continue;
      if (excludeUserId && m.userId === excludeUserId) continue;
      if (!m.conversations.includes(conversationId)) continue;
      try {
        ws.send(payload);
      } catch {
        /* ignore */
      }
    }
  }

  private async onlineUserIds(): Promise<string[]> {
    const ids: string[] = [];
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (m && m.authenticated) ids.push(m.userId);
    }
    return [...new Set(ids)];
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let data: Record<string, unknown>;
    try {
      if (typeof message !== 'string') throw new Error('binary not supported');
      data = JSON.parse(message) as Record<string, unknown>;
    } catch {
      this.send(ws, { t: 'error', code: 'BAD_PAYLOAD', message: 'invalid JSON' });
      return;
    }

    const meta = this.meta(ws);

    if (!meta || !meta.authenticated) {
      if (data.t !== 'auth' || typeof data.token !== 'string') {
        ws.close(4001, 'auth required');
        return;
      }
      const found = await loadSessionByToken(this.env.DB, data.token as string);
      if (!found || found.session.expires_at < Date.now()) {
        ws.close(4001, 'invalid token');
        return;
      }
      const res = await this.env.DB.prepare(
        'SELECT conversation_id FROM conversation_members WHERE user_id = ?1',
      )
        .bind(found.user.id)
        .all<{ conversation_id: string }>();
      const next: SocketMeta = {
        userId: found.user.id,
        username: found.user.username,
        conversations: (res.results ?? []).map((r) => r.conversation_id),
        authenticated: true,
      };
      ws.serializeAttachment(next);
      (this.state as unknown as { deleteAlarm?: () => void }).deleteAlarm?.();
      this.send(ws, {
        t: 'ready',
        user_id: next.userId,
        username: next.username,
        online: (await this.onlineUserIds()).filter((id) => id !== next.userId),
      });
      this.broadcast({ t: 'presence', user_id: next.userId, username: next.username, online: true }, next.userId);
      await this.env.DB.prepare('UPDATE users SET last_seen_at = ?1 WHERE id = ?2')
        .bind(Date.now(), next.userId)
        .run();
      return;
    }

    switch (data.t) {
      case 'heartbeat': {
        this.send(ws, { t: 'pong', time: Date.now() });
        break;
      }
      case 'typing': {
        const conversationId = String(data.conversation_id ?? '');
        const state = String(data.state ?? 'typing');
        if (!conversationId || !meta.conversations.includes(conversationId)) return;
        this.fanoutByConversation(conversationId, {
          t: 'typing',
          conversation_id: conversationId,
          user_id: meta.userId,
          state,
        }, meta.userId);
        break;
      }
      case 'signal': {
        // WebRTC signaling passthrough: {t:'signal', call_id, to, data}
        const to = String(data.to ?? '');
        const callId = String(data.call_id ?? '');
        if (!to || !callId) {
          this.send(ws, { t: 'error', code: 'BAD_SIGNAL', message: 'signal requires call_id and to' });
          return;
        }
        let delivered = false;
        const payload = JSON.stringify({
          t: 'signal',
          call_id: callId,
          from: meta.userId,
          data: data.data ?? {},
        });
        for (const other of this.state.getWebSockets()) {
          const om = this.meta(other);
          if (om && om.authenticated && om.userId === to) {
            try {
              other.send(payload);
              delivered = true;
            } catch {
              /* ignore */
            }
          }
        }
        if (!delivered) {
          this.send(ws, { t: 'error', code: 'PEER_OFFLINE', message: 'peer is not connected', call_id: callId });
        }
        break;
      }
      default:
        this.send(ws, { t: 'error', code: 'UNKNOWN_TYPE', message: `unknown message type: ${String(data.t)}` });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const meta = this.meta(ws);
    if (meta && meta.authenticated) {
      const stillOnline = (await this.onlineUserIds()).includes(meta.userId);
      if (!stillOnline) {
        this.broadcast({ t: 'presence', user_id: meta.userId, username: meta.username, online: false });
        try {
          await this.env.DB.prepare('UPDATE users SET last_seen_at = ?1 WHERE id = ?2')
            .bind(Date.now(), meta.userId)
            .run();
        } catch {
          /* best effort */
        }
      }
    }
  }

  async alarm(): Promise<void> {
    // Close sockets that never authenticated within the timeout.
    for (const ws of this.state.getWebSockets()) {
      const m = this.meta(ws);
      if (!m || !m.authenticated) {
        try {
          ws.close(4001, 'auth timeout');
        } catch {
          /* ignore */
        }
      }
    }
  }
}
