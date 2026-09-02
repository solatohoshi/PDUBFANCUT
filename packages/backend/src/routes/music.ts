import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { hasFFmpeg, ffprobe } from '../lib/ffmpeg'
import { requireProjectOwner } from '../lib/ownership'
import { idParams } from '../lib/schemas'

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')

// A single background-music track is small enough to buffer whole in memory —
// unlike the multi-GB video pipeline (which needs tus's resumable chunking),
// a plain raw-body upload keeps this feature simple.
const MAX_MUSIC_BYTES = 50 * 1024 * 1024 // 50 MB

const ALLOWED_MIME: Record<string, string> = {
  'audio/mpeg':  '.mp3',
  'audio/mp3':   '.mp3',
  'audio/wav':   '.wav',
  'audio/x-wav': '.wav',
  'audio/wave':  '.wav',
  'audio/aac':   '.aac',
  'audio/mp4':   '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/ogg':   '.ogg',
}

export async function musicRoutes(fastify: FastifyInstance) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? 'placeholder'}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID  ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  })

  // Accept raw audio bytes directly — no multipart/tus wrapper needed at this size.
  for (const mime of Object.keys(ALLOWED_MIME)) {
    fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  }

  async function deleteStoredObject(key: string) {
    if (R2_READY) {
      await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key })).catch(() => {})
    } else {
      await rm(join(LOCAL_UPLOADS_DIR, key), { force: true }).catch(() => {})
    }
  }

  // ── Upload / replace the project's background music track ────────────────
  fastify.post<{ Params: { id: string } }>(
    '/projects/:id/music',
    {
      bodyLimit: MAX_MUSIC_BYTES,
      schema: { params: idParams() },
      preHandler: requireProjectOwner(),
      config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
    },
    async (req, reply) => {
      const mime = (req.headers['content-type'] ?? '').toString().split(';')[0].trim()
      const ext = ALLOWED_MIME[mime]
      if (!ext) {
        reply.status(415).send({ error: `Unsupported audio type "${mime || '(none)'}". Accepted: MP3, WAV, AAC, M4A, OGG.` })
        return
      }

      const body = req.body as Buffer
      if (!body || body.length === 0) {
        reply.status(400).send({ error: 'Empty upload' })
        return
      }

      const rawFilename = req.headers['x-filename'] as string | undefined
      let originalName = `music${ext}`
      if (rawFilename) {
        try { originalName = decodeURIComponent(rawFilename).slice(0, 255) } catch { /* keep default */ }
      }
      const key = `music/${req.params.id}/${randomUUID()}${ext}`

      // ffprobe needs a seekable file, not a buffer over the wire
      const tmpPath = join(tmpdir(), `music-upload-${randomUUID()}${ext}`)
      let durationSecs: number | null = null
      try {
        await writeFile(tmpPath, body)
        if (!await hasFFmpeg()) {
          reply.status(503).send({ error: 'ffmpeg/ffprobe is required to validate audio uploads' })
          return
        }
        const meta = await ffprobe(tmpPath)
        durationSecs = meta && meta.duration_secs > 0 ? meta.duration_secs : null
        if (!durationSecs) {
          reply.status(422).send({ error: 'Could not read a valid duration from this audio file' })
          return
        }

        const existing = await fastify.pg.query(
          `SELECT s3_key FROM project_music WHERE project_id = $1`, [req.params.id],
        )

        if (R2_READY) {
          await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET!, Key: key, Body: body, ContentType: mime,
          }))
        } else {
          const localPath = join(LOCAL_UPLOADS_DIR, key)
          mkdirSync(dirname(localPath), { recursive: true })
          await writeFile(localPath, body)
        }

        // A fresh upload resets position/trim to defaults — the old block's
        // placement wouldn't mean anything against a different audio file.
        let result
        try {
          result = await fastify.pg.query(
            `INSERT INTO project_music (project_id, s3_key, original_name, size_bytes, duration_secs, start_secs, trim_start, trim_end)
             VALUES ($1, $2, $3, $4, $5, 0, 0, 0)
             ON CONFLICT (project_id) DO UPDATE SET
               s3_key = EXCLUDED.s3_key, original_name = EXCLUDED.original_name,
               size_bytes = EXCLUDED.size_bytes, duration_secs = EXCLUDED.duration_secs,
               start_secs = 0, trim_start = 0, trim_end = 0,
               created_at = NOW()
             RETURNING id, original_name, size_bytes, duration_secs, start_secs, trim_start, trim_end, created_at`,
            [req.params.id, key, originalName, body.length, durationSecs],
          )
        } catch (err) {
          await deleteStoredObject(key)
          throw err
        }
        // Delete the former object only after the database safely points to
        // the replacement. A database failure therefore leaves the old track
        // usable instead of leaving a dangling row.
        if (existing.rows[0]?.s3_key) await deleteStoredObject(existing.rows[0].s3_key)
        reply.status(201).send(result.rows[0])
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {})
      }
    },
  )

  // ── Fetch current track metadata (null if none) ───────────────────────────
  fastify.get<{ Params: { id: string } }>('/projects/:id/music', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, original_name, size_bytes, duration_secs, start_secs, trim_start, trim_end, created_at
       FROM project_music WHERE project_id = $1`,
      [req.params.id],
    )
    reply.send(result.rows[0] ?? null)
  })

  // ── Reposition / re-trim the track on the timeline (no re-upload) ─────────
  fastify.patch<{
    Params: { id: string }
    Body: { startSecs?: number; trimStart?: number; trimEnd?: number }
  }>('/projects/:id/music', {
    schema: {
      params: idParams(),
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          startSecs: { type: 'number', minimum: 0, maximum: 86400 },
          trimStart: { type: 'number', minimum: 0, maximum: 86400 },
          trimEnd: { type: 'number', minimum: 0, maximum: 86400 },
        },
      },
    },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { startSecs, trimStart, trimEnd } = req.body
    const current = await fastify.pg.query(
      `SELECT duration_secs, trim_start, trim_end FROM project_music WHERE project_id = $1`,
      [req.params.id],
    )
    if (!current.rows[0]) {
      reply.status(404).send({ error: 'No music track for this project' })
      return
    }
    const nextTrimStart = trimStart ?? Number(current.rows[0].trim_start)
    const nextTrimEnd = trimEnd ?? Number(current.rows[0].trim_end)
    const duration = Number(current.rows[0].duration_secs)
    if (duration > 0 && nextTrimStart + nextTrimEnd >= duration) {
      reply.status(400).send({ error: 'Music trims must leave part of the track playable' })
      return
    }
    const sets: string[] = []
    const values: (string | number)[] = [req.params.id]
    if (typeof startSecs === 'number' && isFinite(startSecs)) {
      values.push(Math.max(0, startSecs)); sets.push(`start_secs = $${values.length}`)
    }
    if (typeof trimStart === 'number' && isFinite(trimStart)) {
      values.push(Math.max(0, trimStart)); sets.push(`trim_start = $${values.length}`)
    }
    if (typeof trimEnd === 'number' && isFinite(trimEnd)) {
      values.push(Math.max(0, trimEnd)); sets.push(`trim_end = $${values.length}`)
    }
    if (sets.length === 0) { reply.status(400).send({ error: 'No valid fields to update' }); return }

    const result = await fastify.pg.query(
      `UPDATE project_music SET ${sets.join(', ')} WHERE project_id = $1
       RETURNING id, original_name, size_bytes, duration_secs, start_secs, trim_start, trim_end, created_at`,
      values,
    )
    if (!result.rows[0]) { reply.status(404).send({ error: 'No music track for this project' }); return }
    reply.send(result.rows[0])
  })

  // ── Remove the track ───────────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>('/projects/:id/music', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `DELETE FROM project_music WHERE project_id = $1 RETURNING s3_key`,
      [req.params.id],
    )
    const key = result.rows[0]?.s3_key
    if (key) await deleteStoredObject(key)
    reply.status(204).send()
  })

  // ── Stream for the in-editor preview player ────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/projects/:id/music/stream', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT s3_key FROM project_music WHERE project_id = $1`, [req.params.id],
    )
    const key = result.rows[0]?.s3_key
    if (!key) { reply.status(404).send({ error: 'No music track for this project' }); return }

    if (R2_READY) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key, ResponseContentDisposition: 'inline' }),
        { expiresIn: 3600 },
      )
      reply.redirect(url, 302)
      return
    }

    const localPath = join(LOCAL_UPLOADS_DIR, key)
    if (!existsSync(localPath)) {
      reply.status(404).send({ error: 'File not found on disk' })
      return
    }
    reply.header('Accept-Ranges', 'bytes').send(createReadStream(localPath))
  })
}
