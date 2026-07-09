import { execFile, spawn } from 'node:child_process'
import { promisify }       from 'node:util'
import { tmpdir }          from 'node:os'
import { join }            from 'node:path'
import { rm }              from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

const execFileAsync = promisify(execFile)

// Allow overriding binary paths via env (useful when not in PATH)
const FFMPEG_BIN  = process.env.FFMPEG_PATH  ?? 'ffmpeg'
const FFPROBE_BIN = process.env.FFPROBE_PATH ?? 'ffprobe'

const PRESET_DIMS = {
  tiktok:    { w: 1080, h: 1920 },
  twitter:   { w: 1920, h: 1080 },
  instagram: { w: 1080, h: 1080 },
  fullres:   null,
} as const

export type Preset = keyof typeof PRESET_DIMS

export interface SourceMeta {
  duration_secs: number
  codec: string | null
  width:  number | null
  height: number | null
}

export interface TimelineSlotForRender {
  sourceFileId: string
  tcIn:       number
  tcOut:      number
  trimStart?: number
  trimEnd?:   number
  speed?:     number
}

export interface RenderParams {
  exportId:       string
  preset:         Preset
  timeline:       TimelineSlotForRender[]
  getPresignedUrl: (sourceFileId: string) => Promise<string>
  s3:             S3Client
  bucket:         string
  outputKey:      string
}

/** Returns true if ffmpeg/ffprobe are found in PATH (or at FFMPEG_PATH). */
export async function hasFFmpeg(): Promise<boolean> {
  try {
    await execFileAsync(FFMPEG_BIN, ['-version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * Run ffprobe on an HTTP(S) URL and return media metadata.
 * Returns null if ffprobe fails or the URL is unreachable.
 */
export async function ffprobe(url: string): Promise<SourceMeta | null> {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      url,
    ], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })

    const info = JSON.parse(stdout)
    const streams = (info.streams ?? []) as any[]
    const videoStream = streams.find((s: any) => s.codec_type === 'video')
    const duration = parseFloat(info.format?.duration ?? '0')

    return {
      duration_secs: isNaN(duration) ? 0 : duration,
      codec:  videoStream?.codec_name ?? null,
      width:  videoStream?.width  ?? null,
      height: videoStream?.height ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Cut, speed-adjust, scale/pad, and concatenate timeline clips using FFmpeg.
 * Uploads the resulting MP4 to R2 under outputKey.
 *
 * Presigned URLs are provided by the caller so this function stays
 * independent of the S3 config details.
 */
export async function renderTimeline({
  exportId, preset, timeline, getPresignedUrl, s3, bucket, outputKey,
}: RenderParams): Promise<void> {
  const outputPath = join(tmpdir(), `pwhl_export_${exportId}.mp4`)

  try {
    // Resolve a presigned URL for each unique source file
    const urlMap = new Map<string, string>()
    for (const slot of timeline) {
      if (!urlMap.has(slot.sourceFileId)) {
        urlMap.set(slot.sourceFileId, await getPresignedUrl(slot.sourceFileId))
      }
    }

    const args: string[] = ['-y']

    // One input per clip (fast seek BEFORE -i for keyframe-aligned decode)
    for (const slot of timeline) {
      const eIn  = slot.tcIn  + (slot.trimStart ?? 0)
      const eOut = slot.tcOut - (slot.trimEnd   ?? 0)
      args.push('-ss', eIn.toFixed(3), '-to', eOut.toFixed(3))
      args.push('-i', urlMap.get(slot.sourceFileId)!)
    }

    // filter_complex: normalise fps + apply speed per segment, then concat
    const N = timeline.length
    const filterParts: string[] = []

    for (let i = 0; i < N; i++) {
      const speed = timeline[i].speed ?? 1
      // setpts=(1/speed)*PTS: speed=2 → half the pts duration → doubles playback speed
      filterParts.push(
        `[${i}:v]fps=30,setpts=${(1 / speed).toFixed(6)}*PTS[v${i}]`,
      )
      // atempo only accepts 0.5–2.0; chain two filters for 0.25×
      if (speed === 0.25) {
        filterParts.push(`[${i}:a]atempo=0.5,atempo=0.5[a${i}]`)
      } else if (speed !== 1) {
        filterParts.push(`[${i}:a]atempo=${speed.toFixed(6)}[a${i}]`)
      } else {
        filterParts.push(`[${i}:a]aresample=48000[a${i}]`)
      }
    }

    const concatPairs = Array.from({ length: N }, (_, i) => `[v${i}][a${i}]`).join('')
    filterParts.push(`${concatPairs}concat=n=${N}:v=1:a=1[outv][outa]`)

    // Scale + letterbox/pillarbox to target preset
    const dims = PRESET_DIMS[preset]
    if (dims) {
      filterParts.push(
        `[outv]scale=${dims.w}:${dims.h}:force_original_aspect_ratio=decrease,` +
        `pad=${dims.w}:${dims.h}:(ow-iw)/2:(oh-ih)/2:black[final]`,
      )
    } else {
      // fullres: just ensure even pixel counts
      filterParts.push('[outv]scale=trunc(iw/2)*2:trunc(ih/2)*2[final]')
    }

    args.push('-filter_complex', filterParts.join(';'))
    args.push('-map', '[final]')
    args.push('-map', '[outa]')
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23')
    args.push('-c:a', 'aac', '-b:a', '128k')
    args.push('-movflags', '+faststart')
    args.push(outputPath)

    await runFFmpegProcess(args)

    // Upload finished file to R2
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key:    outputKey,
      Body:   createReadStream(outputPath),
      ContentType: 'video/mp4',
    }))
  } finally {
    await rm(outputPath, { force: true }).catch(() => {})
  }
}

/**
 * Extract a single JPEG frame from a video at `timeSecs` seconds in.
 * `videoSource` may be a local file path or an HTTP(S) URL.
 */
export async function generateClipThumbnail(
  videoSource: string,
  timeSecs: number,
  outputPath: string,
): Promise<void> {
  // Use slow seek (-ss after -i) so seeking past EOF just returns the last frame.
  await execFileAsync(
    FFMPEG_BIN,
    [
      '-y',
      '-i', videoSource,
      '-ss', timeSecs.toFixed(3),
      '-vframes', '1',
      '-q:v', '3',
      '-vf', 'scale=480:-2,format=yuvj420p',
      outputPath,
    ],
    { timeout: 60_000 },
  )
}

function runFFmpegProcess(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 10_000) stderr = stderr.slice(-10_000)
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`))
    })
    proc.on('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(`Failed to start ffmpeg: ${err.message}`)),
    )
  })
}
