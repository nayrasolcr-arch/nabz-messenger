-- 0001_init.sql :: Nabz messenger initial schema (D1 / SQLite)
-- Conventions: all timestamps are unix epoch milliseconds (INTEGER).
-- NOTE: users.avatar_attachment_id and conversations.last_message_id intentionally
-- have no FK to avoid circular insert constraints; they are enforced app-side.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT,
  avatar_attachment_id TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_username ON users (username COLLATE NOCASE);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_uid TEXT NOT NULL,
  name TEXT,
  platform TEXT,
  push_provider TEXT,
  push_token TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_devices_user_uid ON devices (user_id, device_uid);
CREATE INDEX idx_devices_user ON devices (user_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_rotated_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('private','group','ai')),
  title TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_message_id TEXT,
  last_message_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_conversations_last ON conversations (last_message_at DESC);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  last_read_message_id TEXT,
  last_read_at INTEGER,
  muted_until INTEGER,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_members_user ON conversation_members (user_id);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('voice','image','video','file')),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_ms INTEGER,
  waveform TEXT,
  storage_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_attachments_owner ON attachments (owner_id);
CREATE INDEX idx_attachments_conv ON attachments (conversation_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','voice','media','file','system','call')),
  body TEXT,
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
  pinned_by TEXT,
  pinned_at INTEGER,
  edited_at INTEGER,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv_created ON messages (conversation_id, created_at DESC);
CREATE INDEX idx_messages_reply ON messages (reply_to_message_id);
CREATE INDEX idx_messages_conv_pinned ON messages (conversation_id) WHERE pinned_at IS NOT NULL;

CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_reactions_message ON message_reactions (message_id);

CREATE TABLE message_reads (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_reads_conv_user ON message_reads (conversation_id, user_id, message_id);

CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  initiator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'audio' CHECK (kind IN ('audio','video')),
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing','active','ended','missed','rejected','cancelled')),
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT
);
CREATE INDEX idx_calls_conv ON calls (conversation_id, created_at DESC);
CREATE INDEX idx_calls_conv_status ON calls (conversation_id, status);

CREATE TABLE call_participants (
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','ringing','active','left','declined','missed')),
  joined_at INTEGER,
  left_at INTEGER,
  PRIMARY KEY (call_id, user_id)
);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  ai_conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ai_messages_conv ON ai_messages (ai_conversation_id, created_at);
