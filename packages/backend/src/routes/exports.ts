import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

const PRESET_SPECS = {
  tiktok:    { label: 'TikTok / Reels', width: 1080, height: 1920, maxSecs: 60 },
  twitter:   { label: 'X / Twitter',    width: 1920, height: 1080, maxSecs: 140 },
  instagram: { label: 'Instagram',      width: 1080, height: 1080, maxSecs: 60 },
  fullres:   { label: 'Full res',       width: null, height: null, maxSecs: null },
} as const

type Preset = keyof typeof PRESET_SPECS

interface TimelineSlot {
  tcIn: number
  tcOut: number
  trimStart?: number
  trimEnd?: number
  speed?: number
}

function totalDuration(timeline: TimelineSlot[]): number {
  return timeline.reduce((sum, s) => {
    const raw = Math.max(0, (s.tcOut - (s.trimEnd ?? 0)) - (s.tcIn + (s.trimStart ?? 0)))
    return sum + raw / (s.speed ?? 1)
  }, 0)
}

export async function exportRoutes(fastify: FastifyInstance) {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })

  // ── Create export job ──────────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { preset: Preset; timeline: TimelineSlot[] }
  }>('/projects/:id/exports', async (req, reply) => {
    const { id } = req.params
    const { preset, timeline } = req.body

    if (!PRESET_SPECS[preset]) {
      reply.status(400).send({ error: `Invalid preset. Must be one of: ${Object.keys(PRESET_SPECS).join(', ')}` })
      return
    }

    if (!Array.isArray(timeline) || timeline.length === 0) {
      reply.status(400).send({ error: 'Timeline is empty — add clips before exporting' })
      return
    }

    const proj = await fastify.pg.query(`SELECT id FROM projects WHERE id = $1`, [id])
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }

    const durSecs = totalDuration(timeline)

    const result = await fastify.pg.query(
      `INSERT INTO exports (project_id, preset, timeline, duration_secs, status)
       VALUES ($1, $2, $3, $4, 'rendering')
       RETURNING id, project_id, preset, status, duration_secs, created_at`,
      [id, preset, JSON.stringify(timeline), durSecs.toFixed(3)],
    )
    const exp = result.rows[0]

    // Stub render: update to 'done' after a short delay (3–5 s).
    // Replace this setTimeout with a real FFmpeg cloud-worker call in Phase 4 proper.
    const renderMs  = 3000 + Math.random() * 2000
    const outputKey = `exports/${exp.id}/output.mp4`
    setTimeout(async () => {
      try {
        await fastify.pg.query(
          `UPDATE exports
           SET status = 'done', output_key = $2, updated_at = NOW()
           WHERE id = $1`,
          [exp.id, outputKey],
        )
        fastify.log.info({ exportId: exp.id, preset }, 'Stub render complete')
      } catch (err: any) {
        fastify.log.error({ err: err.message }, 'Stub render DB update failed')
      }
    }, renderMs)

    reply.status(201).send(exp)
  })

  // ── List exports for a project ─────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/projects/:id/exports', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, preset, status, duration_secs, created_at, updated_at
       FROM exports WHERE project_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    )
    reply.send(result.rows)
  })

  // ── Get single export status ───────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/exports/:id', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, project_id, preset, status, output_key, duration_secs, error, created_at, updated_at
       FROM exports WHERE id = $1`,
      [req.params.id],
    )
    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Export not found' })
      return
    }
    reply.send(result.rows[0])
  })

  // ── Download rendered file ─────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/exports/:id/download', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT preset, status, output_key FROM exports WHERE id = $1`,
      [req.params.id],
    )
    const exp = result.rows[0]
    if (!exp) {
      reply.status(404).send({ error: 'Export not found' })
      return
    }
    if (exp.status !== 'done' || !exp.output_key) {
      reply.status(409).send({ error: 'Export not ready yet' })
      return
    }

    try {
      const obj = await s3.send(new GetObjectCommand({
        Bucket: process.env.R2_BUCKET!,
        Key: exp.output_key,
      }))

      if (!obj.Body) {
        // Real file not in R2 (stub mode) — inform the user clearly.
        reply.status(404).send({
          error: 'Rendered file not in storage. In stub mode, FFmpeg does not produce a real output. Wire up a cloud FFmpeg worker to enable downloads.',
        })
        return
      }

      const filename = `pwhl-${exp.preset}-${req.params.id.slice(0, 8)}.mp4`
      reply.headers({
        'Content-Type': 'video/mp4',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'private, max-age=604800', // 7 days
      })
      const webStream = (obj.Body as { transformToWebStream(): ReadableStream }).transformToWebStream()
      reply.send(Readable.fromWeb(webStream as Parameters<typeof Readable.fromWeb>[0]))
    } catch {
      reply.status(404).send({
        error: 'File not in storage (stub mode). Connect a cloud FFmpeg worker to produce real exports.',
      })
    }
  })
}
