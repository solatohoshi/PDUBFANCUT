import Anthropic from '@anthropic-ai/sdk'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { extractFrames, hasFFmpeg } from './ffmpeg'

export interface AnalyzedClip {
  timecode_in: number
  timecode_out: number
  scene_tags: { tag: string; confidence: number }[]
  players: { jersey: string; name: string; team: string }[]
  confidence: number
}

const CLIP_SCHEMA = {
  type: 'object' as const,
  required: ['clips'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        required: ['timecode_in', 'timecode_out', 'scene_tags', 'players', 'confidence'],
        properties: {
          timecode_in:  { type: 'number', description: 'Clip start time in seconds from video beginning' },
          timecode_out: { type: 'number', description: 'Clip end time in seconds from video beginning' },
          scene_tags: {
            type: 'array',
            items: {
              type: 'object',
              required: ['tag', 'confidence'],
              properties: {
                tag:        { type: 'string' },
                confidence: { type: 'number' },
              },
            },
          },
          players: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                jersey: { type: 'string' },
                name:   { type: 'string' },
                team:   { type: 'string' },
              },
            },
          },
          confidence: { type: 'number', description: 'Overall clip confidence 0.0–1.0' },
        },
      },
    },
  },
}

export async function analyzeVideoForClips(
  source:
    | { type: 'url';  url: string }
    | { type: 'file'; path: string; mimeType?: string },
  durationSecs?: number,
): Promise<AnalyzedClip[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  // The Messages API has no native video content type. Video is analyzed as a
  // sequence of sampled JPEG frames sent as `image` blocks, which requires ffmpeg.
  if (!(await hasFFmpeg())) {
    throw new Error('ffmpeg is required for video analysis (frame extraction) but was not found')
  }

  const client = new Anthropic({ apiKey })

  const videoInput = source.type === 'url' ? source.url : source.path
  const frames = await extractFrames(videoInput, durationSecs)
  if (frames.length === 0) {
    throw new Error('Failed to extract any frames from the video for analysis')
  }

  try {
    const durationHint = durationSecs
      ? `This video file is exactly ${durationSecs.toFixed(1)} seconds long (from 0.0 to ${durationSecs.toFixed(1)}).`
      : ''

    const content: Anthropic.Messages.ContentBlockParam[] = []
    for (const frame of frames) {
      const buf = await readFile(frame.path)
      content.push({ type: 'text', text: `Frame at t=${frame.time.toFixed(1)}s` })
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
      })
    }
    content.push({
      type: 'text',
      text: `You are analyzing sampled frames from a PWHL (Professional Women's Hockey League) video clip.
${durationHint}
The frames above are sampled at regular intervals from the video and labeled with their timestamp in seconds from the start of the file (first frame = 0.0).

CRITICAL: timecode_in and timecode_out are seconds from the VERY FIRST FRAME of this video file — NOT broadcast game-clock times, NOT period times, NOT any on-screen scoreboard timestamps. ${durationSecs ? `All values MUST be between 0.0 and ${durationSecs.toFixed(1)}.` : ''}

Identify every significant hockey action moment visible across the sampled frames. For each moment output:
- timecode_in / timecode_out: seconds from the start of the FILE (first frame = 0.0), inferred from the timestamps of the frames showing the action
- scene_tags: array of {tag, confidence} objects. Valid tags: "shot_on_goal", "save", "goal", "blocked_shot", "hit", "penalty", "faceoff", "power_play", "breakaway", "icing", "offsides", "turnover", "pass"
- players: any visible jersey numbers / player names / team colours you can determine
- confidence: overall clip quality score 0.0–1.0 (1.0 = unmistakable, clear action)

If the entire video is a single play, return it as one clip covering 0.0 to the end. Every clip must be at least 1 second. Do not skip any action visible in the frames.`,
    })

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8192,
      tools: [{
        name: 'report_clips',
        description: 'Report all key hockey moments identified in the video',
        input_schema: CLIP_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: 'report_clips' },
      messages: [{ role: 'user', content }],
    })

    const toolBlock = response.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
    if (!toolBlock) throw new Error('Claude returned no tool call — no clips extracted')

    const { clips } = toolBlock.input as { clips: AnalyzedClip[] }
    return Array.isArray(clips) ? clips : []
  } finally {
    await rm(dirname(frames[0].path), { recursive: true, force: true }).catch(() => {})
  }
}
