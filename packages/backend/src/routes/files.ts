import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { hasFFmpeg, generateClipThumbnail } from '../lib/ffmpeg'
import { requireSourceFileOwner, requireThumbnailOwner } from '../lib/ownership'
import { idParams } from '../lib/schemas'

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')
const LOCAL_THUMBS_DIR  = join(LOCAL_UPLOADS_DIR, 'thumbs')
const LOCAL_FRAMES_DIR  = join(LOCAL_THUMBS_DIR, 'frames')

// Timeline filmstrip frames are requested at pixel-derived timestamps that
// shift by fractions of a second on every re-render (zoom, trim-drag). Round
// to this grid so nearby requests collapse onto the same cached frame instead
// of triggering a fresh ffmpeg extraction (and a new browser fetch) each time.
const FRAME_CACHE_GRANULARITY_SECS = 0.25

function roundToGrid(t: number): number {
  return Math.max(0, Math.round(t / FRAME_CACHE_GRANULARITY_SECS) * FRAME_CACHE_GRANULARITY_SECS)
}

// A busy timeline drag can fire off a dozen-plus uncached filmstrip requests
// within the same second (one per thumbnail slot, across several clips). Each
// spawns an ffmpeg process; letting them all run unbounded starves the CPU and
// makes every one of them slower, which is the opposite of what the filmstrip
// is for. Cap how many run at once and queue the rest.
const MAX_CONCURRENT_FRAME_EXTRACTIONS = 3
let activeFrameExtractions = 0
const frameExtractionQueue: Array<() => void> = []

async function withFrameExtractionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeFrameExtractions >= MAX_CONCURRENT_FRAME_EXTRACTIONS) {
    await new Promise<void>((resolve) => frameExtractionQueue.push(resolve))
  }
  activeFrameExtractions++
  try {
    return await fn()
  } finally {
    activeFrameExtractions--
    frameExtractionQueue.shift()?.()
  }
}

