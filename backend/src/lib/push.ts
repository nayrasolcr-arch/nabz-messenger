// Push notification provider abstraction.
// Default: NoopPushProvider (realtime in-app notifications always work via WS).
// FCM HTTP v1 activates automatically when FCM_SERVICE_ACCOUNT_JSON secret is set
// (free Firebase project required; see docs/SETUP.md). Credentials never leave the server.

export interface PushPayload {
  title: string;
  body: string;
  kind: 'message' | 'mention' | 'call_incoming' | 'call_missed';
  conversationId?: string;
  callId?: string;
}

export interface PushProvider {
  send(userId: string, tokens: string[], payload: PushPayload): Promise<void>;
}

class NoopPushProvider implements PushProvider {
  async send(_userId: string, _tokens: string[], _payload: PushPayload): Promise<void> {
    // push disabled: no provider credentials configured
  }
}

// --- FCM HTTP v1 (OAuth2 service account, ES256 JWT) ---

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const enc = new TextEncoder();

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'ES256', typ: 'JWT' })));
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(sa.private_key),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  const jwt = `${header}.${claims}.${b64url(new Uint8Array(sig))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error('FCM token exchange failed');
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

class FcmV1PushProvider implements PushProvider {
  constructor(private sa: ServiceAccount) {}
  async send(userId: string, tokens: string[], payload: PushPayload): Promise<void> {
    const token = await getAccessToken(this.sa);
    await Promise.allSettled(
      tokens.map(async (t) => {
        await fetch(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: t,
              notification: { title: payload.title, body: payload.body },
              data: {
                kind: payload.kind,
                conversation_id: payload.conversationId ?? '',
                call_id: payload.callId ?? '',
                user_id: userId,
              },
              android: { priority: 'high' },
            },
          }),
        });
      }),
    );
  }
}

export function getPushProvider(env: Env): PushProvider {
  if (env.FCM_SERVICE_ACCOUNT_JSON) {
    try {
      const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
      if (sa.client_email && sa.private_key && sa.project_id) return new FcmV1PushProvider(sa);
    } catch {
      // fall through to noop
    }
  }
  return new NoopPushProvider();
}

export async function sendPushToUsers(
  env: Env,
  db: D1Database,
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  const provider = getPushProvider(env);
  const placeholder = userIds.map(() => '?').join(',');
  if (!placeholder) return;
  const res = await db
    .prepare(`SELECT user_id, push_token FROM devices WHERE user_id IN (${placeholder}) AND push_token IS NOT NULL`)
    .bind(...userIds)
    .all<{ user_id: string; push_token: string }>();
  const byUser = new Map<string, string[]>();
  for (const row of res.results ?? []) {
    const arr = byUser.get(row.user_id) ?? [];
    arr.push(row.push_token);
    byUser.set(row.user_id, arr);
  }
  await Promise.allSettled(
    [...byUser.entries()].map(([uid, tokens]) => provider.send(uid, tokens, payload)),
  );
}
