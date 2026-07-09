import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_BUCKET
)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')
const LOCAL_THUMBS_DIR  = join(LOCAL_UPLOADS_DIR, 'thumbs')

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
  fastify.get<{ Params: { id: string } }>('/files/:id/stream', async (req, reply) => {
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
      reply.redirect(302, url)
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
  fastify.get<{ Params: { key: string } }>('/files/:key', async (req, reply) => {
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
      reply.redirect(302, url)
      return
    }

    const localPath = join(LOCAL_THUMBS_DIR, key)
    if (!existsSync(localPath)) {
      reply.status(404).send({ error: 'Thumbnail not found' })
      return
    }
    reply.header('Content-Type', 'image/jpeg').send(createReadStream(localPath))
  })
}
