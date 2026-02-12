CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  client_updated_at INTEGER NOT NULL,
  server_updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS clip_tags (
  user_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (clip_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_clips_user_updated ON clips(user_id, server_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_user_client_updated ON clips(user_id, client_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_user_favorite ON clips(user_id, is_favorite, is_deleted);
CREATE INDEX IF NOT EXISTS idx_clips_user_deleted ON clips(user_id, is_deleted, server_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_id, normalized_name, is_deleted);
CREATE INDEX IF NOT EXISTS idx_clip_tags_user_clip ON clip_tags(user_id, clip_id);
CREATE INDEX IF NOT EXISTS idx_clip_tags_user_tag ON clip_tags(user_id, tag_id);
