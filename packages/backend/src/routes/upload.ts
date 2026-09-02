import type { IncomingMessage } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { Server, EVENTS } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import { FileStore } from '@tus/file-store'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { enqueueAnalysis } from '../jobs/queue'
import { bearerToken, type CapabilityClaims, verifyCapabilityToken } from '../lib/capabilityTokens'
import { canQueueAnalysis, canUploadToProject } from '../lib/quotas'

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MAX_UPLOAD_BYTES ?? '', 10)
  || 20 * 1024 * 1024 * 1024

const ALLOWED_MIME = new Set([
  'video/mp4', 'video/quicktime', 'video/x-msvideo',
  'video/avi', 'video/mxf', 'video/x-matroska',
])
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.mxf', '.avi', '.mkv'])

type CapabilityRequest = IncomingMessage & { capabilityClaims?: CapabilityClaims }

function buildStore(fastify: FastifyInstance): S3Store | FileStore {
  if (R2_READY) {
    return new S3Store({
      s3ClientConfig: {
        bucket: process.env.R2_BUCKET!,
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID!}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      },
    })
  }

  mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true })
  fastify.log.warn({ dir: LOCAL_UPLOADS_DIR }, 'R2 not configured — using local tus storage')
  return new FileStore({ directory: LOCAL_UPLOADS_DIR })
}

function uploadClaims(req: IncomingMessage): CapabilityClaims {
  const token = bearerToken(req.headers.authorization)
  if (!token) throw { status_code: 401, body: 'Upload authorization required' }
  try {
    return verifyCapabilityToken(token, 'upload')
  } catch (err: any) {
    throw { status_code: 401, body: err.message }
  }
}

