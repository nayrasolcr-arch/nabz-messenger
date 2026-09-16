// Shared test helpers. Every helper talks to the real worker via SELF.
import { SELF } from 'cloudflare:test';

export const API = 'https://example.com/api/v1';

export interface TestUser {
  username: string;
  userId: string;
  token: string;
  refreshToken: string;
  deviceUid: string;
}

let counter = 0;
export function uniqueName(base: string): string {
  counter += 1;
  return `${base}${Date.now().toString(36)}${counter}`.toLowerCase();
}

export async function loginUser(username: string, password: string, deviceUid?: string): Promise<TestUser> {
  const uid = deviceUid ?? `device-${username}-${Date.now()}`;
  const login = await SELF.fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, device_uid: uid, device_platform: 'android' }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const data = (await login.json()) as { access_token: string; refresh_token: string; user: { id: string } };
  return { username, userId: data.user.id, token: data.access_token, refreshToken: data.refresh_token, deviceUid: uid };
}

export async function registerAndLogin(username: string, password = 'correct-horse-battery'): Promise<TestUser> {
  const reg = await SELF.fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, display_name: `User ${username}` }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const { user } = (await reg.json()) as { user: { id: string } };

  const deviceUid = `device-${username}-${Date.now()}`;
  const login = await SELF.fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, device_uid: deviceUid, device_platform: 'android' }),
  });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const data = (await login.json()) as { access_token: string; refresh_token: string; user: { id: string } };
  return { username, userId: data.user.id, token: data.access_token, refreshToken: data.refresh_token, deviceUid };
}

export async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return SELF.fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function createPrivateConversation(a: TestUser, b: TestUser): Promise<string> {
  const res = await api(a.token, 'POST', '/conversations', { type: 'private', member_ids: [b.userId] });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create conv failed: ${res.status}`);
  const data = (await res.json()) as { conversation_id: string };
  return data.conversation_id;
}

export async function createGroup(a: TestUser, title: string, members: TestUser[]): Promise<string> {
  const res = await api(a.token, 'POST', '/conversations', {
    type: 'group',
    title,
    member_ids: members.map((m) => m.userId),
  });
  if (res.status !== 201) throw new Error(`create group failed: ${res.status}`);
  const data = (await res.json()) as { conversation_id: string };
  return data.conversation_id;
}

export async function sendText(token: string, conversationId: string, body: string, replyTo?: string): Promise<{ message: { id: string } }> {
  const res = await api(token, 'POST', `/conversations/${conversationId}/messages`, {
    type: 'text',
    body,
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
  });
  if (res.status !== 201) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { message: { id: string } };
}

export async function uploadVoice(
  token: string,
  conversationId: string,
  bytes: Uint8Array,
  durationMs = 4200,
): Promise<{ attachment: { id: string } }> {
  const form = new FormData();
  form.append('file', new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  form.append('kind', 'voice');
  form.append('duration_ms', String(durationMs));
  form.append('waveform', JSON.stringify([5, 30, 90, 150, 200, 120, 60, 20]));
  form.append('conversation_id', conversationId);
  const res = await SELF.fetch(`${API}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { attachment: { id: string } };
}

/** Wait until a websocket delivers a message matching predicate. */
export function nextMatching(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('websocket wait timeout'));
    }, timeoutMs);
    const onMsg = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (predicate(data)) {
        clearTimeout(timer);
        ws.removeEventListener('message', onMsg);
        resolve(data);
      }
    };
    ws.addEventListener('message', onMsg);
  });
}

export function openAuthedSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws connect timeout')), 8000);
    let res: Response;
    SELF.fetch('https://example.com/ws', { headers: { upgrade: 'websocket' } })
      .then((r) => {
        res = r;
        const ws = res.webSocket!;
        const onMsg = (ev: MessageEvent) => {
          const data = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (data.t === 'ready') {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            resolve(ws);
          }
        };
        ws.addEventListener('message', onMsg);
        ws.accept();
        // send auth immediately; no need to wait for the open event in workerd
        ws.send(JSON.stringify({ t: 'auth', token }));
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
