import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Pool } from 'pg'
import { hasFFmpeg, renderTimeline } from './ffmpeg'
import type { Caption, ColorAdjust, Preset } from './ffmpeg'
import type { ExportJobData } from '../jobs/queue'

interface TimelineSlot {
  sourceFileId?: string
  clipId?: string
  tcIn: number
  tcOut: number
  trimStart?: number
  trimEnd?: number
  speed?: number
  colorAdjust?: ColorAdjust
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

export async function processExportJob(
  db: Pool,
  data: ExportJobData,
  log: (message: string) => void,
): Promise<void> {
  const { exportId, projectId, preset } = data
  const outputKey = `exports/${exportId}/output.mp4`
  const bucket = process.env.R2_BUCKET
  const r2Ready = !!(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY && bucket
  )

  await db.query(`UPDATE exports SET status = 'rendering', updated_at = NOW() WHERE id = $1`, [exportId])
  if (!r2Ready) throw new Error('R2 storage is required for export rendering')
  if (!await hasFFmpeg()) throw new Error('ffmpeg is required for export rendering')

  const timeline = data.timeline as TimelineSlot[]
  const resolved = await resolveSourceFiles(db, projectId, timeline)
  if (resolved.length !== timeline.length) {
    throw new Error('One or more timeline sources could not be resolved')
  }

  const s3 = makeS3()
  async function getPresignedUrl(sourceFileId: string): Promise<string> {
    const source = await db.query(
      `SELECT sf.s3_key
       FROM source_files sf WHERE sf.id = $1 AND sf.project_id = $2`,
      [sourceFileId, projectId],
    )
    const key = source.rows[0]?.s3_key
    if (!key) throw new Error(`No source object for ${sourceFileId}`)
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket!, Key: key }), { expiresIn: 7200 })
  }

  const musicRow = await db.query(
    `SELECT s3_key, duration_secs, start_secs, trim_start, trim_end
     FROM project_music WHERE project_id = $1`,
    [projectId],
  )
  const musicMeta = musicRow.rows[0]
  const music = musicMeta?.s3_key && Number(musicMeta.duration_secs) > 0
    ? {
        url: await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: bucket!, Key: musicMeta.s3_key }),
          { expiresIn: 7200 },
        ),
        volume: data.musicVolume,
        startSecs: Number(musicMeta.start_secs) || 0,
        trimStart: Number(musicMeta.trim_start) || 0,
        trimEnd: Number(musicMeta.trim_end) || 0,
        fileDurationSecs: Number(musicMeta.duration_secs),
      }
    : null

  await renderTimeline({
    exportId,
    preset: preset as Preset,
    timeline: resolved,
    captions: data.captions as Caption[],
    music,
    getPresignedUrl,
    s3,
    bucket: bucket!,
    outputKey,
  })

  await db.query(
    `UPDATE exports SET status = 'done', output_key = $2, error = NULL, updated_at = NOW() WHERE id = $1`,
    [exportId, outputKey],
  )
  log(`Export ${exportId} rendered`)
}

async function resolveSourceFiles(db: Pool, projectId: string, timeline: TimelineSlot[]) {
  const resolved: Array<{
    sourceFileId: string
    tcIn: number
    tcOut: number
    trimStart: number
    trimEnd: number
    speed: number
    colorAdjust?: ColorAdjust
  }> = []

  for (const slot of timeline) {
    let sourceFileId = slot.sourceFileId
    if (!sourceFileId && slot.clipId) {
      const clip = await db.query(
        `SELECT source_file_id FROM clips WHERE id = $1 AND project_id = $2`,
        [slot.clipId, projectId],
      )
      sourceFileId = clip.rows[0]?.source_file_id
    }
    if (!sourceFileId) continue
    resolved.push({
      sourceFileId,
      tcIn: slot.tcIn,
      tcOut: slot.tcOut,
      trimStart: slot.trimStart ?? 0,
      trimEnd: slot.trimEnd ?? 0,
      speed: slot.speed ?? 1,
      colorAdjust: slot.colorAdjust,
    })
  }
  return resolved
}
