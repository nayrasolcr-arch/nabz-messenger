-- 0002_revoked_tokens.sql :: revoked refresh-token ledger for reuse detection.
-- When a refresh token is rotated, its hash moves here. If it is ever presented
-- again, the whole session family (all user sessions) is revoked.

CREATE TABLE revoked_refresh_tokens (
  refresh_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  detected_at INTEGER NOT NULL
);
CREATE INDEX idx_revoked_user ON revoked_refresh_tokens (user_id);
