import type { FastifyInstance } from 'fastify'
import { Server, EVENTS } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import { enqueueAnalysis } from '../jobs/queue'
import { seedStubClips } from './projects'

function buildTusServer(fastify: FastifyInstance) {
  const store = new S3Store({
    s3ClientConfig: {
      bucket: process.env.R2_BUCKET!,
      // R2 requires region "auto", a custom endpoint, and path-style URLs.
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    },
  })

  const server = new Server({
    path: '/api/upload',
    datastore: store,
    respectForwardedHeaders: true,
    // Validate incoming uploads: require projectId in metadata
    onUploadCreate: async (_req, res, upload) => {
      const projectId = upload.metadata?.projectid
      if (!projectId) {
        const err = { status_code: 400, body: 'Missing projectid in Upload-Metadata' }
        throw err
      }

      // Create source_file record
      await fastify.pg.query(
        `INSERT INTO source_files (project_id, original_name, size_bytes, tus_upload_id, status)
         VALUES ($1, $2, $3, $4, 'uploading')`,
        [
          projectId,
          upload.metadata?.filename ?? 'unknown',
          upload.size ?? 0,
          upload.id,
        ]
      )

      return { res }
    },

    // Dispatch AI job when upload finishes
    onUploadFinish: async (_req, res, upload) => {
      const projectId = upload.metadata?.projectid as string

      // Update source_file to uploaded
      await fastify.pg.query(
        `UPDATE source_files
         SET status = 'uploaded', s3_key = $2, uploaded_at = NOW()
         WHERE tus_upload_id = $1`,
        [upload.id, upload.id] // tus S3 store uses upload.id as the S3 key
      )

      const sfRes = await fastify.pg.query(
        `SELECT id FROM source_files WHERE tus_upload_id = $1`,
        [upload.id]
      )
      const sourceFileId: string = sfRes.rows[0]?.id

      // Deduplication: check if another project already processed this exact file
      // (same size + original filename — full hash computed asynchronously in Phase 2)
      const dedupRes = await fastify.pg.query(
        `SELECT p.id AS source_project_id
         FROM source_files sf
         JOIN projects p ON p.id = sf.project_id
         WHERE sf.original_name = $1
           AND sf.size_bytes = $2
           AND sf.status = 'uploaded'
           AND p.id != $3
           AND p.status = 'ready'
         LIMIT 1`,
        [upload.metadata?.filename, upload.size, projectId]
      )

      if (dedupRes.rows[0]) {
        const { source_project_id } = dedupRes.rows[0]
        // Copy clips from the source project into this project
        await fastify.pg.query(
          `INSERT INTO clips
             (project_id, source_file_id, timecode_in, timecode_out,
              scene_tags, players, confidence, review_status)
           SELECT $1, sf_new.id, c.timecode_in, c.timecode_out,
                  c.scene_tags, c.players, c.confidence, c.review_status
           FROM clips c
           JOIN source_files sf_new ON sf_new.project_id = $1
           WHERE c.project_id = $2`,
          [projectId, source_project_id],
        )
        await fastify.pg.query(
          `UPDATE projects
           SET status = 'ready', source_project_id = $2, updated_at = NOW()
           WHERE id = $1`,
          [projectId, source_project_id]
        )
        fastify.log.info({ projectId, source_project_id }, 'dedup hit — reusing existing analysis')
        return { res }
      }

      // No dedup hit — fetch analysis mode and enqueue job
      const projRes = await fastify.pg.query(
        `SELECT analysis_mode, quick_search_params FROM projects WHERE id = $1`,
        [projectId]
      )
      const { analysis_mode, quick_search_params } = projRes.rows[0]

      const jobRes = await fastify.pg.query(
        `INSERT INTO jobs (project_id, type, status)
         VALUES ($1, $2, 'pending')
         RETURNING id`,
        [projectId, analysis_mode === 'full' ? 'full_analysis' : 'quick_search']
      )

      // Enqueue with a 5-second timeout so a blocked Redis doesn't stall the upload.
      const enqueueTimeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('queue timeout')), 5000)
      )
      let bullmqId: string | undefined
      try {
        bullmqId = await Promise.race([
          enqueueAnalysis({
            projectId,
            sourceFileId,
            s3Key: upload.id,
            analysisMode: analysis_mode,
            quickSearchParams: quick_search_params ?? undefined,
          }),
          enqueueTimeout,
        ])
        await fastify.pg.query(
          `UPDATE jobs SET bullmq_id = $2 WHERE id = $1`,
          [jobRes.rows[0].id, bullmqId]
        )
      } catch (err: any) {
        fastify.log.warn({ err: err.message }, 'Job enqueue failed — worker queue may be unavailable')
      }

      await fastify.pg.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId]
      )

      // Stub analysis: seed clips and mark ready after a simulated delay.
      // Replace with a real GPU worker call when the AI pipeline is ready.
      const stubDelayMs = 5000 + Math.random() * 5000
      setTimeout(async () => {
        try {
          const sf = await fastify.pg.query(
            `SELECT id FROM source_files WHERE tus_upload_id = $1`, [upload.id],
          )
          if (sf.rows[0]) {
            await seedStubClips(fastify, projectId, sf.rows[0].id, false)
          }
          const latestJob = await fastify.pg.query(
            `SELECT id FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`,
            [projectId],
          )
          if (latestJob.rows[0]) {
            await fastify.pg.query(
              `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
              [latestJob.rows[0].id],
            )
          }
          await fastify.pg.query(
            `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
            [projectId],
          )
          fastify.log.info({ projectId }, 'Stub analysis complete')
        } catch (err: any) {
          fastify.log.error({ err: err.message }, 'Stub analysis failed')
        }
      }, stubDelayMs)

      return { res }
    },
  })

  server.on(EVENTS.POST_FINISH, (req, res, upload) => {
    fastify.log.info({ uploadId: upload.id }, 'upload finished')
  })

  return server
}

export async function uploadRoutes(fastify: FastifyInstance) {
  const tusServer = buildTusServer(fastify)

  // tus requires these content types to pass through unparsed
  fastify.addContentTypeParser(
    'application/offset+octet-stream',
    (_req, _payload, done) => done(null)
  )

  const handler = async (req: any, reply: any) => {
    reply.hijack()
    tusServer.handle(req.raw, reply.raw)
  }

  fastify.options('/upload', handler)
  fastify.options('/upload/:id', handler)
  fastify.post('/upload', handler)
  fastify.patch('/upload/:id', handler)
  fastify.head('/upload/:id', handler)
  fastify.delete('/upload/:id', handler)
}
