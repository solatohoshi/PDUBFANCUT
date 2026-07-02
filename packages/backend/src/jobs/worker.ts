import { Worker } from 'bullmq'
import { Pool, neonConfig } from '@neondatabase/serverless'
import ws from 'ws'
import { connection } from './queue'
import type { AnalysisJobData } from './queue'

neonConfig.webSocketConstructor = ws
const pool = new Pool({ connectionString: process.env.DATABASE_URL! })

// ─── Scene catalogue ─────────────────────────────────────────────────────────

const ALL_SCENES = ['goal', 'save', 'shot_on_goal', 'hit', 'scrum', 'celebration', 'penalty', 'faceoff'] as const
type Scene = typeof ALL_SCENES[number]

// Typical frequency per scene type in a 60-minute game period
const SCENE_WEIGHTS: Record<Scene, number> = {
  shot_on_goal: 30,
  save:         25,
  hit:          20,
  faceoff:      15,
  goal:          5,
  penalty:       5,
  scrum:         4,
  celebration:   3,
}

// ─── Stub helpers ─────────────────────────────────────────────────────────────

function pickScene(allowed: Scene[]): Scene {
  const pool = allowed.filter(s => SCENE_WEIGHTS[s] !== undefined)
  const total = pool.reduce((n, s) => n + SCENE_WEIGHTS[s], 0)
  let r = Math.random() * total
  for (const s of pool) {
    r -= SCENE_WEIGHTS[s]
    if (r <= 0) return s
  }
  return pool[0]
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min)
}

interface StubClip {
  timecodeIn:  number
  timecodeOut: number
  sceneTags:   { tag: Scene; confidence: number }[]
  players:     { jersey: string; name: string; team: string }[]
  confidence:  number
}

/**
 * Step 1 — Frame sampling stub.
 * Returns estimated frame count and a simulated game duration in seconds.
 * Replace with real ffprobe call once GPU pipeline is wired.
 */
function stubFrameSample(analysisMode: string): { durationSecs: number; frameCount: number } {
  // Simulate a 2–3 hour game; quick search assumes we scoped to ≈20 min of footage
  const durationSecs = analysisMode === 'full' ? rand(6000, 10800) : rand(900, 2400)
  const frameCount   = Math.round(durationSecs) // 1 fps sample
  return { durationSecs, frameCount }
}

/**
 * Steps 2–6 — Detection stub.
 * Generates plausible clip events given the allowed scene types.
 * Replace each step with real model calls in Phase 2 proper.
 */
function stubDetect(
  durationSecs: number,
  allowedScenes: Scene[],
  requestedPlayers: string[],
): StubClip[] {
  // Scale clip count to duration; typical broadcast ≈ 1 notable event / 3 min
  const count = Math.round(durationSecs / 180) + Math.floor(rand(2, 8))
  const clips: StubClip[] = []

  // Spread events across the duration, avoiding the first 30 s (intros)
  const usableWindow = durationSecs - 30
  const step = usableWindow / count

  for (let i = 0; i < count; i++) {
    const base        = 30 + i * step + rand(-step * 0.4, step * 0.4)
    const timecodeIn  = Math.max(0, base - rand(2, 8))   // natural in-point
    const timecodeOut = timecodeIn + rand(8, 28)          // 8–28 s clip

    const primaryScene = pickScene(allowedScenes)
    const confidence   = rand(0.60, 0.98)

    // Multi-label: sometimes a save leads immediately into a shot on goal
    const sceneTags: { tag: Scene; confidence: number }[] = [
      { tag: primaryScene, confidence },
    ]
    if (Math.random() < 0.25) {
      const secondary = pickScene(allowedScenes.filter(s => s !== primaryScene))
      sceneTags.push({ tag: secondary, confidence: confidence - rand(0.05, 0.15) })
    }

    // Player stubs — use requested players if provided, else generate generics
    const players: StubClip['players'] = requestedPlayers.length > 0
      ? requestedPlayers.slice(0, 2).map(p => ({ jersey: p, name: p, team: 'unknown' }))
      : []

    clips.push({ timecodeIn, timecodeOut, sceneTags, players, confidence })
  }

  // Sort chronologically
  return clips.sort((a, b) => a.timecodeIn - b.timecodeIn)
}

