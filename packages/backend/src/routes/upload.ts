import type { FastifyInstance } from 'fastify'
import { Server, EVENTS } from '@tus/server'
import { S3Store } from '@tus/s3-store'
import { FileStore } from '@tus/file-store'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl }               from '@aws-sdk/s3-request-presigner'
import { mkdirSync, existsSync } from 'node:fs'
import { rm, readFile, rename } from 'node:fs/promises'
import { join }                       from 'node:path'
import { tmpdir }                     from 'node:os'
import { enqueueAnalysis } from '../jobs/queue'
import { hasFFmpeg, ffprobe, generateClipThumbnail } from '../lib/ffmpeg'
import { analyzeVideoForClips } from '../lib/analyzeVideo'
import { sendClipsReadyEmail } from '../lib/notify'

// True only when all three R2 env vars are present
const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_BUCKET
)

// Local fallback upload directory (used when R2 is not configured)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')

function buildTusServer(fastify: FastifyInstance) {
  // S3Client only used for presigned URL generation (ffprobe) — created
  // unconditionally but only called when R2_READY is true
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? 'placeholder'}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID  ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  })

  let store: S3Store | FileStore
  if (R2_READY) {
    store = new S3Store({
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
  } else {
    mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true })
    store = new FileStore({ directory: LOCAL_UPLOADS_DIR })
    fastify.log.warn(
      { dir: LOCAL_UPLOADS_DIR },
      'R2 not configured — using local file store for uploads (dev mode). Set R2_* env vars for production.',
    )
  }

  const server = new Server({
    path: '/api/upload',
    datastore: store,
    respectForwardedHeaders: true,
    // Validate incoming uploads: size, MIME type, extension, projectId
    onUploadCreate: async (_req, res, upload) => {
      const projectId = upload.metadata?.projectid
      if (!projectId) {
        throw { status_code: 400, body: 'Missing projectid in Upload-Metadata' }
      }

      // 20 GB hard cap
      const MAX_BYTES = 20 * 1024 * 1024 * 1024
      if (upload.size && upload.size > MAX_BYTES) {
        throw { status_code: 413, body: 'File too large. Maximum size is 20 GB.' }
      }

      // MIME type allowlist
      const ALLOWED_MIME = new Set([
        'video/mp4', 'video/quicktime', 'video/x-msvideo',
        'video/avi', 'video/mxf', 'video/x-matroska',
      ])
      const filetype = upload.metadata?.filetype ?? ''
      if (filetype && !ALLOWED_MIME.has(filetype)) {
        throw {
          status_code: 415,
          body: `Unsupported file type "${filetype}". Accepted: MP4, MOV, MXF, AVI.`,
        }
      }

      // Extension allowlist
      const ALLOWED_EXT = new Set(['.mp4', '.mov', '.mxf', '.avi', '.mkv'])
      const filename = (upload.metadata?.filename ?? '').toLowerCase()
      if (filename) {
        const dot = filename.lastIndexOf('.')
        const ext = dot >= 0 ? filename.slice(dot) : ''
        if (!ALLOWED_EXT.has(ext)) {
          throw {
            status_code: 415,
            body: `Unsupported file extension "${ext || '(none)'}". Accepted: .mp4, .mov, .mxf, .avi.`,
          }
        }
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

      // Run ffprobe in the background to populate real duration/codec metadata.
      // Non-blocking: a failure here never stalls the upload response.
      ;(async () => {
        if (!await hasFFmpeg()) return
        const probeTarget = R2_READY
          ? await getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: upload.id }),
              { expiresIn: 300 },
            )
          : join(LOCAL_UPLOADS_DIR, upload.id)
        const meta = await ffprobe(probeTarget)
        if (!meta) return
        await fastify.pg.query(
          `UPDATE source_files
           SET duration_secs = $2, codec = $3, width = $4, height = $5
           WHERE tus_upload_id = $1`,
          [upload.id, meta.duration_secs, meta.codec, meta.width, meta.height],
        )
        fastify.log.info({ uploadId: upload.id, meta }, 'ffprobe metadata updated')
      })().catch((err: any) =>
        fastify.log.warn({ err: err.message, uploadId: upload.id }, 'ffprobe failed (non-fatal)'),
      )

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
        `SELECT analysis_mode, quick_search_params, name, user_id FROM projects WHERE id = $1`,
        [projectId]
      )
      const { analysis_mode, quick_search_params, name: projectName, user_id: userId } = projRes.rows[0]

      const jobRes = await fastify.pg.query(
        `INSERT INTO jobs (project_id, type, status)
         VALUES ($1, $2, 'pending')
         RETURNING id`,
        [projectId, analysis_mode === 'full' ? 'full_analysis' : 'quick_search']
      )

      // 500ms timeout — if Redis is reachable it responds in <50ms; anything longer
      // means it's unreachable and we should fall through to inline immediately so
      // the tus response isn't delayed (proxies kill long-open PATCH connections).
      const enqueueTimeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('queue timeout')), 500)
      )
      let jobEnqueued = false
      try {
        const bullmqId = await Promise.race([
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
        jobEnqueued = true
        fastify.log.info({ projectId }, 'Job enqueued — worker will handle analysis')
      } catch (err: any) {
        fastify.log.warn({ err: err.message }, 'Job enqueue failed — running inline analysis fallback')
      }

      await fastify.pg.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId]
      )

      // Inline analysis fallback: runs only when the BullMQ worker is unreachable.
      // When the worker IS available, it handles analysis end-to-end via the queue.
      if (!jobEnqueued) {
        ;(async () => {
          try {
            const ffmpegAvail = await hasFFmpeg()
            const probeTarget = R2_READY
              ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: upload.id }), { expiresIn: 300 })
              : join(LOCAL_UPLOADS_DIR, upload.id)

            let durationSecs: number | undefined
            if (ffmpegAvail) {
              const meta = await ffprobe(probeTarget)
              if (meta) {
                await fastify.pg.query(
                  `UPDATE source_files SET duration_secs=$2, codec=$3, width=$4, height=$5 WHERE tus_upload_id=$1`,
                  [upload.id, meta.duration_secs, meta.codec, meta.width, meta.height],
                )
                durationSecs = meta.duration_secs > 0 ? meta.duration_secs : undefined
              }
            }

            const videoSource = R2_READY
              ? { type: 'url' as const, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: upload.id }), { expiresIn: 3600 }) }
              : { type: 'file' as const, path: join(LOCAL_UPLOADS_DIR, upload.id), mimeType: (upload.metadata?.filetype as string | undefined) ?? 'video/mp4' }

            fastify.log.info({ projectId, durationSecs }, 'Inline analysis: calling Claude…')
            const rawClips = await analyzeVideoForClips(videoSource, durationSecs)

            let clips = durationSecs
              ? rawClips.filter((c) => c.timecode_in >= 0 && c.timecode_in < durationSecs!)
              : rawClips

            if (clips.length === 0 && durationSecs && durationSecs > 0) {
              clips = [{ timecode_in: 0, timecode_out: durationSecs, scene_tags: [{ tag: 'shot_on_goal', confidence: 0.5 }], players: [], confidence: 0.5 }]
            }

            const ffmpegInput = R2_READY
              ? (videoSource as { type: 'url'; url: string }).url
              : (videoSource as { type: 'file'; path: string }).path

            for (const clip of clips) {
              const insertRes = await fastify.pg.query(
                `INSERT INTO clips (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,'auto') RETURNING id`,
                [projectId, sourceFileId, clip.timecode_in, clip.timecode_out,
                 JSON.stringify(clip.scene_tags), JSON.stringify(clip.players),
                 Math.min(1, Math.max(0, clip.confidence))],
              )
              const clipId: string = insertRes.rows[0].id

              if (ffmpegAvail) {
                const midSecs = (clip.timecode_in + clip.timecode_out) / 2
                const thumbKey = `thumb-${clipId}.jpg`
                const tmpThumb = join(tmpdir(), thumbKey)
                try {
                  await generateClipThumbnail(ffmpegInput, midSecs, tmpThumb)
                  if (!existsSync(tmpThumb)) await generateClipThumbnail(ffmpegInput, 0, tmpThumb)
                  const thumbBuf = await readFile(tmpThumb)
                  if (R2_READY) {
                    await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: thumbKey, Body: thumbBuf, ContentLength: thumbBuf.byteLength, ContentType: 'image/jpeg' }))
                  } else {
                    mkdirSync(join(LOCAL_UPLOADS_DIR, 'thumbs'), { recursive: true })
                    await rename(tmpThumb, join(LOCAL_UPLOADS_DIR, 'thumbs', thumbKey))
                  }
                  await fastify.pg.query(`UPDATE clips SET thumb_key=$1 WHERE id=$2`, [thumbKey, clipId])
                } catch (e: any) {
                  fastify.log.warn({ err: e.message, clipId }, 'Thumbnail generation failed (non-fatal)')
                } finally {
                  await rm(tmpThumb, { force: true }).catch(() => {})
                }
              }
            }

            fastify.log.info({ projectId, clipCount: clips.length }, 'Inline analysis complete')
          } catch (err: any) {
            fastify.log.warn({ err: err.message, projectId }, 'Inline analysis failed')
          }

          // Mark job + project ready regardless of clip count
          await fastify.pg.query(`UPDATE jobs SET status='completed', updated_at=NOW() WHERE id=$1`, [jobRes.rows[0].id]).catch(() => {})
          await fastify.pg.query(`UPDATE projects SET status='ready', updated_at=NOW() WHERE id=$1`, [projectId]).catch(() => {})
          await sendClipsReadyEmail({ log: fastify.log }, projectId, projectName, userId).catch(() => {})
        })()
      }

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
    // Fastify's CORS plugin hooks don't run on hijacked replies — inject manually
    // so the browser can read tus error responses (e.g. 404, 412 on HEAD).
    const origin = req.headers.origin as string | undefined
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin)
      reply.raw.setHeader('Vary', 'Origin')
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
