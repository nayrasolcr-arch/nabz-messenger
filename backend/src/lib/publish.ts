// Publish realtime events to the RealtimeHub Durable Object.
// The hub fans events out to connected sockets belonging to memberIds.

export interface RealtimeEvent {
  t: string;
  [k: string]: unknown;
}

export async function publishToMembers(
  env: Env,
  conversationId: string,
  memberIds: string[],
  event: RealtimeEvent,
  excludeUserId?: string,
): Promise<void> {
  try {
    const id = env.REALTIME_HUB.idFromName('global');
    const stub = env.REALTIME_HUB.get(id);
    await stub.fetch('https://realtime-hub/publish', {
      method: 'POST',
      body: JSON.stringify({ conversationId, memberIds, event, excludeUserId }),
    });
  } catch {
    // Fanout is best-effort; REST responses must not fail because of WS issues.
  }
}

export async function broadcastPresence(env: Env, event: RealtimeEvent): Promise<void> {
  try {
    const id = env.REALTIME_HUB.idFromName('global');
    const stub = env.REALTIME_HUB.get(id);
    await stub.fetch('https://realtime-hub/broadcast', {
      method: 'POST',
      body: JSON.stringify({ event }),
    });
  } catch {
    // best-effort
  }
}
