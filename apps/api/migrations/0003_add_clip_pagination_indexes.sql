-- Improve pagination/sync query performance by matching ORDER BY (server_updated_at, id).
-- Existing indexes cover many filters, but do not include the secondary sort key `id`,
-- which can force extra sorting work on larger datasets.

CREATE INDEX IF NOT EXISTS idx_clips_user_deleted_updated_id
  ON clips(user_id, is_deleted, server_updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_clips_user_favorite_deleted_updated_id
  ON clips(user_id, is_favorite, is_deleted, server_updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_clips_user_server_updated_id_asc
  ON clips(user_id, server_updated_at ASC, id ASC);

