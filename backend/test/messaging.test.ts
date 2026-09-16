// Messaging tests: conversations, send/receive, edit, delete, reply, reactions,
// read receipts, pins, typing, voice messages (upload/download), search.
import { describe, expect, it } from 'vitest';
import {
  api,
  createGroup,
  createPrivateConversation,
  registerAndLogin,
  sendText,
  uniqueName,
  uploadVoice,
} from './helpers';

describe('messaging', () => {
  it('creates a private conversation once (dedupe) and a group', async () => {
    const a = await registerAndLogin(uniqueName('mha'));
    const b = await registerAndLogin(uniqueName('mhb'));

    const conv1 = await createPrivateConversation(a, b);
    const conv2 = await createPrivateConversation(b, a);
    expect(conv1).toBe(conv2);

    const group = await createGroup(a, `${uniqueName('team')}`, [b]);
    expect(group).toBeTruthy();
    expect(group).not.toBe(conv1);
  });

  it('sends, lists, edits and deletes messages', async () => {
    const a = await registerAndLogin(uniqueName('sa'));
    const b = await registerAndLogin(uniqueName('sb'));
    const conv = await createPrivateConversation(a, b);

    const m1 = await sendText(a.token, conv, 'hello world');
    expect(m1.message.id).toBeTruthy();
    const m2 = await sendText(b.token, conv, 'hi there', m1.message.id);
    expect(m2.message.id).toBeTruthy();

    const list = await api(a.token, 'GET', `/conversations/${conv}/messages`);
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Array<{ id: string; reply_to?: { id: string } | null }> }).items;
    expect(items.length).toBe(2);
    const reply = items.find((i) => i.id === m2.message.id);
    expect(reply?.reply_to?.id).toBe(m1.message.id);

    const edit = await api(a.token, 'PATCH', `/messages/${m1.message.id}`, { body: 'hello edited' });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { message: { body: string } }).message.body).toBe('hello edited');

    // editing someone else's message is forbidden
    const editOther = await api(b.token, 'PATCH', `/messages/${m1.message.id}`, { body: 'hack' });
    expect(editOther.status).toBe(403);

    const del = await api(a.token, 'DELETE', `/messages/${m1.message.id}`);
    expect(del.status).toBe(200);
    const afterDelete = await api(a.token, 'GET', `/conversations/${conv}/messages`);
    const remaining = ((await afterDelete.json()) as { items: Array<{ id: string }> }).items;
    expect(remaining.find((i) => i.id === m1.message.id)).toBeUndefined();
  });

  it('rejects empty text messages and bad reply targets', async () => {
    const a = await registerAndLogin(uniqueName('va'));
    const b = await registerAndLogin(uniqueName('vb'));
    const conv = await createPrivateConversation(a, b);
    const otherConv = await createPrivateConversation(a, b); // dedupe returns same conv, so make group instead
    expect(otherConv).toBe(conv);

    const empty = await api(a.token, 'POST', `/conversations/${conv}/messages`, { type: 'text', body: '   ' });
    expect(empty.status).toBe(400);

    const badReply = await api(a.token, 'POST', `/conversations/${conv}/messages`, {
      type: 'text',
      body: 'x',
      reply_to_message_id: 'nonexistent-id',
    });
    expect(badReply.status).toBe(400);
  });

  it('toggles reactions and tracks read receipts + unread counts', async () => {
    const a = await registerAndLogin(uniqueName('ra'));
    const b = await registerAndLogin(uniqueName('rb'));
    const conv = await createPrivateConversation(a, b);
    const msg = await sendText(a.token, conv, 'react to me');

    const add = await api(b.token, 'PUT', `/messages/${msg.message.id}/reactions`, { emoji: '👍' });
    expect(add.status).toBe(200);
    expect(((await add.json()) as { action: string }).action).toBe('added');

    const remove = await api(b.token, 'PUT', `/messages/${msg.message.id}/reactions`, { emoji: '👍' });
    expect(((await remove.json()) as { action: string }).action).toBe('removed');

    // b has unread messages (sent by a) until it reads them
    const convsBefore = await api(b.token, 'GET', '/conversations');
    const convBefore = ((await convsBefore.json()) as { items: Array<{ id: string; unread_count: number }> }).items.find(
      (c) => c.id === conv,
    );
    expect(convBefore?.unread_count).toBe(1);

    const read = await api(b.token, 'POST', `/conversations/${conv}/read`, { message_id: msg.message.id });
    expect(read.status).toBe(200);

    const convsAfter = await api(b.token, 'GET', '/conversations');
    const convAfter = ((await convsAfter.json()) as { items: Array<{ id: string; unread_count: number }> }).items.find(
      (c) => c.id === conv,
    );
    expect(convAfter?.unread_count).toBe(0);
  });

  it('pins messages (owner can, plain member cannot) and unpins', async () => {
    const owner = await registerAndLogin(uniqueName('po'));
    const member = await registerAndLogin(uniqueName('pm'));
    const group = await createGroup(owner, 'pin-group', [member]);

    const msgOwner = await sendText(owner.token, group, 'important');
    const pinByMember = await api(member.token, 'POST', `/messages/${msgOwner.message.id}/pin`);
    expect(pinByMember.status).toBe(403);

    const pin = await api(owner.token, 'POST', `/messages/${msgOwner.message.id}/pin`);
    expect(pin.status).toBe(200);

    const pinned = await api(owner.token, 'GET', `/conversations/${group}/pinned`);
    const items = ((await pinned.json()) as { items: Array<{ id: string }> }).items;
    expect(items.some((i) => i.id === msgOwner.message.id)).toBe(true);

    const unpin = await api(owner.token, 'DELETE', `/messages/${msgOwner.message.id}/pin`);
    expect(unpin.status).toBe(200);
  });

  it('sends typing indicator (REST path)', async () => {
    const a = await registerAndLogin(uniqueName('ta'));
    const b = await registerAndLogin(uniqueName('tb'));
    const conv = await createPrivateConversation(a, b);
    const res = await api(a.token, 'POST', `/conversations/${conv}/typing`, { state: 'typing' });
    expect(res.status).toBe(200);
  });

  it('uploads and downloads voice messages through the storage abstraction', async () => {
    const a = await registerAndLogin(uniqueName('voiceA'));
    const b = await registerAndLogin(uniqueName('voiceB'));
    const conv = await createPrivateConversation(a, b);

    const audioBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4, 5, 6, 7, 8]);
    const up = await uploadVoice(a.token, conv, audioBytes, 5_000);
    expect(up.attachment.id).toBeTruthy();

    const send = await api(a.token, 'POST', `/conversations/${conv}/messages`, {
      type: 'voice',
      attachment_id: up.attachment.id,
    });
    expect(send.status).toBe(201);

    const list = await api(b.token, 'GET', `/conversations/${conv}/messages`);
    const items = ((await list.json()) as { items: Array<{ type: string; attachment: { id: string; kind: string; waveform: number[] } | null }> }).items;
    const voice = items.find((i) => i.type === 'voice');
    expect(voice?.attachment?.kind).toBe('voice');
    expect(voice?.attachment?.waveform?.length).toBe(8);

    // member can download
    const dl = await api(b.token, 'GET', `/attachments/${up.attachment.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('audio/ogg');
    const got = new Uint8Array(await dl.arrayBuffer());
    expect([...got]).toEqual([...audioBytes]);

    // non-member cannot download (IDOR)
    const eve = await registerAndLogin(uniqueName('voiceEve'));
    const forbidden = await api(eve.token, 'GET', `/attachments/${up.attachment.id}`);
    expect(forbidden.status).toBe(403);
  });

  it('searches messages across own conversations', async () => {
    const a = await registerAndLogin(uniqueName('sea'));
    const b = await registerAndLogin(uniqueName('seb'));
    const conv = await createPrivateConversation(a, b);
    const marker = uniqueName('zanzibar');
    await sendText(a.token, conv, `the secret word is ${marker} today`);

    const res = await api(a.token, 'GET', `/search?q=${encodeURIComponent(marker)}`);
    expect(res.status).toBe(200);
    const items = (await res.json()) as { items: Array<{ body: string }> };
    expect(items.items.some((i) => i.body.includes(marker))).toBe(true);

    // user b cannot find messages of conversations they are not in
    const eve = await registerAndLogin(uniqueName('sece'));
    const resEve = await api(eve.token, 'GET', `/search?q=${encodeURIComponent(marker)}`);
    const itemsEve = (await resEve.json()) as { items: unknown[] };
    expect(itemsEve.items.length).toBe(0);
  });
});
