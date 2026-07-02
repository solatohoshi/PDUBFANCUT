import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

export async function fileRoutes(fastify: FastifyInstance) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })

  // Stream a source file from R2 with Range support so the browser <video> can seek.
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

    const range = req.headers.range as string | undefined

    try {
      const obj = await s3.send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET!,
          Key: file.s3_key,
          ...(range ? { Range: range } : {}),
        }),
      )

      if (!obj.Body) {
        reply.status(404).send({ error: 'Empty response from storage' })
        return
      }

      const headers: Record<string, string | number> = {
        'Content-Type': obj.ContentType ?? 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      }

      if (range && obj.ContentRange) {
        headers['Content-Range'] = obj.ContentRange
        if (obj.ContentLength != null) headers['Content-Length'] = obj.ContentLength
        reply.status(206)
      } else {
        if (file.size_bytes) headers['Content-Length'] = Number(file.size_bytes)
        reply.status(200)
      }

      reply.headers(headers)

      // obj.Body is an AWS SdkStreamMixin; convert to a Node.js Readable for Fastify.
      const webStream = (obj.Body as { transformToWebStream(): ReadableStream }).transformToWebStream()
      reply.send(Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]))
    } catch (err: any) {
      fastify.log.error({ err: err.message }, 'R2 stream error')
      if (!reply.sent) reply.status(502).send({ error: 'Storage unavailable' })
    }
  })
}
