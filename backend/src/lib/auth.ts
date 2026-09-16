// Authentication middleware + session helpers.
import { ApiError, unauthorized } from './errors';
import { sha256Hex } from './crypto';
import type { SessionRow, UserRow } from '../types';

export interface AuthContext {
  userId: string;
  sessionId: string;
  deviceId: string | null;
  user: UserRow;
}

type C = { env: Env; set(k: 'auth', v: AuthContext): void; req: { header(k: string): string | undefined } };

function bearerToken(headerVal: string | undefined): string | null {
  if (!headerVal) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerVal.trim());
  return m ? m[1].trim() : null;
}

export async function loadSessionByToken(db: D1Database, token: string): Promise<{
  session: SessionRow;
  user: UserRow;
} | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.*, u.id AS u_id, u.username, u.display_name, u.password_hash, u.bio,
              u.avatar_attachment_id, u.last_seen_at, u.created_at AS u_created, u.updated_at AS u_updated
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  const session: SessionRow = {
    id: row.id as string,
    user_id: row.user_id as string,
    device_id: (row.device_id as string | null) ?? null,
    token_hash: row.token_hash as string,
    refresh_hash: row.refresh_hash as string,
    expires_at: row.expires_at as number,
    refresh_expires_at: row.refresh_expires_at as number,
    revoked_at: (row.revoked_at as number | null) ?? null,
    created_at: row.created_at as number,
    last_rotated_at: row.last_rotated_at as number,
  };
  const user: UserRow = {
    id: row.u_id as string,
    username: row.username as string,
    display_name: row.display_name as string,
    password_hash: row.password_hash as string,
    bio: (row.bio as string | null) ?? null,
    avatar_attachment_id: (row.avatar_attachment_id as string | null) ?? null,
    last_seen_at: (row.last_seen_at as number | null) ?? null,
    created_at: row.u_created as number,
    updated_at: row.u_updated as number,
  };
  return { session, user };
}

export async function requireAuth(c: C, next: () => Promise<void>): Promise<void> {
  const token = bearerToken(c.req.header('Authorization'));
  if (!token) throw unauthorized();
  const found = await loadSessionByToken(c.env.DB, token);
  if (!found) throw unauthorized('INVALID_SESSION', 'Session not found or revoked');
  if (found.session.expires_at < Date.now()) throw unauthorized('TOKEN_EXPIRED', 'Access token expired');
  c.set('auth', {
    userId: found.user.id,
    sessionId: found.session.id,
    deviceId: found.session.device_id,
    user: found.user,
  });
  await next();
}

export function getAuth(c: { get(k: 'auth'): AuthContext }): AuthContext {
  return c.get('auth');
}

// ---- membership / authorization guards (anti-IDOR) ----

export interface MembershipInfo {
  role: 'owner' | 'admin' | 'member';
  conversation_id: string;
  user_id: string;
  conversation_type: 'private' | 'group' | 'ai';
}

export async function requireMembership(db: D1Database, userId: string, conversationId: string): Promise<MembershipInfo> {
  const row = await db
    .prepare(
      `SELECT m.role, c.type
       FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.conversation_id = ?1 AND m.user_id = ?2`,
    )
    .bind(conversationId, userId)
    .first<{ role: 'owner' | 'admin' | 'member'; type: 'private' | 'group' | 'ai' }>();
  if (!row) throw new ApiError(403, 'NOT_A_MEMBER', 'You are not a member of this conversation');
  return { role: row.role, user_id: userId, conversation_id: conversationId, conversation_type: row.type };
}

export async function listMemberIds(db: D1Database, conversationId: string): Promise<string[]> {
  const res = await db
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?1')
    .bind(conversationId)
    .all<{ user_id: string }>();
  return (res.results ?? []).map((r) => r.user_id);
}

export function requireRole(m: MembershipInfo, allowed: Array<'owner' | 'admin' | 'member'>): void {
  if (!allowed.includes(m.role)) {
    throw new ApiError(403, 'INSUFFICIENT_ROLE', 'Your role does not permit this action');
  }
}
