import type { Pool } from 'pg'

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export async function canCreateProject(db: Pool, userId: string): Promise<boolean> {
  const result = await db.query(`SELECT COUNT(*)::int AS count FROM projects WHERE user_id = $1`, [userId])
  return Number(result.rows[0]?.count ?? 0) < envInt('MAX_PROJECTS_PER_USER', 25)
}

export async function canQueueAnalysis(db: Pool, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM jobs j JOIN projects p ON p.id = j.project_id
     WHERE p.user_id = $1 AND j.status IN ('pending', 'running')`,
    [userId],
  )
  return Number(result.rows[0]?.count ?? 0) < envInt('MAX_ACTIVE_ANALYSES_PER_USER', 2)
}

export async function canCreateExport(db: Pool, userId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM exports e JOIN projects p ON p.id = e.project_id
     WHERE p.user_id = $1 AND e.status IN ('queued', 'rendering')`,
    [userId],
  )
  return Number(result.rows[0]?.count ?? 0) < envInt('MAX_ACTIVE_EXPORTS_PER_USER', 2)
}

export async function canUploadToProject(db: Pool, projectId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT COUNT(*)::int AS count FROM source_files WHERE project_id = $1 AND status <> 'failed'`,
    [projectId],
  )
  return Number(result.rows[0]?.count ?? 0) < envInt('MAX_FILES_PER_PROJECT', 3)
}
