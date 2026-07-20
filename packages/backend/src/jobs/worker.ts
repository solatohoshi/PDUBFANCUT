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
import type { AnalysisJobData } from './queue'
import { analyzeVideoForClips } from '../lib/analyzeVideo'
import { hasFFmpeg, ffprobe, generateClipThumbnail } from '../lib/ffmpeg'
import { sendClipsReadyEmail } from '../lib/notify'

const dbPool = new Pool({ connectionString: process.env.DATABASE_URL! })
const execFileAsync = promisify(execFile)

const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg'
const CHUNK_DURATION_SECS = 300 // 5-minute chunks

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
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

async function runPipeline(job: { data: AnalysisJobData }, log: (msg: string) => void): Promise<number> {
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
    sceneTags: any[]; players: any[]; confidence: number
  }[] = []

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

        const chunkClips = await analyzeVideoForClips(
          { type: 'file', path: chunkPath, mimeType: 'video/mp4' },
          chunkDuration,
        )

        for (const clip of chunkClips) {
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
          })
        }
      } finally {
        await rm(chunkPath, { force: true }).catch(() => {})
      }
    }
  } else {
    // ffmpeg unavailable or duration unknown — send full video to Claude directly
    log('Steps 2–6 — ffmpeg unavailable; sending full video to Claude')
    try {
      const source = R2_READY
        ? { type: 'url' as const, url: videoSource }
        : { type: 'file' as const, path: videoSource, mimeType: 'video/mp4' }
      const rawClips = await analyzeVideoForClips(source, durationSecs || undefined)
      for (const clip of rawClips) {
        allClips.push({
          timecodeIn:  clip.timecode_in,
          timecodeOut: clip.timecode_out,
          sceneTags:   clip.scene_tags,
          players:     clip.players,
          confidence:  clip.confidence,
        })
      }
    } catch (err: any) {
      log(`Claude direct analysis failed: ${err.message}`)
    }
  }

  log(`Step 6/7 — boundary detection complete, ${allClips.length} clips`)

  // ── Step 7: Clip packaging + thumbnails ───────────────────────────────────
  log(`Step 7/7 — packaging ${allClips.length} clips`)
  mkdirSync(LOCAL_THUMBS_DIR, { recursive: true })

  for (const clip of allClips) {
    const insertRes = await dbPool.query(
      `INSERT INTO clips
         (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto')
       RETURNING id`,
      [
        projectId, sourceFileId,
        clip.timecodeIn.toFixed(3),  clip.timecodeOut.toFixed(3),
        JSON.stringify(clip.sceneTags), JSON.stringify(clip.players),
        Math.min(1, Math.max(0, clip.confidence)).toFixed(3),
      ],
    )
    const clipId: string = insertRes.rows[0].id

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

  return allClips.length
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
      : 'not found — chunking disabled, short-clip fallback only',
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

  const worker = new Worker<AnalysisJobData>(
    'analysis',
    async (job) => {
      const { projectId, analysisMode } = job.data
      const log = (msg: string) => console.log(`[worker] job=${job.id} ${msg}`)

      log(`Starting ${analysisMode} analysis for project ${projectId}`)

      await dbPool.query(
        `UPDATE jobs SET status = 'running', updated_at = NOW()
         WHERE project_id = $1 AND status = 'pending'`,
        [projectId],
      )
      await dbPool.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )

      let clipCount = 0
      try {
        clipCount = await runPipeline(job, log)
      } catch (err: any) {
        log(`Pipeline error: ${err.message}`)
        throw err // BullMQ will retry per job config
      }

      await dbPool.query(
        `UPDATE jobs SET status = 'completed', updated_at = NOW()
         WHERE project_id = $1 AND status = 'running'`,
        [projectId],
      )
      await dbPool.query(
        `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )

      const projRow = await dbPool.query(
        `SELECT name, user_id FROM projects WHERE id = $1`,
        [projectId],
      )
      const { name: projectName, user_id: userId } = projRow.rows[0] ?? {}
      await sendClipsReadyEmail(workerLog, projectId, projectName, userId).catch(() => {})

      log(`Done — ${clipCount} clips, project ${projectId} is ready`)
    },
    { connection, concurrency: 2 },
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    console.error(`[worker] Job ${job.id} failed:`, err.message)
    await dbPool.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW()
       WHERE project_id = $1`,
      [job.data.projectId, err.message],
    )
    await dbPool.query(
      `UPDATE projects SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [job.data.projectId],
    )
  })

  console.log('[worker] Listening for analysis jobs…')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
