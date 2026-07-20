import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl }               from '@aws-sdk/s3-request-presigner'
import { hasFFmpeg, renderTimeline }  from '../lib/ffmpeg'
import type { Preset, ColorAdjust, Caption } from '../lib/ffmpeg'

const CAPTION_STYLES = new Set(['caption', 'lower-third', 'title'])

/** The frontend sends its TextSlot[] loosely typed as object[] — validate and
 * narrow to the shape renderTimeline actually needs, dropping anything malformed. */
function parseCaptions(raw: unknown[] | undefined): Caption[] {
  if (!Array.isArray(raw)) return []
  const out: Caption[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { text, style, startSecs, durationSecs } = item as Record<string, unknown>
    if (typeof text === 'string' && typeof style === 'string' && CAPTION_STYLES.has(style)) {
      out.push({
        text, style: style as Caption['style'],
        startSecs:    typeof startSecs === 'number' && isFinite(startSecs) ? Math.max(0, startSecs) : 0,
        durationSecs: typeof durationSecs === 'number' && isFinite(durationSecs) ? Math.max(0.1, durationSecs) : 3,
      })
    }
  }
  return out
}

export { Preset }

const PRESET_SPECS = {
  tiktok:    { label: 'TikTok / Reels', width: 1080, height: 1920, maxSecs: 60 },
  twitter:   { label: 'X / Twitter',    width: 1920, height: 1080, maxSecs: 140 },
  instagram: { label: 'Instagram',      width: 1080, height: 1080, maxSecs: 60 },
  fullres:   { label: 'Full res',       width: null, height: null,  maxSecs: null },
} as const

interface TimelineSlot {
  sourceFileId?: string  // populated by the frontend timeline
  clipId?:       string
  tcIn:          number
  tcOut:         number
  trimStart?:    number
  trimEnd?:      number
  speed?:        number
  colorAdjust?:  ColorAdjust
}

function totalDuration(timeline: TimelineSlot[]): number {
  return timeline.reduce((sum, s) => {
    const raw = Math.max(0, (s.tcOut - (s.trimEnd ?? 0)) - (s.tcIn + (s.trimStart ?? 0)))
    return sum + raw / (s.speed ?? 1)
  }, 0)
}

function makeS3(env: NodeJS.ProcessEnv): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     env.R2_ACCESS_KEY_ID!,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

export async function exportRoutes(fastify: FastifyInstance) {
  const s3     = makeS3(process.env)
  const bucket = process.env.R2_BUCKET ?? ''

  // ── Create export job ──────────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { preset: Preset; timeline: TimelineSlot[]; captions?: unknown[]; musicVolume?: number }
  }>('/projects/:id/exports', async (req, reply) => {
    const { id } = req.params
    const { preset, timeline } = req.body
    const captions = parseCaptions(req.body.captions)
    const musicVolume = typeof req.body.musicVolume === 'number' && isFinite(req.body.musicVolume)
      ? Math.max(0, Math.min(1, req.body.musicVolume))
      : 0.5

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
    const result  = await fastify.pg.query(
      `INSERT INTO exports (project_id, preset, timeline, duration_secs, status)
       VALUES ($1, $2, $3, $4, 'rendering')
       RETURNING id, project_id, preset, status, duration_secs, created_at`,
      [id, preset, JSON.stringify(timeline), durSecs.toFixed(3)],
    )
    const exp = result.rows[0]

    // Kick off FFmpeg render in background — does not block the HTTP response
    runRender(fastify, s3, bucket, id, exp.id, preset, timeline, captions, musicVolume).catch((err: any) => {
      fastify.log.error({ err: err.message, exportId: exp.id }, 'Export render task crashed')
    })

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
    if (!result.rows[0]) { reply.status(404).send({ error: 'Export not found' }); return }
    reply.send(result.rows[0])
  })

  // ── Download rendered file ─────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/exports/:id/download', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT preset, status, output_key FROM exports WHERE id = $1`,
      [req.params.id],
    )
    const exp = result.rows[0]
    if (!exp) { reply.status(404).send({ error: 'Export not found' }); return }
    if (exp.status !== 'done' || !exp.output_key) {
      reply.status(409).send({ error: 'Export not ready yet' })
      return
    }

    const filename = `pwhl-${exp.preset}-${req.params.id.slice(0, 8)}.mp4`
    try {
      // Verify the object actually exists first (cheap, no body transfer) so a
      // stub-mode / failed-render output_key with nothing behind it still gets
      // our friendly JSON 404 instead of the browser following the redirect
      // into Cloudflare's own XML error page.
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: exp.output_key }))

      // Redirect to a presigned URL rather than proxying bytes through this
      // server — the browser downloads directly from R2 (same pattern as
      // files.ts's /stream and /:key routes). Piping the SDK's response body
      // (a ChecksumStream wrapper) into reply.send() here previously produced
      // a 200 response with a silently-empty 0-byte body, even though the R2
      // object itself was correctly written — confirmed by reading it directly
      // with a plain node:stream pipeline outside of Fastify.
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: exp.output_key,
          ResponseContentType: 'video/mp4',
          ResponseContentDisposition: `attachment; filename="${filename}"`,
        }),
        { expiresIn: 300 },
      )
      reply.redirect(302, url)
    } catch (err: any) {
      fastify.log.error({ err: err.message, exportId: req.params.id }, 'Export download failed')
      reply.status(404).send({ error: 'File not in R2 storage (FFmpeg stub mode or render failed)' })
    }
  })
}

