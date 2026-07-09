import Anthropic from '@anthropic-ai/sdk'
import { readFile } from 'node:fs/promises'

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

  const client = new Anthropic({ apiKey })

  // VideoBlockParam isn't typed in SDK 0.110.0 — use a local shape and cast at call site.
  type VideoBlockParam = {
    type: 'video'
    source: { type: 'url'; url: string } | { type: 'base64'; media_type: string; data: string }
  }
  let videoBlock: VideoBlockParam
  if (source.type === 'url') {
    videoBlock = {
      type: 'video',
      source: { type: 'url', url: source.url },
    }
  } else {
    const buf = await readFile(source.path)
    videoBlock = {
      type: 'video',
      source: {
        type: 'base64',
        media_type: source.mimeType ?? 'video/mp4',
        data: buf.toString('base64'),
      },
    }
  }

  const durationHint = durationSecs
    ? `This video file is exactly ${durationSecs.toFixed(1)} seconds long (from 0.0 to ${durationSecs.toFixed(1)}).`
    : ''

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8192,
    tools: [{
      name: 'report_clips',
      description: 'Report all key hockey moments identified in the video',
      input_schema: CLIP_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'report_clips' },
    messages: [{
      role: 'user',
      content: [
        videoBlock as any,
        {
          type: 'text',
          text: `You are analyzing a PWHL (Professional Women's Hockey League) video clip.
${durationHint}

CRITICAL: timecode_in and timecode_out are seconds from the VERY FIRST FRAME of this video file — NOT broadcast game-clock times, NOT period times, NOT any on-screen scoreboard timestamps. The first frame of the file is always 0.0. ${durationSecs ? `All values MUST be between 0.0 and ${durationSecs.toFixed(1)}.` : ''}

Identify every significant hockey action moment in the video. For each moment output:
- timecode_in / timecode_out: seconds from the start of the FILE (first frame = 0.0), precise to 0.5 s
- scene_tags: array of {tag, confidence} objects. Valid tags: "shot_on_goal", "save", "goal", "blocked_shot", "hit", "penalty", "faceoff", "power_play", "breakaway", "icing", "offsides", "turnover", "pass"
- players: any visible jersey numbers / player names / team colours you can determine
- confidence: overall clip quality score 0.0–1.0 (1.0 = unmistakable, clear action)

If the entire video is a single play, return it as one clip covering 0.0 to the end. Every clip must be at least 1 second. Do not skip any action.`,
        },
      ],
    }],
  })

  const toolBlock = response.content.find((b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use')
  if (!toolBlock) throw new Error('Claude returned no tool call — no clips extracted')

  const { clips } = toolBlock.input as { clips: AnalyzedClip[] }
  return Array.isArray(clips) ? clips : []
}
