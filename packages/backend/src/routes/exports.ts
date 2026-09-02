import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { enqueueExport } from '../jobs/queue'
import { requireExportOwner, requireProjectOwner } from '../lib/ownership'
import { canCreateExport } from '../lib/quotas'
import { idParams, UUID_PATTERN } from '../lib/schemas'
import type { Caption, ColorAdjust, Preset } from '../lib/ffmpeg'

const CAPTION_STYLES = new Set(['caption', 'lower-third', 'title'])
const PRESET_SPECS = {
  tiktok: { maxSecs: 60 },
  twitter: { maxSecs: 140 },
  instagram: { maxSecs: 60 },
  fullres: { maxSecs: null },
} as const

interface TimelineSlot {
  clipId?: string
  sourceFileId: string
  tcIn: number
  tcOut: number
  trimStart: number
  trimEnd: number
  speed: number
  colorAdjust?: ColorAdjust
}

const exportBody = {
  type: 'object',
  additionalProperties: false,
  required: ['preset', 'timeline'],
  properties: {
    preset: { type: 'string', enum: Object.keys(PRESET_SPECS) },
    timeline: {
      type: 'array', minItems: 1, maxItems: 100,
      items: {
        type: 'object',
        required: ['sourceFileId', 'tcIn', 'tcOut'],
        properties: {
          id: { type: 'string', maxLength: 100 },
          clipId: { type: 'string', pattern: UUID_PATTERN },
          sourceFileId: { type: 'string', pattern: UUID_PATTERN },
          thumbKey: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }] },
          label: { type: 'string', maxLength: 40 },
          color: { type: 'string', maxLength: 30 },
          tcIn: { type: 'number', minimum: 0, maximum: 86400 },
          tcOut: { type: 'number', minimum: 0, maximum: 86400 },
          trimStart: { type: 'number', minimum: 0, maximum: 86400 },
          trimEnd: { type: 'number', minimum: 0, maximum: 86400 },
          speed: { type: 'number', minimum: 0.1, maximum: 4 },
          colorAdjust: {
            type: 'object', additionalProperties: false,
            properties: {
              brightness: { type: 'number', minimum: -1, maximum: 1 },
              contrast: { type: 'number', minimum: -1, maximum: 1 },
              saturation: { type: 'number', minimum: -1, maximum: 1 },
              hue: { type: 'number', minimum: -180, maximum: 180 },
            },
          },
        },
      },
    },
    captions: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: true,
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 500 },
          style: { type: 'string', enum: [...CAPTION_STYLES] },
          startSecs: { type: 'number', minimum: 0, maximum: 86400 },
          durationSecs: { type: 'number', minimum: 0.1, maximum: 86400 },
        },
      },
    },
    musicVolume: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const

function parseTimeline(raw: unknown[]): TimelineSlot[] {
  return raw.map((value) => {
    const item = value as Record<string, unknown>
    const color = item.colorAdjust as Record<string, unknown> | undefined
    return {
      clipId: typeof item.clipId === 'string' ? item.clipId : undefined,
      sourceFileId: String(item.sourceFileId),
      tcIn: Number(item.tcIn),
      tcOut: Number(item.tcOut),
      trimStart: Number(item.trimStart ?? 0),
      trimEnd: Number(item.trimEnd ?? 0),
      speed: Number(item.speed ?? 1),
      colorAdjust: color ? {
        brightness: Number(color.brightness ?? 0),
        contrast: Number(color.contrast ?? 0),
        saturation: Number(color.saturation ?? 0),
        hue: Number(color.hue ?? 0),
      } : undefined,
    }
  })
}

function parseCaptions(raw: unknown[] | undefined): Caption[] {
  if (!Array.isArray(raw)) return []
  const captions: Caption[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    if (typeof item.text !== 'string' || typeof item.style !== 'string' || !CAPTION_STYLES.has(item.style)) continue
    captions.push({
      text: item.text.slice(0, 500),
      style: item.style as Caption['style'],
      startSecs: Math.max(0, Number(item.startSecs) || 0),
      durationSecs: Math.max(0.1, Number(item.durationSecs) || 3),
    })
  }
  return captions
}

function totalDuration(timeline: TimelineSlot[]) {
  return timeline.reduce((sum, slot) => {
    const raw = Math.max(0, (slot.tcOut - slot.trimEnd) - (slot.tcIn + slot.trimStart))
    return sum + raw / slot.speed
  }, 0)
}

