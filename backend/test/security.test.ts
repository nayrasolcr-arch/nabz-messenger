// Security tests: unauthorized access, IDOR, invalid sessions, malformed payloads.
import { describe, expect, it } from 'vitest';
import { API, api, createPrivateConversation, createGroup, registerAndLogin, sendText, uniqueName } from './helpers';
import { SELF } from 'cloudflare:test';

describe('security & authorization', () => {
  it('blocks unauthenticated access to protected endpoints', async () => {
    const res = await SELF.fetch(`${API}/users/me`);
    expect(res.status).toBe(401);

    const noHeader = await SELF.fetch(`${API}/conversations`, { method: 'POST', body: '{}' });
    expect(noHeader.status).toBe(401);
  });

  it('rejects invalid and malformed bearer tokens', async () => {
    const invalid = await SELF.fetch(`${API}/users/me`, {
      headers: { authorization: 'Bearer totally-invalid-token' },
    });
    expect(invalid.status).toBe(401);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('INVALID_SESSION');

    const malformed = await SELF.fetch(`${API}/users/me`, {
      headers: { authorization: 'Token abc' },
    });
    expect(malformed.status).toBe(401);
  });

  it('prevents IDOR: users cannot read or write other conversations', async () => {
    const a = await registerAndLogin(uniqueName('ia'));
    const b = await registerAndLogin(uniqueName('ib'));
    const eve = await registerAndLogin(uniqueName('ie'));
    const conv = await createPrivateConversation(a, b);

    const read = await api(eve.token, 'GET', `/conversations/${conv}/messages`);
    expect(read.status).toBe(403);

    const write = await api(eve.token, 'POST', `/conversations/${conv}/messages`, { type: 'text', body: 'intrusion' });
    expect(write.status).toBe(403);

    const readConv = await api(eve.token, 'GET', `/conversations/${conv}`);
    expect(readConv.status).toBe(403);

    const readState = await api(eve.token, 'POST', `/conversations/${conv}/read`, { message_id: 'whatever' });
    expect(readState.status).toBe(403);

    const convList = await api(eve.token, 'GET', '/conversations');
    const ids = ((await convList.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).not.toContain(conv);
  });

  it('rejects malformed JSON bodies with 400 (never 500)', async () => {
    const user = await registerAndLogin(uniqueName('mj'));
    const res = await SELF.fetch(`${API}/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: { code: string } };
    expect(data.error.code).toBe('INVALID_JSON');
  });

  it('rejects invalid conversation creation payloads', async () => {
    const user = await registerAndLogin(uniqueName('ic'));
    // private with 2 others
    const other1 = await registerAndLogin(uniqueName('ic2'));
    const other2 = await registerAndLogin(uniqueName('ic3'));
    const bad = await api(user.token, 'POST', '/conversations', {
      type: 'private',
      member_ids: [other1.userId, other2.userId],
    });
    expect(bad.status).toBe(400);

    // group without title
    const noTitle = await api(user.token, 'POST', '/conversations', { type: 'group', member_ids: [other1.userId] });
    expect(noTitle.status).toBe(400);

    // nonexistent member
    const ghost = await api(user.token, 'POST', '/conversations', {
      type: 'private',
      member_ids: ['nonexistent-user-id'],
    });
    expect(ghost.status).toBe(404);
  });

  it('only the owner can delete a group; members cannot', async () => {
    const owner = await registerAndLogin(uniqueName('go'));
    const member = await registerAndLogin(uniqueName('gm'));
    const group = await createGroup(owner, 'delete-test', [member]);
    const del = await api(member.token, 'DELETE', `/conversations/${group}`);
    expect(del.status).toBe(403);
    const delOwner = await api(owner.token, 'DELETE', `/conversations/${group}`);
    expect(delOwner.status).toBe(200);
  });

  it('responds 404 for unknown API endpoints and 200 for health', async () => {
    const user = await registerAndLogin(uniqueName('nf'));
    const res = await api(user.token, 'GET', '/does-not-exist');
    expect(res.status).toBe(404);

    const health = await SELF.fetch('https://example.com/health');
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('never exposes password hashes or token material in responses', async () => {
    const user = await registerAndLogin(uniqueName('leak'));
    const me = await api(user.token, 'GET', '/users/me');
    const text = JSON.stringify(await me.json());
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain(user.token);
  });
});
