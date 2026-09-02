import { Worker } from 'bullmq'
import { Pool } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm, readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { connection } from './queue'
import type { AnalysisJobData, ExportJobData, MaintenanceJobData } from './queue'
import {
  ANALYSIS_MODEL,
  PIPELINE_VERSION,
  PROMPT_VERSION,
  analyzeVideoForClips,
} from '../lib/analyzeVideo'
import { hasFFmpeg, ffprobe, generateClipThumbnail } from '../lib/ffmpeg'
import { sendClipsReadyEmail } from '../lib/notify'
import { processExportJob } from '../lib/processExport'

const dbPool = new Pool({ connectionString: process.env.DATABASE_URL! })
const execFileAsync = promisify(execFile)

const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg'
const CHUNK_DURATION_SECS = 300 // 5-minute chunks

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET
)

const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')
const LOCAL_THUMBS_DIR  = join(LOCAL_UPLOADS_DIR, 'thumbs')

// Minimal logger shim compatible with notify.ts's FastifyBaseLogger expectation
const workerLog = {
  info:  (obj: any, msg?: string) => console.log('[worker]', msg ?? obj, typeof obj === 'string' ? '' : JSON.stringify(obj)),
  warn:  (obj: any, msg?: string) => console.warn('[worker]', msg ?? obj, typeof obj === 'string' ? '' : JSON.stringify(obj)),
  error: (obj: any, msg?: string) => console.error('[worker]', msg ?? obj, typeof obj === 'string' ? '' : JSON.stringify(obj)),
  debug: () => {},
  trace: () => {},
  fatal: (obj: any, msg?: string) => console.error('[worker]', msg ?? obj),
  child: function() { return this },
  silent: () => {},
  level: 'info',
} as any

function buildS3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? 'placeholder'}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID  ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  })
}

function presign(s3: S3Client, key: string, expiresIn = 7200): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: key }),
    { expiresIn },
  )
}

async function extractChunk(
  sourceUrl: string,
  startSecs: number,
  chunkDuration: number,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    FFMPEG_BIN,
    ['-y', '-ss', startSecs.toFixed(3), '-i', sourceUrl, '-t', chunkDuration.toFixed(3), '-c', 'copy', outputPath],
    { timeout: 300_000 },
  )
}

