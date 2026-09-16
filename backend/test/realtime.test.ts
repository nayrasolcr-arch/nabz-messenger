// Realtime + AI + Call tests.
import { describe, expect, it } from 'vitest';
import {
  api,
  createPrivateConversation,
  nextMatching,
  openAuthedSocket,
  registerAndLogin,
  sendText,
  uniqueName,
} from './helpers';
import { SELF } from 'cloudflare:test';

describe('realtime (websocket)', () => {
  it('closes sockets that send non-auth as first message', async () => {
    const res = await SELF.fetch('https://example.com/ws', { headers: { upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    ws.send(JSON.stringify({ t: 'typing', conversation_id: 'x' }));
    const closed = await new Promise<number | null>((resolve) => {
      ws.addEventListener('close', (ev) => resolve((ev as CloseEvent).code), { once: true });
      setTimeout(() => resolve(null), 5000);
    });
    expect(closed).toBe(4001);
  });

  it('authenticates and receives message.new events fanned out from REST sends', async () => {
    const a = await registerAndLogin(uniqueName('wa'));
    const b = await registerAndLogin(uniqueName('wb'));
    const conv = await createPrivateConversation(a, b);

    const socketB = await openAuthedSocket(b.token);
    const marker = uniqueName('realtime-msg');

    const pReceived = nextMatching(socketB, (m) => m.t === 'message.new');
    await sendText(a.token, conv, `live: ${marker}`);
    const event = await pReceived;
    expect(event.conversation_id).toBe(conv);
    expect((event.message as { body: string }).body).toContain(marker);

    socketB.close();
  });

  it('responds to heartbeat with pong and shares presence', async () => {
    const a = await registerAndLogin(uniqueName('pa'));
    const b = await registerAndLogin(uniqueName('pb'));

    const socketA = await openAuthedSocket(a.token);
    const socketB = await openAuthedSocket(b.token);

    // b's connect should have broadcast presence to a
    const presence = await nextMatching(socketA, (m) => m.t === 'presence' && m.user_id === b.userId);
    expect(presence.online).toBe(true);

    socketB.send(JSON.stringify({ t: 'heartbeat' }));
    const pong = await nextMatching(socketB, (m) => m.t === 'pong');
    expect(pong.t).toBe('pong');

    socketA.close();
    socketB.close();
  });

  it('routes WebRTC signaling between two sockets', async () => {
    const a = await registerAndLogin(uniqueName('sig1'));
    const b = await registerAndLogin(uniqueName('sig2'));
    const socketA = await openAuthedSocket(a.token);
    const socketB = await openAuthedSocket(b.token);

    const pSignal = nextMatching(socketB, (m) => m.t === 'signal');
    socketA.send(
      JSON.stringify({
        t: 'signal',
        call_id: 'test-call-1',
        to: b.userId,
        data: { type: 'offer', sdp: 'v=0 fake-sdp' },
      }),
    );
    const sig = await pSignal;
    expect(sig.from).toBe(a.userId);
    expect((sig.data as { type: string }).type).toBe('offer');

    socketA.close();
    socketB.close();
  });
});

describe('voice calls (REST lifecycle + signaling)', () => {
  it('runs create -> accept -> end with duration, storing a call system message', async () => {
    const a = await registerAndLogin(uniqueName('ca'));
    const b = await registerAndLogin(uniqueName('cb'));
    const conv = await createPrivateConversation(a, b);

    const create = await api(a.token, 'POST', '/calls', { conversation_id: conv });
    expect(create.status).toBe(201);
    const call = ((await create.json()) as { call: { id: string; status: string } }).call;
    expect(call.status).toBe('ringing');

    // second concurrent call in same conversation must be refused
    const again = await api(a.token, 'POST', '/calls', { conversation_id: conv });
    expect(again.status).toBe(400);

    const accept = await api(b.token, 'POST', `/calls/${call.id}/accept`);
    expect(accept.status).toBe(200);

    const end = await api(a.token, 'POST', `/calls/${call.id}/end`, { reason: 'hangup' });
    expect(end.status).toBe(200);
    const endData = (await end.json()) as { status: string; duration_ms: number };
    expect(endData.status).toBe('ended');
    expect(endData.duration_ms).toBeGreaterThanOrEqual(0);

    const messages = await api(a.token, 'GET', `/conversations/${conv}/messages`);
    const items = (await messages.json()) as { items: Array<{ type: string; body: string | null }> };
    expect(items.items.some((m) => m.type === 'call')).toBe(true);
  });

  it('marks unanswered calls as missed', async () => {
    const a = await registerAndLogin(uniqueName('ma'));
    const b = await registerAndLogin(uniqueName('mb'));
    const conv = await createPrivateConversation(a, b);

    const create = await api(a.token, 'POST', '/calls', { conversation_id: conv });
    const call = ((await create.json()) as { call: { id: string } }).call;

    // backdate created_at beyond ring timeout, then trigger sweep via new call
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { env } = await import('cloudflare:test');
    const db = (env as { DB: { prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } } }).DB;
    await db.prepare('UPDATE calls SET created_at = ?1 WHERE id = ?2').bind(Date.now() - 120_000, call.id).run();

    const end = await api(a.token, 'POST', `/calls/${call.id}/end`, { reason: 'hangup' });
    expect(end.status).toBe(200);
    expect(((await end.json()) as { status: string }).status).toBe('missed');
  });

  it('serves ICE servers without leaking TURN credentials when unset', async () => {
    const user = await registerAndLogin(uniqueName('ice'));
    const res = await api(user.token, 'GET', '/calls/ice-servers');
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('stun:');
    expect(text).not.toContain('credential');
  });
});

describe('ai assistant', () => {
  it('chats via the mock provider, keeps history and clears it', async () => {
    const user = await registerAndLogin(uniqueName('aiu'));

    const chat = await api(user.token, 'POST', '/ai/chat', { content: 'سلام، حالت چطوره؟' });
    expect(chat.status).toBe(200);
    const data = (await chat.json()) as { reply: string };
    expect(data.reply).toContain('mock-ai');

    const history = await api(user.token, 'GET', '/ai/history');
    const items = (await history.json()) as { items: Array<{ role: string }> };
    expect(items.items.filter((m) => m.role === 'user').length).toBe(1);
    expect(items.items.filter((m) => m.role === 'assistant').length).toBe(1);

    const clear = await api(user.token, 'DELETE', '/ai/history');
    expect(clear.status).toBe(200);
    const after = (await (await api(user.token, 'GET', '/ai/history')).json()) as { items: unknown[] };
    expect(after.items.length).toBe(0);
  });

  it('rejects empty AI payloads', async () => {
    const user = await registerAndLogin(uniqueName('aie'));
    const res = await api(user.token, 'POST', '/ai/chat', { content: '' });
    expect(res.status).toBe(400);
  });

  it('push registration stores device tokens (no provider configured = noop send)', async () => {
    const user = await registerAndLogin(uniqueName('push'));
    const res = await api(user.token, 'POST', '/push/register', {
      device_uid: user.deviceUid,
      platform: 'android',
      provider: 'fcm',
      push_token: 'fcm-test-token-abcdefghijklmnop',
    });
    // 201 when creating the device entry, 200 when updating the one created at login
    expect([200, 201]).toContain(res.status);
  });
});