// ─── Pipeline orchestrator ────────────────────────────────────────────────────

async function runPipeline(
  job: { data: AnalysisJobData },
  log: (msg: string) => void,
) {
  const { projectId, sourceFileId, analysisMode, quickSearchParams } = job.data

  // Determine which scene types and players to search for
  const allowedScenes: Scene[] =
    analysisMode === 'quick' && quickSearchParams?.scenes?.length
      ? (quickSearchParams.scenes as Scene[])
      : [...ALL_SCENES]

  const requestedPlayers: string[] =
    analysisMode === 'quick' ? (quickSearchParams?.players ?? []) : []

  // ── Step 1: Frame sampling ────────────────────────────────────────────────
  log('Step 1/7 — frame sampling')
  const { durationSecs } = stubFrameSample(analysisMode)

  // Write duration back to source_file for UI display
  await pool.query(
    `UPDATE source_files SET duration_secs = $2 WHERE id = $1`,
    [sourceFileId, durationSecs],
  )

  // ── Step 2: Team colour recognition (stub) ────────────────────────────────
  log('Step 2/7 — team colour recognition (stub)')
  await new Promise(r => setTimeout(r, 300))

  // ── Step 3: Player detection (stub) ──────────────────────────────────────
  log('Step 3/7 — player detection (stub)')
  await new Promise(r => setTimeout(r, 300))

  // ── Step 4: Scene classification (stub) ──────────────────────────────────
  log('Step 4/7 — scene classification (stub)')
  const detectedClips = stubDetect(durationSecs, allowedScenes, requestedPlayers)

  // ── Step 5: Audio event detection (stub) ─────────────────────────────────
  log('Step 5/7 — audio event detection (stub)')
  await new Promise(r => setTimeout(r, 200))

  // ── Step 6: Boundary detection (already applied in stubDetect) ───────────
  log('Step 6/7 — boundary detection (stub)')

  // ── Step 7: Clip packaging ────────────────────────────────────────────────
  log(`Step 7/7 — packaging ${detectedClips.length} clips`)
  for (const clip of detectedClips) {
    await pool.query(
      `INSERT INTO clips
         (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        projectId,
        sourceFileId,
        clip.timecodeIn.toFixed(3),
        clip.timecodeOut.toFixed(3),
        JSON.stringify(clip.sceneTags),
        JSON.stringify(clip.players),
        clip.confidence.toFixed(3),
      ],
    )
  }

  return detectedClips.length
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function main() {
  const worker = new Worker<AnalysisJobData>(
    'analysis',
    async (job) => {
      const { projectId, analysisMode } = job.data
      const log = (msg: string) => console.log(`[worker] job=${job.id} ${msg}`)

      log(`Starting ${analysisMode} analysis for project ${projectId}`)

      await pool.query(
        `UPDATE jobs SET status = 'running', updated_at = NOW()
         WHERE project_id = $1 AND status = 'pending'`,
        [projectId],
      )
      await pool.query(
        `UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )

      const clipCount = await runPipeline(job, log)

      await pool.query(
        `UPDATE jobs SET status = 'completed', updated_at = NOW()
         WHERE project_id = $1 AND status = 'running'`,
        [projectId],
      )
      await pool.query(
        `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
        [projectId],
      )

      log(`Done — ${clipCount} clips written, project ${projectId} is ready`)
    },
    { connection, concurrency: 2 },
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    console.error(`[worker] Job ${job.id} failed:`, err.message)
    await pool.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW()
       WHERE project_id = $1`,
      [job.data.projectId, err.message],
    )
    await pool.query(
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