async function runPipeline(
  job: { data: AnalysisJobData },
  analysisRunId: string,
  log: (msg: string) => void,
): Promise<{ clipCount: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number }> {
  const { projectId, sourceFileId, s3Key, analysisMode, quickSearchParams } = job.data

  const allowedScenes = analysisMode === 'quick' && quickSearchParams?.scenes?.length
    ? new Set<string>(quickSearchParams.scenes)
    : null // null = all scenes

  const requestedPlayers: string[] =
    analysisMode === 'quick' ? (quickSearchParams?.players ?? []) : []

  // ── Step 1: Video metadata ────────────────────────────────────────────────
  log('Step 1/7 — reading video metadata')
  const sfRow = await dbPool.query(
    `SELECT duration_secs, codec, width, height FROM source_files WHERE id = $1`,
    [sourceFileId],
  )
  let durationSecs = Number(sfRow.rows[0]?.duration_secs) || 0

  const s3 = buildS3()
  const videoSource = R2_READY && s3Key
    ? await presign(s3, s3Key)
    : join(LOCAL_UPLOADS_DIR, s3Key)

  const ffmpegAvail = await hasFFmpeg()

  // Fallback: run ffprobe now if the upload route didn't populate duration_secs yet
  if (!durationSecs && ffmpegAvail) {
    log('Step 1/7 — duration unknown, running ffprobe')
    const meta = await ffprobe(videoSource)
    if (meta?.duration_secs) {
      durationSecs = meta.duration_secs
      await dbPool.query(
        `UPDATE source_files SET duration_secs = $2, codec = $3, width = $4, height = $5 WHERE id = $1`,
        [sourceFileId, meta.duration_secs, meta.codec, meta.width, meta.height],
      )
    }
  }

  // ── Steps 2–6: Chunked Claude video analysis ──────────────────────────────
  const allClips: {
    timecodeIn: number; timecodeOut: number
    sceneTags: any[]; players: any[]; confidence: number; chunkIndex: number
  }[] = []
  let inputTokens = 0
  let outputTokens = 0
  let estimatedCostUsd = 0

  if (durationSecs > 0 && ffmpegAvail) {
    const numChunks = Math.ceil(durationSecs / CHUNK_DURATION_SECS)
    log(`Steps 2–6 — ${numChunks} chunk(s) across ${durationSecs.toFixed(0)}s`)

    for (let i = 0; i < numChunks; i++) {
      const chunkStart    = i * CHUNK_DURATION_SECS
      const chunkDuration = Math.min(CHUNK_DURATION_SECS, durationSecs - chunkStart)
      const chunkPath     = join(tmpdir(), `pwhl_chunk_${randomUUID()}.mp4`)

      log(`  chunk ${i + 1}/${numChunks} [${chunkStart}s – ${(chunkStart + chunkDuration).toFixed(0)}s]`)
      try {
        await extractChunk(videoSource, chunkStart, chunkDuration, chunkPath)

        const analysis = await analyzeVideoForClips(
          { type: 'file', path: chunkPath, mimeType: 'video/mp4' },
          chunkDuration,
        )
        inputTokens += analysis.usage.inputTokens
        outputTokens += analysis.usage.outputTokens
        estimatedCostUsd += analysis.usage.estimatedCostUsd
        // Persist usage after every provider response so a later chunk failure
        // still leaves an honest cost record for the failed run.
        await dbPool.query(
          `UPDATE analysis_runs SET input_tokens = $2, output_tokens = $3,
             estimated_cost_usd = $4 WHERE id = $1`,
          [analysisRunId, inputTokens, outputTokens, estimatedCostUsd.toFixed(6)],
        )

        for (const clip of analysis.clips) {
          const relevantTags = allowedScenes
            ? clip.scene_tags.filter((t: any) => allowedScenes.has(t.tag))
            : clip.scene_tags
          if (relevantTags.length === 0) continue

          if (requestedPlayers.length > 0) {
            const hasMatch = clip.players.some((p: any) =>
              requestedPlayers.some(rp =>
                p.jersey === rp || p.name?.toLowerCase().includes(rp.toLowerCase())
              )
            )
            if (!hasMatch) continue
          }

          allClips.push({
            timecodeIn:  chunkStart + clip.timecode_in,
            timecodeOut: chunkStart + clip.timecode_out,
            sceneTags:   relevantTags,
            players:     clip.players,
            confidence:  clip.confidence,
            chunkIndex:  i,
          })
        }
      } finally {
        await rm(chunkPath, { force: true }).catch(() => {})
      }
    }
  } else {
    throw new Error('ffmpeg and valid video duration are required for queued analysis')
  }

  log(`Step 6/7 — boundary detection complete, ${allClips.length} clips`)

  // ── Step 7: Clip packaging + thumbnails ───────────────────────────────────
  log(`Step 7/7 — packaging ${allClips.length} clips`)
  mkdirSync(LOCAL_THUMBS_DIR, { recursive: true })

  if (job.data.replaceExistingClips) {
    await dbPool.query(`DELETE FROM clips WHERE project_id = $1`, [projectId])
  }

  for (const clip of allClips) {
    const insertRes = await dbPool.query(
      `INSERT INTO clips
         (project_id, source_file_id, analysis_run_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'auto')
       RETURNING id`,
      [
        projectId, sourceFileId, analysisRunId,
        clip.timecodeIn.toFixed(3),  clip.timecodeOut.toFixed(3),
        JSON.stringify(clip.sceneTags), JSON.stringify(clip.players),
        Math.min(1, Math.max(0, clip.confidence)).toFixed(3),
      ],
    )
    const clipId: string = insertRes.rows[0].id

    for (const tag of clip.sceneTags) {
      await dbPool.query(
        `INSERT INTO detections
           (analysis_run_id, project_id, source_file_id, clip_id, event_type,
            timecode_in, timecode_out, confidence, chunk_index, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          analysisRunId, projectId, sourceFileId, clipId, tag.tag,
          clip.timecodeIn.toFixed(3), clip.timecodeOut.toFixed(3),
          Math.min(1, Math.max(0, Number(tag.confidence ?? clip.confidence))).toFixed(3),
          clip.chunkIndex,
          JSON.stringify({ sceneTags: clip.sceneTags, players: clip.players }),
        ],
      )
    }

    if (ffmpegAvail) {
      const midSecs    = (clip.timecodeIn + clip.timecodeOut) / 2
      const thumbKey   = `thumb-${clipId}.jpg`
      const tmpThumb   = join(tmpdir(), thumbKey)
      try {
        await generateClipThumbnail(videoSource, midSecs, tmpThumb)
        const thumbBuf = await readFile(tmpThumb)
        if (R2_READY) {
          await s3.send(new PutObjectCommand({
            Bucket: process.env.R2_BUCKET!,
            Key:    thumbKey,
            Body:   thumbBuf,
            ContentLength: thumbBuf.byteLength,
            ContentType:   'image/jpeg',
          }))
        } else {
          const { rename } = await import('node:fs/promises')
          await rename(tmpThumb, join(LOCAL_THUMBS_DIR, thumbKey)).catch(() => {})
        }
        await dbPool.query(`UPDATE clips SET thumb_key = $1 WHERE id = $2`, [thumbKey, clipId])
      } catch (thumbErr: any) {
        log(`Thumbnail failed for clip ${clipId}: ${thumbErr.message}`)
      } finally {
        await rm(tmpThumb, { force: true }).catch(() => {})
      }
    }
  }

  return { clipCount: allClips.length, inputTokens, outputTokens, estimatedCostUsd }
}

async function runRethumb(projectId: string, log: (message: string) => void) {
  if (!await hasFFmpeg()) throw new Error('ffmpeg is required for thumbnail generation')

  const clips = await dbPool.query(
    `SELECT c.id, c.timecode_in, c.timecode_out, sf.s3_key, sf.duration_secs
     FROM clips c JOIN source_files sf ON sf.id = c.source_file_id
     WHERE c.project_id = $1 AND c.thumb_key IS NULL`,
    [projectId],
  )
  const s3 = buildS3()
  mkdirSync(LOCAL_THUMBS_DIR, { recursive: true })

  for (const clip of clips.rows) {
    const source = R2_READY
      ? await presign(s3, clip.s3_key, 3600)
      : join(LOCAL_UPLOADS_DIR, clip.s3_key)
    const rawMid = (Number(clip.timecode_in) + Number(clip.timecode_out)) / 2
    const duration = Number(clip.duration_secs) || 0
    const mid = duration ? Math.min(rawMid, Math.max(0, duration - 0.5)) : Math.max(0, rawMid)
    const thumbKey = `thumb-${clip.id}.jpg`
    const tmpThumb = join(tmpdir(), thumbKey)
    try {
      await generateClipThumbnail(source, mid, tmpThumb)
      const body = await readFile(tmpThumb)
      if (R2_READY) {
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET!, Key: thumbKey, Body: body,
          ContentLength: body.byteLength, ContentType: 'image/jpeg',
        }))
      } else {
        const { rename } = await import('node:fs/promises')
        await rename(tmpThumb, join(LOCAL_THUMBS_DIR, thumbKey))
      }
      await dbPool.query(`UPDATE clips SET thumb_key = $1 WHERE id = $2`, [thumbKey, clip.id])
    } finally {
      await rm(tmpThumb, { force: true }).catch(() => {})
    }
  }
  log(`Generated ${clips.rows.length} thumbnails`)
}

async function healthCheck() {
  const checks: { name: string; ok: boolean; detail: string }[] = []

  // Redis
  try {
    await connection.ping()
    checks.push({ name: 'Redis', ok: true, detail: process.env.REDIS_URL ?? 'redis://localhost:6379' })
  } catch (e: any) {
    checks.push({ name: 'Redis', ok: false, detail: e.message })
  }

  // Postgres
  try {
    await dbPool.query('SELECT 1')
    checks.push({ name: 'Postgres', ok: true, detail: 'connected' })
  } catch (e: any) {
    checks.push({ name: 'Postgres', ok: false, detail: e.message })
  }

  // ffmpeg
  const ffmpegOk = await hasFFmpeg()
  checks.push({
    name: 'ffmpeg',
    ok: ffmpegOk,
    detail: ffmpegOk
      ? `found at ${process.env.FFMPEG_PATH ?? 'PATH'}`
      : 'not found — analysis and export jobs will fail',
  })

  // Anthropic key
  const hasKey = !!process.env.ANTHROPIC_API_KEY
  checks.push({
    name: 'ANTHROPIC_API_KEY',
    ok: hasKey,
    detail: hasKey ? 'set' : 'MISSING — Claude analysis will fail',
  })

  const width = 20
  console.log('\n[worker] ── startup health check ───────────────────────')
  for (const c of checks) {
    const icon   = c.ok ? '✓' : '✗'
    const label  = c.name.padEnd(width)
    console.log(`[worker]   ${icon} ${label} ${c.detail}`)
  }
  const allOk = checks.every(c => c.ok)
  console.log(`[worker] ────────────────────────────────────────────────`)
  if (!allOk) {
    console.warn('[worker] ⚠ one or more checks failed — see above')
  }
  console.log()
}

async function main() {
  await healthCheck()

  const analysisWorker = new Worker<AnalysisJobData>(
    'analysis',
    async (job) => {
      const { projectId, analysisMode } = job.data
      const log = (msg: string) => console.log(`[worker] job=${job.id} ${msg}`)
      const startedAt = Date.now()

      log(`Starting ${analysisMode} analysis for project ${projectId}`)

      const runResult = await dbPool.query(
        `INSERT INTO analysis_runs
           (project_id, source_file_id, status, pipeline_version, provider,
            model, prompt_version, parameters, started_at)
         VALUES ($1,$2,'running',$3,'anthropic',$4,$5,$6,NOW())
         RETURNING id`,
        [
          projectId,
          job.data.sourceFileId,
          PIPELINE_VERSION,
          ANALYSIS_MODEL,
          PROMPT_VERSION,
          JSON.stringify({
            analysisMode,
            quickSearchParams: job.data.quickSearchParams ?? null,
            chunkDurationSecs: CHUNK_DURATION_SECS,
            replaceExistingClips: !!job.data.replaceExistingClips,
          }),
        ],
      )
      const analysisRunId = runResult.rows[0].id as string

      await dbPool.query(
        `UPDATE jobs SET status = 'running', error = NULL, updated_at = NOW()
         WHERE bullmq_id = $1`,
        [String(job.id)],
      )
      await dbPool.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )

      try {
        const metrics = await runPipeline(job, analysisRunId, log)
        await dbPool.query(
          `UPDATE analysis_runs SET
             status = 'completed', input_tokens = $2, output_tokens = $3,
             estimated_cost_usd = $4, processing_ms = $5,
             completed_at = NOW()
           WHERE id = $1`,
          [
            analysisRunId, metrics.inputTokens, metrics.outputTokens,
            metrics.estimatedCostUsd.toFixed(6), Date.now() - startedAt,
          ],
        )

        await dbPool.query(
          `UPDATE jobs SET status = 'completed', updated_at = NOW()
           WHERE bullmq_id = $1`,
          [String(job.id)],
        )
        await dbPool.query(
          `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
          [projectId],
        )

        const projRow = await dbPool.query(`SELECT name, user_id FROM projects WHERE id = $1`, [projectId])
        const { name: projectName, user_id: userId } = projRow.rows[0] ?? {}
        await sendClipsReadyEmail(workerLog, projectId, projectName, userId).catch(() => {})
        log(`Done — ${metrics.clipCount} clips, project ${projectId} is ready`)
      } catch (err: any) {
        log(`Pipeline error: ${err.message}`)
        await dbPool.query(
          `UPDATE analysis_runs SET status = 'failed', error = $2,
             processing_ms = $3, completed_at = NOW() WHERE id = $1`,
          [analysisRunId, err.message.slice(0, 2000), Date.now() - startedAt],
        )
        throw err
      }
    },
    { connection, concurrency: 2 },
  )

  analysisWorker.on('failed', async (job, err) => {
    if (!job) return
    console.error(`[worker] Job ${job.id} failed:`, err.message)
    const maxAttempts = Number(job.opts.attempts ?? 1)
    if (job.attemptsMade < maxAttempts) {
      console.warn(`[worker] Job ${job.id} will retry (${job.attemptsMade}/${maxAttempts})`)
      return
    }
    await dbPool.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW()
       WHERE bullmq_id = $1`,
      [String(job.id), err.message],
    )
    await dbPool.query(
      `UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [job.data.projectId],
    )
  })

  const exportWorker = new Worker<ExportJobData>('exports', async (job) => {
    const log = (message: string) => console.log(`[export-worker] job=${job.id} ${message}`)
    await processExportJob(dbPool, job.data, log)
  }, { connection, concurrency: 1 })

  exportWorker.on('failed', async (job, err) => {
    console.error(`[export-worker] Job ${job?.id} failed:`, err.message)
    if (!job) return
    const maxAttempts = Number(job.opts.attempts ?? 1)
    const finalAttempt = job.attemptsMade >= maxAttempts
    await dbPool.query(
      `UPDATE exports SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`,
      [
        job.data.exportId,
        finalAttempt ? 'failed' : 'queued',
        finalAttempt ? err.message.slice(0, 2000) : null,
      ],
    )
  })

  const maintenanceWorker = new Worker<MaintenanceJobData>('maintenance', async (job) => {
    const log = (message: string) => console.log(`[maintenance-worker] job=${job.id} ${message}`)
    if (job.data.kind === 'rethumb') await runRethumb(job.data.projectId, log)
  }, { connection, concurrency: 1 })

  maintenanceWorker.on('failed', (job, err) => {
    console.error(`[maintenance-worker] Job ${job?.id} failed:`, err.message)
  })

  console.log('[worker] Listening for analysis, export, and maintenance jobs…')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