function buildTusServer(fastify: FastifyInstance) {
  const server = new Server({
    path: '/api/upload',
    datastore: buildStore(fastify),
    respectForwardedHeaders: true,
    maxSize: MAX_UPLOAD_BYTES,

    onIncomingRequest: async (rawReq, _res, uploadId) => {
      const req = rawReq as CapabilityRequest
      const claims = uploadClaims(req)
      req.capabilityClaims = claims

      // Creation is checked against the project in onUploadCreate. Every
      // follow-up PATCH/HEAD/DELETE is tied to the original upload row so a
      // capability for project A cannot resume an upload from project B.
      if (req.method !== 'POST') {
        const owned = await fastify.pg.query(
          `SELECT sf.id
           FROM source_files sf JOIN projects p ON p.id = sf.project_id
           WHERE sf.tus_upload_id = $1 AND sf.project_id = $2 AND p.user_id = $3`,
          [uploadId, claims.projectId, claims.sub],
        )
        if (!owned.rows[0]) throw { status_code: 404, body: 'Upload not found' }
      }
    },

    onUploadCreate: async (rawReq, res, upload) => {
      const claims = (rawReq as CapabilityRequest).capabilityClaims ?? uploadClaims(rawReq)
      const projectId = upload.metadata?.projectid
      if (!projectId || projectId !== claims.projectId) {
        throw { status_code: 403, body: 'Upload token does not match the project' }
      }

      const project = await fastify.pg.query(
        `SELECT id FROM projects WHERE id = $1 AND user_id = $2`,
        [projectId, claims.sub],
      )
      if (!project.rows[0]) throw { status_code: 404, body: 'Project not found' }
      if (!await canUploadToProject(fastify.pg, projectId)) {
        throw { status_code: 429, body: 'Project file quota reached' }
      }

      if (upload.size && upload.size > MAX_UPLOAD_BYTES) {
        throw { status_code: 413, body: 'File exceeds the configured upload limit' }
      }
      const filetype = upload.metadata?.filetype ?? ''
      if (filetype && !ALLOWED_MIME.has(filetype)) {
        throw { status_code: 415, body: `Unsupported file type "${filetype}"` }
      }
      const filename = (upload.metadata?.filename ?? '').toLowerCase()
      const dot = filename.lastIndexOf('.')
      const ext = dot >= 0 ? filename.slice(dot) : ''
      if (!filename || !ALLOWED_EXT.has(ext)) {
        throw { status_code: 415, body: 'Accepted extensions: .mp4, .mov, .mxf, .avi, .mkv' }
      }

      await fastify.pg.query(
        `INSERT INTO source_files (project_id, original_name, size_bytes, tus_upload_id, status)
         VALUES ($1, $2, $3, $4, 'uploading')`,
        [projectId, upload.metadata?.filename ?? 'unknown', upload.size ?? 0, upload.id],
      )
      return { res }
    },

    onUploadFinish: async (rawReq, res, upload) => {
      const claims = (rawReq as CapabilityRequest).capabilityClaims ?? uploadClaims(rawReq)
      const projectId = claims.projectId

      const sfResult = await fastify.pg.query(
        `UPDATE source_files sf
         SET status = 'uploaded', s3_key = $2, uploaded_at = NOW()
         FROM projects p
         WHERE sf.tus_upload_id = $1 AND p.id = sf.project_id
           AND sf.project_id = $3 AND p.user_id = $4
         RETURNING sf.id`,
        [upload.id, upload.id, projectId, claims.sub],
      )
      const sourceFileId = sfResult.rows[0]?.id as string | undefined
      if (!sourceFileId) throw { status_code: 404, body: 'Upload record not found' }

      const project = await fastify.pg.query(
        `SELECT analysis_mode, quick_search_params FROM projects WHERE id = $1 AND user_id = $2`,
        [projectId, claims.sub],
      )
      const row = project.rows[0]
      if (!row) throw { status_code: 404, body: 'Project not found' }

      if (!await canQueueAnalysis(fastify.pg, claims.sub)) {
        await fastify.pg.query(
          `UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [projectId],
        )
        throw { status_code: 429, body: 'Analysis quota reached; upload is saved but was not queued' }
      }

      const jobResult = await fastify.pg.query(
        `INSERT INTO jobs (project_id, type, status)
         VALUES ($1, $2, 'pending') RETURNING id`,
        [projectId, row.analysis_mode === 'full' ? 'full_analysis' : 'quick_search'],
      )
      const jobId = jobResult.rows[0].id as string

      try {
        const bullmqId = await enqueueAnalysis({
          projectId,
          sourceFileId,
          s3Key: upload.id,
          analysisMode: row.analysis_mode,
          quickSearchParams: row.quick_search_params ?? undefined,
          replaceExistingClips: false,
        })
        await fastify.pg.query(`UPDATE jobs SET bullmq_id = $2 WHERE id = $1`, [jobId, String(bullmqId)])
        await fastify.pg.query(
          `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
          [projectId],
        )
        fastify.log.info({ projectId, jobId, bullmqId }, 'Analysis queued after upload')
      } catch (err: any) {
        await fastify.pg.query(
          `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
          [jobId, `Queue unavailable: ${err.message}`.slice(0, 2000)],
        )
        await fastify.pg.query(
          `UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [projectId],
        )
        fastify.log.error({ err: err.message, projectId }, 'Upload saved but analysis queue is unavailable')
      }
      return { res }
    },
  })

  server.on(EVENTS.POST_FINISH, (_req, _res, upload) => {
    fastify.log.info({ uploadId: upload.id }, 'Upload finished')
  })
  return server
}

export async function uploadRoutes(fastify: FastifyInstance) {
  const tusServer = buildTusServer(fastify)

  fastify.addContentTypeParser(
    'application/offset+octet-stream',
    (_req, _payload, done) => done(null),
  )

  const handler = async (req: any, reply: any) => {
    reply.hijack()
    const origin = req.headers.origin as string | undefined
    if (origin && origin === (process.env.FRONTEND_URL || 'http://localhost:5173')) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin)
      reply.raw.setHeader('Vary', 'Origin')
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true')
      reply.raw.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, HEAD, DELETE, OPTIONS')
      reply.raw.setHeader(
        'Access-Control-Allow-Headers',
        'Tus-Resumable, Upload-Offset, Upload-Length, Upload-Metadata, Upload-Checksum, Upload-Defer-Length, Content-Type, Authorization',
      )
      reply.raw.setHeader(
        'Access-Control-Expose-Headers',
        'Location, Tus-Resumable, Upload-Offset, Upload-Length, Upload-Expires',
      )
    }
    tusServer.handle(req.raw, reply.raw)
  }

  fastify.options('/upload', handler)
  fastify.options('/upload/:id', handler)
  fastify.post('/upload', handler)
  fastify.patch('/upload/:id', handler)
  fastify.head('/upload/:id', handler)
  fastify.delete('/upload/:id', handler)
}
