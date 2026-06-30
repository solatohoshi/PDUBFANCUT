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

CREATE INDEX IF NOT EXISTS projects_file_hash_idx   ON projects(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_project_idx ON source_files(project_id);
CREATE INDEX IF NOT EXISTS jobs_project_idx         ON jobs(project_id);
