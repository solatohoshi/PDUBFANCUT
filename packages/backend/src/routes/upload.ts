import type { FastifyInstance } from 'fastify'
import { Server, EVENTS } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import { enqueueAnalysis } from '../jobs/queue'

function buildTusServer(fastify: FastifyInstance) {
  const store = new S3Store({
    s3ClientConfig: {
      bucket: process.env.S3_BUCKET!,
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
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

      const bullmqId = await enqueueAnalysis({
        projectId,
        sourceFileId,
        s3Key: upload.id,
        analysisMode: analysis_mode,
        quickSearchParams: quick_search_params ?? undefined,
      })

      await fastify.pg.query(
        `UPDATE jobs SET bullmq_id = $2 WHERE id = $1`,
        [jobRes.rows[0].id, bullmqId]
      )

      await fastify.pg.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId]
      )

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
