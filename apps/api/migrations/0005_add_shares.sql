-- Anonymous quick-share ("快传"): ephemeral, no-auth clips addressed by a short
-- code. TTL-bounded (expires_at); read is public. Kept separate from `clips` so
-- anonymous content never mixes into a user's synced history.
CREATE TABLE IF NOT EXISTS shares (
  code            TEXT PRIMARY KEY,
  type            TEXT NOT NULL DEFAULT 'text',
  content         TEXT,
  content_html    TEXT,
  source_url      TEXT,
  image_data_url  TEXT,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  views           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shares_expires ON shares (expires_at);