async function validateTimelineSources(fastify: FastifyInstance, projectId: string, timeline: TimelineSlot[]) {
  const sourceIds = [...new Set(timeline.map((slot) => slot.sourceFileId))]
  const result = await fastify.pg.query(
    `SELECT id, duration_secs FROM source_files WHERE project_id = $1 AND id = ANY($2::uuid[])`,
    [projectId, sourceIds],
  )
  if (result.rows.length !== sourceIds.length) return false
  const durations = new Map(result.rows.map((row) => [row.id as string, Number(row.duration_secs) || null]))
  return timeline.every((slot) => {
    const sourceDuration = durations.get(slot.sourceFileId)
    const rawDuration = slot.tcOut - slot.tcIn
    return slot.tcOut > slot.tcIn && slot.trimStart + slot.trimEnd < rawDuration
      && (!sourceDuration || slot.tcOut <= sourceDuration + 0.25)
  })
}

function makeS3() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

export { Preset }

export async function exportRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Params: { id: string }
    Body: { preset: Preset; timeline: unknown[]; captions?: unknown[]; musicVolume?: number }
  }>('/projects/:id/exports', {
    schema: { params: idParams(), body: exportBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    if (!await canCreateExport(fastify.pg, req.userId!)) {
      reply.status(429).send({ error: 'Export quota reached; wait for an active export to finish' })
      return
    }

    const timeline = parseTimeline(req.body.timeline)
    if (!await validateTimelineSources(fastify, req.params.id, timeline)) {
      reply.status(400).send({ error: 'Timeline contains invalid or inaccessible source ranges' })
      return
    }
    const duration = totalDuration(timeline)
    const maxSecs = PRESET_SPECS[req.body.preset].maxSecs
    if (maxSecs && duration > maxSecs + 0.001) {
      reply.status(400).send({ error: `${req.body.preset} exports are limited to ${maxSecs} seconds` })
      return
    }

    const captions = parseCaptions(req.body.captions)
    const musicVolume = req.body.musicVolume ?? 0.5
    const result = await fastify.pg.query(
      `INSERT INTO exports (project_id, preset, timeline, duration_secs, status)
       VALUES ($1,$2,$3,$4,'queued')
       RETURNING id, project_id, preset, status, duration_secs, created_at, updated_at`,
      [req.params.id, req.body.preset, JSON.stringify(timeline), duration.toFixed(3)],
    )
    const row = result.rows[0]

    try {
      const bullmqId = await enqueueExport({
        exportId: row.id,
        projectId: req.params.id,
        preset: req.body.preset,
        timeline,
        captions,
        musicVolume,
      })
      await fastify.pg.query(`UPDATE exports SET bullmq_id = $2 WHERE id = $1`, [row.id, String(bullmqId)])
      reply.status(202).send(row)
    } catch (err: any) {
      await fastify.pg.query(
        `UPDATE exports SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, `Queue unavailable: ${err.message}`.slice(0, 2000)],
      )
      reply.status(503).send({ error: 'Export queue unavailable' })
    }
  })

  fastify.get<{ Params: { id: string } }>('/projects/:id/exports', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, project_id, preset, status, duration_secs, error, created_at, updated_at
       FROM exports WHERE project_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    )
    reply.send(result.rows)
  })

  fastify.get<{ Params: { id: string } }>('/exports/:id', {
    schema: { params: idParams() },
    preHandler: requireExportOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, project_id, preset, status, output_key, duration_secs, error, created_at, updated_at
       FROM exports WHERE id = $1`,
      [req.params.id],
    )
    reply.send(result.rows[0])
  })

  fastify.get<{ Params: { id: string } }>('/exports/:id/download', {
    schema: { params: idParams() },
    preHandler: requireExportOwner(),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT preset, status, output_key FROM exports WHERE id = $1`,
      [req.params.id],
    )
    const row = result.rows[0]
    if (row.status !== 'done' || !row.output_key) {
      reply.status(409).send({ error: 'Export is not ready' })
      return
    }
    if (!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID
      && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET)) {
      reply.status(503).send({ error: 'Export storage is not configured' })
      return
    }

    const s3 = makeS3()
    try {
      await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: row.output_key }))
      const filename = `pwhl-${row.preset}-${req.params.id.slice(0, 8)}.mp4`
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET!,
          Key: row.output_key,
          ResponseContentType: 'video/mp4',
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
        { expiresIn: 300 },
      )
      reply.redirect(url, 302)
    } catch (err: any) {
      fastify.log.error({ err: err.message, exportId: req.params.id }, 'Export download failed')
      reply.status(404).send({ error: 'Rendered file not found' })
    }
  })
}
