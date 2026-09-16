// Shared domain + environment types for Nabz backend.
import type { DurableObjectState, DurableObjectNamespace, D1Database, KVNamespace } from '@cloudflare/workers-types';

export type ConversationType = 'private' | 'group' | 'ai';
export type MessageKind = 'text' | 'voice' | 'media' | 'file' | 'system' | 'call';
export type MemberRole = 'owner' | 'admin' | 'member';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  bio: string | null;
  avatar_attachment_id: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  refresh_hash: string;
  expires_at: number;
  refresh_expires_at: number;
  revoked_at: number | null;
  created_at: number;
  last_rotated_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_uid: string;
  name: string | null;
  platform: string | null;
  push_provider: string | null;
  push_token: string | null;
  created_at: number;
  last_active_at: number;
}

export interface ConversationRow {
  id: string;
  type: ConversationType;
  title: string | null;
  created_by: string | null;
  last_message_id: string | null;
  last_message_at: number | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  type: MessageKind;
  body: string | null;
  reply_to_message_id: string | null;
  attachment_id: string | null;
  pinned_by: string | null;
  pinned_at: number | null;
  edited_at: number | null;
  deleted_at: number | null;
  created_at: number;
}

export interface CallRow {
  id: string;
  conversation_id: string;
  initiator_id: string;
  kind: 'audio' | 'video';
  status: 'ringing' | 'active' | 'ended' | 'missed' | 'rejected' | 'cancelled';
  created_at: number;
  answered_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
}

export interface AttachmentRow {
  id: string;
  owner_id: string;
  conversation_id: string | null;
  kind: 'voice' | 'image' | 'video' | 'file';
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  waveform: string | null;
  storage_key: string;
  created_at: number;
}

// Public DTOs (never leak password_hash or token hashes)
export interface PublicUser {
  id: string;
  username: string;
  display_name: string;
  bio: string | null;
  avatar_attachment_id: string | null;
  last_seen_at: number | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    bio: u.bio,
    avatar_attachment_id: u.avatar_attachment_id,
    last_seen_at: u.last_seen_at,
  };
}