export async function fileRoutes(fastify: FastifyInstance) {
  mkdirSync(LOCAL_THUMBS_DIR, { recursive: true })

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? 'placeholder'}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID  ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  })

  // Serve a source file so the browser <video> can seek.
  // R2 mode: redirect to a presigned URL (browser streams directly, full Range support).
  // Local mode: stream the file from disk.
  fastify.get<{ Params: { id: string } }>('/files/:id/stream', {
    schema: { params: idParams() },
    preHandler: requireSourceFileOwner(),
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT s3_key, original_name, size_bytes FROM source_files WHERE id = $1`,
      [req.params.id],
    )
    const file = result.rows[0]
    if (!file?.s3_key) {
      reply.status(404).send({ error: 'File not found' })
      return
    }

    if (R2_READY) {
      // Redirect to a short-lived presigned URL — browser handles Range requests natively.
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET!,
          Key: file.s3_key,
          ResponseContentType: 'video/mp4',
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: 3600 },
      )
      reply.redirect(url, 302)
      return
    }

    // Local file store fallback
    const localPath = join(LOCAL_UPLOADS_DIR, file.s3_key)
    if (!existsSync(localPath)) {
      reply.status(404).send({ error: 'File not found on disk' })
      return
    }

    const range = req.headers.range as string | undefined
    const totalSize = Number(file.size_bytes) || 0

    if (range && totalSize > 0) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-')
      const start = parseInt(startStr, 10)
      const end   = endStr ? parseInt(endStr, 10) : totalSize - 1
      const chunkSize = end - start + 1

      reply.status(206).headers({
        'Content-Range':  `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   'video/mp4',
      })
      reply.send(createReadStream(localPath, { start, end }))
    } else {
      const headers: Record<string, string | number> = {
        'Content-Type':  'video/mp4',
        'Accept-Ranges': 'bytes',
      }
      // Only include Content-Length when size is known; a 0 would tell the browser
      // to read zero bytes and fail to load the video entirely.
      if (totalSize > 0) headers['Content-Length'] = totalSize
      reply.status(200).headers(headers)
      reply.send(createReadStream(localPath))
    }
  })

  // Serve clip thumbnails — key is stored in clips.thumb_key, e.g. "thumb-<clipId>.jpg".
  // ClipCard requests /api/files/<thumb_key> which maps here.
  fastify.get<{ Params: { key: string } }>('/files/:key', {
    schema: {
      params: {
        type: 'object', additionalProperties: false, required: ['key'],
        properties: { key: { type: 'string', pattern: '^thumb-[0-9a-fA-F-]{36}\\.jpg$' } },
      },
    },
    preHandler: requireThumbnailOwner(),
    config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const key = req.params.key

    if (R2_READY) {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET!,
          Key: key,
          ResponseContentType: 'image/jpeg',
          ResponseContentDisposition: 'inline',
        }),
        { expiresIn: 3600 },
      )
      reply.redirect(url, 302)
      return
    }

    const localPath = join(LOCAL_THUMBS_DIR, key)
    if (!existsSync(localPath)) {
      reply.status(404).send({ error: 'Thumbnail not found' })
      return
    }
    reply.header('Content-Type', 'image/jpeg').send(createReadStream(localPath))
  })

  // Filmstrip frame thumbnails — a timeline clip block requests several of
  // these (one per visible thumbnail slot) to render a real frame-by-frame
  // filmstrip instead of one stretched static image. Generated on demand via
  // ffmpeg and cached (by source file + rounded timestamp) since the same
  // frame gets requested repeatedly across renders, zoom levels, and reloads.
  fastify.get<{ Params: { id: string }; Querystring: { t?: string } }>(
    '/source-files/:id/frame',
    {
      schema: {
        params: idParams(),
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            t: { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]{1,3})?$' },
            token: { type: 'string', minLength: 20, maxLength: 2048 },
          },
        },
      },
      preHandler: requireSourceFileOwner(),
      config: { rateLimit: { max: 180, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const raw = parseFloat(req.query.t ?? '0')
      const t = roundToGrid(isNaN(raw) ? 0 : raw)

      const result = await fastify.pg.query(
        `SELECT s3_key FROM source_files WHERE id = $1`,
        [req.params.id],
      )
      const file = result.rows[0]
      if (!file?.s3_key) {
        reply.status(404).send({ error: 'Source file not found' })
        return
      }

      const cacheKey = `frames/${req.params.id}/${t.toFixed(2)}.jpg`

      if (R2_READY) {
        // Already cached from an earlier request — redirect, no ffmpeg needed.
        try {
          await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: cacheKey }))
          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: cacheKey, ResponseContentType: 'image/jpeg' }),
            { expiresIn: 3600 },
          )
          reply.redirect(url, 302)
          return
        } catch {
          // Not cached yet — fall through and generate it.
        }

        if (!await hasFFmpeg()) {
          reply.status(503).send({ error: 'ffmpeg not available' })
          return
        }

        const sourceUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: file.s3_key }),
          { expiresIn: 300 },
        )
        const tmpPath = join(tmpdir(), `frame-${randomUUID()}.jpg`)
        try {
          await withFrameExtractionSlot(() => generateClipThumbnail(sourceUrl, t, tmpPath))
          const buf = await readFile(tmpPath)
          await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET!, Key: cacheKey, Body: buf, ContentType: 'image/jpeg',
          }))
          reply.header('Content-Type', 'image/jpeg')
            .header('Cache-Control', 'public, max-age=31536000, immutable')
            .send(buf)
        } finally {
          await rm(tmpPath, { force: true }).catch(() => {})
        }
        return
      }

      // Local file store fallback
      const localCachePath = join(LOCAL_FRAMES_DIR, req.params.id, `${t.toFixed(2)}.jpg`)
      if (existsSync(localCachePath)) {
        reply.header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .send(createReadStream(localCachePath))
        return
      }
      if (!await hasFFmpeg()) {
        reply.status(503).send({ error: 'ffmpeg not available' })
        return
      }
      const localVideoPath = join(LOCAL_UPLOADS_DIR, file.s3_key)
      mkdirSync(join(LOCAL_FRAMES_DIR, req.params.id), { recursive: true })
      await withFrameExtractionSlot(() => generateClipThumbnail(localVideoPath, t, localCachePath))
      reply.header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(createReadStream(localCachePath))
    },
  )
}
