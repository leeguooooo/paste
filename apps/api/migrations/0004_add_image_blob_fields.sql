-- Store images in object storage (R2) and keep only small previews/metadata in D1.
ALTER TABLE clips ADD COLUMN image_object_key TEXT;
ALTER TABLE clips ADD COLUMN image_mime TEXT;
ALTER TABLE clips ADD COLUMN image_bytes INTEGER;
ALTER TABLE clips ADD COLUMN image_sha256 TEXT;
ALTER TABLE clips ADD COLUMN image_preview_data_url TEXT;

-- Optional: faster lookups if you ever want to de-dupe or audit blobs.
CREATE INDEX IF NOT EXISTS idx_clips_user_image_sha256
  ON clips(user_id, image_sha256);

