import { execFile, spawn } from 'node:child_process'
import { promisify }       from 'node:util'
import { tmpdir }          from 'node:os'
import { join }            from 'node:path'
import { rm, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
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

export interface ColorAdjust {
  brightness?: number  // -1..1, default 0 (ffmpeg eq brightness)
  contrast?:   number   // -1..1, default 0 (ffmpeg eq contrast = 1 + value)
  saturation?: number  // -1..1, default 0 (ffmpeg eq saturation = 1 + value)
  hue?:        number    // -180..180 degrees, default 0 (ffmpeg hue=h=)
}

export interface TimelineSlotForRender {
  sourceFileId: string
  tcIn:       number
  tcOut:      number
  trimStart?: number
  trimEnd?:   number
  speed?:     number
  colorAdjust?: ColorAdjust
}

/**
 * ffmpeg's `atempo` filter only accepts a factor in [0.5, 2.0] per instance.
 * To reach an arbitrary continuous speed (our UI allows 0.1×–4×) we chain
 * multiple `atempo` stages whose product equals the requested factor, each
 * clamped to that range — the standard workaround for out-of-range atempo.
 */
export function buildAtempoChain(speed: number): string {
  if (speed === 1) return 'aresample=48000'
  const stages: number[] = []
  let remaining = speed
  while (remaining > 2.0) {
    stages.push(2.0)
    remaining /= 2.0
  }
  while (remaining < 0.5) {
    stages.push(0.5)
    remaining /= 0.5
  }
  stages.push(remaining)
  return stages.map((s) => `atempo=${s.toFixed(6)}`).join(',')
}

export interface Caption {
  text:  string
  style: 'caption' | 'lower-third' | 'title'
  /** Position in the OUTPUT timeline (same absolute-seconds domain as the
   * concatenated, speed-adjusted export — matches the editor's shared
   * multi-track timeline exactly, so a caption dragged to line up with a
   * clip in the UI lands on that same clip in the render). */
  startSecs:    number
  durationSecs: number
}

export interface MusicTrack {
  url:              string  // presigned/local URL for the audio file
  volume:           number  // 0..1 relative level mixed under the clips' own audio
  startSecs:        number  // position in the output timeline where playback begins
  trimStart:        number  // seconds trimmed off the front of the source file
  trimEnd:          number  // seconds trimmed off the back of the source file
  fileDurationSecs: number  // full duration of the uploaded file (for computing -t)
}

export interface RenderParams {
  exportId:       string
  preset:         Preset
  timeline:       TimelineSlotForRender[]
  captions?:      Caption[]
  music?:         MusicTrack | null
  getPresignedUrl: (sourceFileId: string) => Promise<string>
  s3:             S3Client
  bucket:         string
  outputKey:      string
}

// Text-overlay layout per style — mirrors the editor's live preview
// (PreviewPlayer.tsx OVERLAY_ZONE_STYLE/OVERLAY_LINE_STYLE) so what you see
// while editing matches what gets burned into the export. `yExpr` is an
// ffmpeg expression evaluated against the *output* frame, so it holds up
// across every preset's aspect ratio without knowing pixel dimensions.
const CAPTION_Y_EXPR: Record<Caption['style'], string> = {
  title:         'h*0.10',
  'lower-third': 'h*0.76',
  caption:       'h*0.88',
}
const CAPTION_FONT_FRACTION: Record<Caption['style'], number> = {
  title: 0.055,
  'lower-third': 0.032,
  caption: 0.030,
}
// Used only for the 'fullres' preset, where output dimensions aren't known
// ahead of render time (native source resolution) — assumes a ~1080p-ish
// output, which is the common case for source hockey footage today.
const CAPTION_FALLBACK_FONTSIZE: Record<Caption['style'], number> = {
  title: 64,
  'lower-third': 38,
  caption: 36,
}
const CAPTION_HAS_BOX: Record<Caption['style'], boolean> = {
  title: false,
  'lower-third': true,
  caption: true,
}
const CAPTION_STYLE_ORDER: Caption['style'][] = ['title', 'lower-third', 'caption']

const FONT_CANDIDATES = [
  process.env.DRAWTEXT_FONT_PATH,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/ubuntu/Ubuntu-Bold.ttf',
].filter((p): p is string => !!p)

/** Finds a usable bold system font for drawtext. Returns null (caller should
 * skip burning captions rather than fail the export) if none exist — a
 * missing font shouldn't break an otherwise-successful render. */
function resolveFontPath(): string | null {
  for (const p of FONT_CANDIDATES) {
    if (existsSync(p)) return p
  }
  return null
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
  exportId, preset, timeline, captions, music, getPresignedUrl, s3, bucket, outputKey,
}: RenderParams): Promise<void> {
  const outputPath = join(tmpdir(), `pwhl_export_${exportId}.mp4`)
  const captionTmpFiles: string[] = []

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

    // Background music, if any, becomes the last input — seeked/trimmed to
    // exactly the window the user selected on the timeline (mirrors how
    // video clips are trimmed), then shifted into position with `adelay`
    // below rather than relying on ffmpeg to loop or auto-align it.
    const musicInputIdx = timeline.length
    if (music) {
      const usedDur = Math.max(0.1, music.fileDurationSecs - music.trimStart - music.trimEnd)
      args.push('-ss', music.trimStart.toFixed(3), '-t', usedDur.toFixed(3), '-i', music.url)
    }

    // filter_complex: normalise fps + apply speed per segment, then concat
    const N = timeline.length
    const filterParts: string[] = []

    for (let i = 0; i < N; i++) {
      const speed = timeline[i].speed ?? 1
      // setpts=(1/speed)*PTS: speed=2 → half the pts duration → doubles playback speed
      const videoStages = ['fps=30', `setpts=${(1 / speed).toFixed(6)}*PTS`]

      const ca = timeline[i].colorAdjust
      const brightness = ca?.brightness ?? 0
      const contrast   = ca?.contrast   ?? 0
      const saturation = ca?.saturation ?? 0
      const hue        = ca?.hue        ?? 0
      if (brightness !== 0 || contrast !== 0 || saturation !== 0) {
        videoStages.push(
          `eq=brightness=${brightness.toFixed(3)}:contrast=${(1 + contrast).toFixed(3)}:saturation=${(1 + saturation).toFixed(3)}`,
        )
      }
      if (hue !== 0) {
        videoStages.push(`hue=h=${hue.toFixed(1)}`)
      }

      filterParts.push(`[${i}:v]${videoStages.join(',')}[v${i}]`)
      filterParts.push(`[${i}:a]${buildAtempoChain(speed)}[a${i}]`)
    }

    const concatPairs = Array.from({ length: N }, (_, i) => `[v${i}][a${i}]`).join('')
    filterParts.push(`${concatPairs}concat=n=${N}:v=1:a=1[outv][outa]`)

    // Mix background music under the concatenated clip audio. `normalize=0`
    // keeps amix from auto-attenuating both inputs to avoid clipping — we
    // control relative loudness ourselves via the music-only `volume` stage,
    // so the clips' own audio stays at its original level. `adelay` shifts
    // the (already trimmed) music so it starts at the same output-timeline
    // position the user dragged it to in the editor.
    let audioOutLabel = 'outa'
    if (music) {
      const vol = Math.max(0, Math.min(1, music.volume))
      const delayMs = Math.max(0, Math.round(music.startSecs * 1000))
      filterParts.push(`[${musicInputIdx}:a]aresample=48000,volume=${vol.toFixed(3)},adelay=${delayMs}|${delayMs}[music]`)
      filterParts.push(`[outa][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixedout]`)
      audioOutLabel = 'mixedout'
    }

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

    // Burn in text overlays (if any) — chained after scale/pad so drawtext's
    // `w`/`h` expressions refer to the final output frame, not the source.
    let videoOutLabel = 'final'
    const nonEmptyCaptions = (captions ?? []).filter((c) => c.text.trim() !== '')
    if (nonEmptyCaptions.length > 0) {
      const fontPath = resolveFontPath()
      if (!fontPath) {
        console.warn('[ffmpeg] No system font found for text overlays — skipping captions for this export. Set DRAWTEXT_FONT_PATH to override.')
      } else {
        // Each caption already carries an absolute position in the same
        // output-timeline domain the editor's shared multi-track view uses
        // (see Caption.startSecs) — no per-clip lookup needed, just an
        // `enable` window straight from the values the user dragged to.
        let stageIdx = 0
        const sorted = [...nonEmptyCaptions].sort(
          (a, b) => CAPTION_STYLE_ORDER.indexOf(a.style) - CAPTION_STYLE_ORDER.indexOf(b.style),
        )
        for (const c of sorted) {
          const start = Math.max(0, c.startSecs)
          const dur   = Math.max(0.1, c.durationSecs)
          const end   = start + dur

          const textFilePath = join(tmpdir(), `pwhl_caption_${exportId}_${stageIdx}.txt`)
          await writeFile(textFilePath, c.text.trim(), 'utf8')
          captionTmpFiles.push(textFilePath)

          const fontSize = dims ? Math.round(dims.h * CAPTION_FONT_FRACTION[c.style]) : CAPTION_FALLBACK_FONTSIZE[c.style]
          const boxArgs  = CAPTION_HAS_BOX[c.style] ? ':box=1:boxcolor=black@0.55:boxborderw=14' : ''
          const nextLabel = `txt${stageIdx}`

          filterParts.push(
            `[${videoOutLabel}]drawtext=fontfile='${fontPath}':textfile='${textFilePath}':` +
            `fontcolor=white:fontsize=${fontSize}:x=(w-text_w)/2:y=${CAPTION_Y_EXPR[c.style]}:` +
            `line_spacing=6:expansion=none${boxArgs}:enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'[${nextLabel}]`,
          )
          videoOutLabel = nextLabel
          stageIdx++
        }
      }
    }

    args.push('-filter_complex', filterParts.join(';'))
    args.push('-map', `[${videoOutLabel}]`)
    args.push('-map', `[${audioOutLabel}]`)
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
    await Promise.all(captionTmpFiles.map((f) => rm(f, { force: true }).catch(() => {})))
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

export interface ExtractedFrame {
  time: number
  path: string
}

/**
 * Sample JPEG frames from a video at an even interval for Claude vision analysis
 * (the Messages API has no native video content type — video is analyzed as a
 * sequence of image frames). Returns frames in a caller-owned temp directory;
 * the caller is responsible for deleting `dirname(frames[0].path)` when done.
 */
export async function extractFrames(
  videoSource: string,
  durationSecs: number | undefined,
  maxFrames = 20,
): Promise<ExtractedFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'pwhl-frames-'))
  const MIN_INTERVAL_SECS = 2
  const interval = durationSecs && durationSecs > 0
    ? Math.max(MIN_INTERVAL_SECS, durationSecs / maxFrames)
    : 5
  const frameCount = durationSecs && durationSecs > 0
    ? Math.min(maxFrames, Math.max(1, Math.ceil(durationSecs / interval)))
    : maxFrames

  await execFileAsync(
    FFMPEG_BIN,
    [
      '-y',
      '-i', videoSource,
      '-vf', `fps=1/${interval.toFixed(3)},scale=768:-2`,
      '-frames:v', String(frameCount),
      '-q:v', '4',
      join(dir, 'frame-%03d.jpg'),
    ],
    { timeout: 120_000 },
  )

  const files = (await readdir(dir)).filter((f) => f.endsWith('.jpg')).sort()
  return files.map((f, i) => ({ time: i * interval, path: join(dir, f) }))
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