// ── Background render ──────────────────────────────────────────────────────

async function runRender(
  fastify:     FastifyInstance,
  s3:          S3Client,
  bucket:      string,
  projectId:   string,
  exportId:    string,
  preset:      Preset,
  timeline:    TimelineSlot[],
  captions:    Caption[],
  musicVolume: number,
): Promise<void> {
  const outputKey = `exports/${exportId}/output.mp4`

  const r2Ready = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET)

  // ── Stub fallback: no FFmpeg or no R2 credentials ─────────────────────────
  if (!r2Ready || !await hasFFmpeg()) {
    fastify.log.warn(
      { exportId, r2Ready },
      r2Ready
        ? 'FFmpeg not found — using stub render. Set FFMPEG_PATH or add ffmpeg to PATH.'
        : 'R2 not configured — using stub render. Configure R2_* env vars to enable real exports.',
    )
    await sleep(3000 + Math.random() * 2000)
    await fastify.pg.query(
      `UPDATE exports SET status = 'done', output_key = $2, updated_at = NOW() WHERE id = $1`,
      [exportId, outputKey],
    )
    return
  }

  // ── FFmpeg available — real render ─────────────────────────────────────────
  try {
    // Each slot carries sourceFileId; fall back to DB lookup via clipId if absent
    const resolvedTimeline = await resolveSourceFiles(fastify, timeline)
    if (resolvedTimeline.length === 0) throw new Error('Could not resolve any source files from timeline')

    // Presigned GET URL for each unique source file (valid 2 h)
    async function getPresignedUrl(sourceFileId: string): Promise<string> {
      const sfRow = await fastify.pg.query(
        `SELECT s3_key FROM source_files WHERE id = $1`, [sourceFileId],
      )
      const s3Key = sfRow.rows[0]?.s3_key
      if (!s3Key) throw new Error(`No S3 key for source file ${sourceFileId}`)
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: s3Key }), { expiresIn: 7200 })
    }

    const musicRow = await fastify.pg.query(
      `SELECT s3_key, duration_secs, start_secs, trim_start, trim_end FROM project_music WHERE project_id = $1`,
      [projectId],
    )
    const musicMeta = musicRow.rows[0]
    // fileDurationSecs comes from ffprobe at upload time — without it we can't
    // safely compute the `-t` seek window, so skip music rather than guess.
    const music = musicMeta?.s3_key && Number(musicMeta.duration_secs) > 0
      ? {
          url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: musicMeta.s3_key }), { expiresIn: 7200 }),
          volume: musicVolume,
          startSecs: Number(musicMeta.start_secs) || 0,
          trimStart: Number(musicMeta.trim_start) || 0,
          trimEnd:   Number(musicMeta.trim_end)   || 0,
          fileDurationSecs: Number(musicMeta.duration_secs),
        }
      : null

    await renderTimeline({ exportId, preset, timeline: resolvedTimeline, captions, music, getPresignedUrl, s3, bucket, outputKey })

    await fastify.pg.query(
      `UPDATE exports SET status = 'done', output_key = $2, updated_at = NOW() WHERE id = $1`,
      [exportId, outputKey],
    )
    fastify.log.info({ exportId, preset }, 'FFmpeg render complete')
  } catch (err: any) {
    fastify.log.error({ err: err.message, exportId }, 'FFmpeg render failed')
    await fastify.pg.query(
      `UPDATE exports SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [exportId, err.message.slice(0, 2000)],
    ).catch(() => {})
  }
}

/**
 * Ensure every timeline slot has a sourceFileId.
 * The frontend always includes it, but if it's missing (older clients) we
 * fall back to looking up the clip in the DB.
 */
async function resolveSourceFiles(
  fastify: FastifyInstance,
  timeline: TimelineSlot[],
): Promise<Array<{ sourceFileId: string; tcIn: number; tcOut: number; trimStart: number; trimEnd: number; speed: number; colorAdjust?: ColorAdjust }>> {
  const resolved = []
  for (const slot of timeline) {
    let sfId = slot.sourceFileId
    if (!sfId && slot.clipId) {
      const row = await fastify.pg.query(
        `SELECT source_file_id FROM clips WHERE id = $1`, [slot.clipId],
      )
      sfId = row.rows[0]?.source_file_id
    }
    if (!sfId) {
      fastify.log.warn({ slot }, 'Timeline slot missing sourceFileId — skipping')
      continue
    }
    resolved.push({
      sourceFileId: sfId,
      tcIn:        slot.tcIn,
      tcOut:       slot.tcOut,
      trimStart:   slot.trimStart ?? 0,
      trimEnd:     slot.trimEnd   ?? 0,
      speed:       slot.speed     ?? 1,
      colorAdjust: slot.colorAdjust,
    })
  }
  return resolved
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
