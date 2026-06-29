CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id    TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  analysis_mode      TEXT NOT NULL CHECK (analysis_mode IN ('full', 'quick')),
  quick_search_params JSONB,                            -- { players: string[], scenes: string[] }
  status             TEXT NOT NULL DEFAULT 'uploading'
                       CHECK (status IN ('uploading', 'processing', 'ready', 'failed')),
  file_hash          TEXT,                              -- SHA-256 of source file; set after upload
  source_project_id  UUID REFERENCES projects(id),     -- non-null when deduped from another project
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name   TEXT NOT NULL,
  s3_key          TEXT,
  size_bytes      BIGINT,
  tus_upload_id   TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'uploading'
                    CHECK (status IN ('uploading', 'uploaded', 'failed')),
  uploaded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
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

CREATE INDEX IF NOT EXISTS projects_user_id_idx   ON projects(user_id);
CREATE INDEX IF NOT EXISTS projects_file_hash_idx ON projects(file_hash) WHERE file_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_files_project_idx ON source_files(project_id);
CREATE INDEX IF NOT EXISTS jobs_project_idx       ON jobs(project_id);
