import 'dotenv/config'
import { Worker } from 'bullmq'
import { Client } from 'pg'
import { connection } from './queue'
import type { AnalysisJobData } from './queue'

const pg = new Client({ connectionString: process.env.DATABASE_URL! })

async function main() {
  await pg.connect()

  const worker = new Worker<AnalysisJobData>(
    'analysis',
    async (job) => {
      const { projectId, sourceFileId, analysisMode } = job.data
      console.log(`[worker] Starting ${analysisMode} for project ${projectId}`)

      await pg.query(
        `UPDATE jobs SET status = 'running', updated_at = NOW() WHERE project_id = $1 AND status = 'pending'`,
        [projectId]
      )
      await pg.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId]
      )

      // Phase 2: replace this stub with the real AI pipeline
      console.log(`[worker] TODO: run AI pipeline for source_file ${sourceFileId}`)
      await new Promise((r) => setTimeout(r, 2000))

      await pg.query(
        `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE project_id = $1 AND status = 'running'`,
        [projectId]
      )
      await pg.query(
        `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [projectId]
      )

      console.log(`[worker] Done — project ${projectId} is ready`)
    },
    { connection, concurrency: 2 }
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    console.error(`[worker] Job ${job.id} failed:`, err.message)
    await pg.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE project_id = $1`,
      [job.data.projectId, err.message]
    )
    await pg.query(
      `UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [job.data.projectId]
    )
  })

  console.log('[worker] Listening for analysis jobs…')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
