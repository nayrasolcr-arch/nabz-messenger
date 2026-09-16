// Auth lifecycle tests: register, login, refresh rotation, logout, logout-all.
import { describe, expect, it } from 'vitest';
import { API, api, loginUser, registerAndLogin, uniqueName } from './helpers';
import { SELF } from 'cloudflare:test';

describe('authentication', () => {
  it('registers a user and logs in', async () => {
    const username = uniqueName('alice');
    const user = await registerAndLogin(username);
    expect(user.token).toBeTruthy();
    expect(user.userId).toBeTruthy();

    const me = await api(user.token, 'GET', '/users/me');
    expect(me.status).toBe(200);
    const data = (await me.json()) as { user: { username: string } };
    expect(data.user.username).toBe(username);
  });

  it('rejects duplicate usernames', async () => {
    const username = uniqueName('dupe');
    await registerAndLogin(username);
    const res = await SELF.fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'another-pass-123', display_name: 'X' }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects invalid usernames and short passwords', async () => {
    const res1 = await SELF.fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'AB', password: 'long-enough-pass', display_name: 'X' }),
    });
    expect(res1.status).toBe(400);

    const res2 = await SELF.fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: uniqueName('ok'), password: 'short', display_name: 'X' }),
    });
    expect(res2.status).toBe(400);
  });

  it('rejects wrong password and unknown user with the same error', async () => {
    const username = uniqueName('pwuser');
    await registerAndLogin(username);

    const wrong = await SELF.fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong-password-1', device_uid: 'device-xyz-wrong' }),
    });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('BAD_CREDENTIALS');

    const unknown = await SELF.fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: uniqueName('nouser'), password: 'wrong-password-1', device_uid: 'device-xyz-wrong' }),
    });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('BAD_CREDENTIALS');
  });

  it('rate limits repeated failed logins per username', async () => {
    const username = uniqueName('rluser');
    await registerAndLogin(username);
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: `bad-pass-${i}`, device_uid: 'device-rl-test-01' }),
      });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('refresh rotates tokens and invalidates the old pair', async () => {
    const user = await registerAndLogin(uniqueName('rot'));

    const r1 = await SELF.fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: user.refreshToken }),
    });
    expect(r1.status).toBe(200);
    const data1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(data1.access_token).not.toBe(user.token);

    // old access token is now invalid (its token_hash was replaced)
    const oldAccess = await api(user.token, 'GET', '/users/me');
    expect(oldAccess.status).toBe(401);

    // reusing the OLD refresh token must revoke the whole session family
    const reuse = await SELF.fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: user.refreshToken }),
    });
    expect(reuse.status).toBe(401);

    // and the NEW pair must be dead too (family revoked)
    const stolen = await SELF.fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: data1.refresh_token }),
    });
    expect(stolen.status).toBe(401);
    const withStolenAccess = await api(data1.access_token, 'GET', '/users/me');
    expect(withStolenAccess.status).toBe(401);
  });

  it('logout revokes the current session only', async () => {
    const user = await registerAndLogin(uniqueName('out'));
    const logout = await api(user.token, 'POST', '/auth/logout');
    expect(logout.status).toBe(200);
    const me = await api(user.token, 'GET', '/users/me');
    expect(me.status).toBe(401);
  });

  it('logout-all revokes every session of the user', async () => {
    const username = uniqueName('all');
    const u1 = await registerAndLogin(username, 'same-password-123');
    const u2 = await loginUser(username, 'same-password-123'); // same user, new session
    const logoutAll = await api(u1.token, 'POST', '/auth/logout-all');
    expect(logoutAll.status).toBe(200);
    expect((await api(u1.token, 'GET', '/users/me')).status).toBe(401);
    expect((await api(u2.token, 'GET', '/users/me')).status).toBe(401);
  });

  it('rejects expired access tokens', async () => {
    const user = await registerAndLogin(uniqueName('exp'));
    // force-expire all sessions directly in D1
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { env } = await import('cloudflare:test');
    await (env as { DB: { prepare(q: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } } }).DB
      .prepare('UPDATE sessions SET expires_at = ?1 WHERE user_id = ?2')
      .bind(Date.now() - 1000, user.userId)
      .run();
    const me = await api(user.token, 'GET', '/users/me');
    expect(me.status).toBe(401);
    const data = (await me.json()) as { error: { code: string } };
    expect(data.error.code).toBe('TOKEN_EXPIRED');
  });
});
