ALTER TABLE clips ADD COLUMN content_html TEXT;
ALTER TABLE clips ADD COLUMN source_url TEXT;
ALTER TABLE clips ADD COLUMN image_data_url TEXT;

CREATE INDEX IF NOT EXISTS idx_clips_user_type ON clips(user_id, type, is_deleted, server_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_user_source_url ON clips(user_id, source_url);
