CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  analysis_mode       TEXT NOT NULL CHECK (analysis_mode IN ('full', 'quick')),
  quick_search_params JSONB,
  status              TEXT NOT NULL DEFAULT 'uploading'
                        CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  file_hash           TEXT,
  source_project_id   UUID REFERENCES projects(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  s3_key        TEXT,
  size_bytes    BIGINT,
  tus_upload_id TEXT UNIQUE,
  status        TEXT NOT NULL DEFAULT 'uploading'
                  CHECK (status IN ('uploading', 'uploaded', 'failed')),
  -- populated during pipeline validation
  duration_secs NUMERIC(10,3),
  codec         TEXT,
  width         INT,
  height        INT,
  uploaded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('full_analysis', 'quick_search')),
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  bullmq_id   TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Detected moments written by the AI pipeline (or stubs during development).
CREATE TABLE IF NOT EXISTS clips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  timecode_in     NUMERIC(10,3) NOT NULL,   -- seconds from start of video
  timecode_out    NUMERIC(10,3) NOT NULL,
  scene_tags      JSONB NOT NULL DEFAULT '[]', -- [{tag,confidence}]
  players         JSONB NOT NULL DEFAULT '[]', -- [{jersey,name,team}] stub-ready
  confidence      NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  thumb_key       TEXT,                     -- R2 key for 1-second GIF thumbnail
  review_status   TEXT NOT NULL DEFAULT 'auto'
                    CHECK (review_status IN ('auto', 'confirmed', 'dismissed')),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Rendered export jobs — one per export request, snapshot of the timeline at export time.
CREATE TABLE IF NOT EXISTS exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  preset        TEXT NOT NULL CHECK (preset IN ('tiktok', 'twitter', 'instagram', 'fullres')),
  timeline      JSONB NOT NULL,           -- TimelineClip[] snapshot
  status        TEXT NOT NULL DEFAULT 'rendering'
                  CHECK (status IN ('rendering', 'done', 'failed')),
  output_key    TEXT,                     -- R2 object key once rendered
  duration_secs NUMERIC(10,3),
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exports_project_idx        ON exports(project_id);
CREATE INDEX IF NOT EXISTS projects_file_hash_idx    ON projects(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_project_idx  ON source_files(project_id);
CREATE INDEX IF NOT EXISTS jobs_project_idx          ON jobs(project_id);
CREATE INDEX IF NOT EXISTS clips_project_idx         ON clips(project_id);
CREATE INDEX IF NOT EXISTS clips_source_file_idx     ON clips(source_file_id);
CREATE INDEX IF NOT EXISTS clips_confidence_idx      ON clips(confidence);
CREATE INDEX IF NOT EXISTS clips_review_status_idx   ON clips(review_status);
