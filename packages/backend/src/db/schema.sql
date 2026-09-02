CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT,
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

-- Add user_id to existing installations (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'projects' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE projects ADD COLUMN user_id TEXT;
  END IF;
END $$;

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

-- Add metadata columns to existing source_files installations (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'tus_upload_id') THEN
    ALTER TABLE source_files ADD COLUMN tus_upload_id TEXT;
    -- UNIQUE index added separately (can't add inline in ALTER TABLE easily)
    CREATE UNIQUE INDEX IF NOT EXISTS source_files_tus_upload_id_idx ON source_files(tus_upload_id) WHERE tus_upload_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'status') THEN
    ALTER TABLE source_files ADD COLUMN status TEXT NOT NULL DEFAULT 'uploading'
      CHECK (status IN ('uploading', 'uploaded', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'duration_secs') THEN
    ALTER TABLE source_files ADD COLUMN duration_secs NUMERIC(10,3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'codec') THEN
    ALTER TABLE source_files ADD COLUMN codec TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'width') THEN
    ALTER TABLE source_files ADD COLUMN width INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'height') THEN
    ALTER TABLE source_files ADD COLUMN height INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'source_files' AND column_name = 'uploaded_at') THEN
    ALTER TABLE source_files ADD COLUMN uploaded_at TIMESTAMPTZ;
  END IF;
END $$;

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

-- Detected moments written by a versioned AI pipeline run.
CREATE TABLE IF NOT EXISTS clips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  timecode_in     NUMERIC(10,3) NOT NULL,   -- seconds from start of video
  timecode_out    NUMERIC(10,3) NOT NULL,
  scene_tags      JSONB NOT NULL DEFAULT '[]', -- [{tag,confidence}]
  players         JSONB NOT NULL DEFAULT '[]', -- [{jersey,name,team}]
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
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'rendering', 'done', 'failed')),
  bullmq_id     TEXT,
  output_key    TEXT,                     -- R2 object key once rendered
  duration_secs NUMERIC(10,3),
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Upgrade older export tables that predate queued-only rendering.
ALTER TABLE exports DROP CONSTRAINT IF EXISTS exports_status_check;
ALTER TABLE exports ADD CONSTRAINT exports_status_check
  CHECK (status IN ('queued', 'rendering', 'done', 'failed'));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exports' AND column_name = 'bullmq_id') THEN
    ALTER TABLE exports ADD COLUMN bullmq_id TEXT;
  END IF;
END $$;

-- Background music track for a project's export mix. One row per project
-- (a new upload replaces the previous one) — kept as its own table rather
-- than columns on `projects` so it can be extended to multiple tracks later
-- without another migration.
CREATE TABLE IF NOT EXISTS project_music (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  s3_key        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes    BIGINT,
  duration_secs NUMERIC(10,3),
  -- Position on the shared editor timeline (same absolute-seconds domain as
  -- the concatenated video output): start_secs is where playback begins,
  -- trim_start/trim_end cut seconds off the front/back of the source file
  -- itself — mirrors how video clips are trimmed, so the same drag-to-move/
  -- drag-edge-to-trim interaction works for the music block too.
  start_secs    NUMERIC(10,3) NOT NULL DEFAULT 0,
  trim_start    NUMERIC(10,3) NOT NULL DEFAULT 0,
  trim_end      NUMERIC(10,3) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Add positioning columns to existing installations (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_music' AND column_name = 'start_secs') THEN
    ALTER TABLE project_music ADD COLUMN start_secs NUMERIC(10,3) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_music' AND column_name = 'trim_start') THEN
    ALTER TABLE project_music ADD COLUMN trim_start NUMERIC(10,3) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_music' AND column_name = 'trim_end') THEN
    ALTER TABLE project_music ADD COLUMN trim_end NUMERIC(10,3) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- A versioned record of every real model invocation pipeline run. Metrics are
-- recorded from provider usage responses rather than inferred from file size.
CREATE TABLE IF NOT EXISTS analysis_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id      UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  pipeline_version    TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  prompt_version      TEXT NOT NULL,
  parameters          JSONB NOT NULL DEFAULT '{}',
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  estimated_cost_usd  NUMERIC(12,6) NOT NULL DEFAULT 0,
  processing_ms       BIGINT,
  error               TEXT,
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS detections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  clip_id         UUID REFERENCES clips(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  timecode_in     NUMERIC(10,3) NOT NULL,
  timecode_out    NUMERIC(10,3) NOT NULL,
  confidence      NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  chunk_index     INT,
  raw_payload     JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS training_examples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_file_id  UUID NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  clip_id         UUID UNIQUE REFERENCES clips(id) ON DELETE CASCADE,
  analysis_run_id UUID REFERENCES analysis_runs(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  is_positive     BOOLEAN NOT NULL,
  timecode_in     NUMERIC(10,3) NOT NULL,
  timecode_out    NUMERIC(10,3) NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('review_queue', 'eval_corpus', 'import')),
  created_by      TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'clips' AND column_name = 'analysis_run_id') THEN
    ALTER TABLE clips ADD COLUMN analysis_run_id UUID REFERENCES analysis_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS exports_project_idx        ON exports(project_id);
CREATE INDEX IF NOT EXISTS projects_user_id_idx      ON projects(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS projects_file_hash_idx    ON projects(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_project_idx  ON source_files(project_id);
CREATE INDEX IF NOT EXISTS jobs_project_idx          ON jobs(project_id);
CREATE INDEX IF NOT EXISTS clips_project_idx         ON clips(project_id);
CREATE INDEX IF NOT EXISTS clips_source_file_idx     ON clips(source_file_id);
CREATE INDEX IF NOT EXISTS clips_confidence_idx      ON clips(confidence);
CREATE INDEX IF NOT EXISTS clips_review_status_idx   ON clips(review_status);
CREATE INDEX IF NOT EXISTS clips_analysis_run_idx    ON clips(analysis_run_id);
CREATE INDEX IF NOT EXISTS analysis_runs_project_idx ON analysis_runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS analysis_runs_source_idx  ON analysis_runs(source_file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS detections_run_idx        ON detections(analysis_run_id);
CREATE INDEX IF NOT EXISTS detections_event_idx      ON detections(event_type, source_file_id);
CREATE INDEX IF NOT EXISTS training_examples_event_idx ON training_examples(event_type, is_positive);
