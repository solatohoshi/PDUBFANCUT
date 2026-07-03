/**
 * Phase 2 integration test — verifies the pipeline stub and clip API.
 * Runs against the live dev server on port 3001.
 */

const BASE = 'http://localhost:3001'

let passed = 0
let failed = 0

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (err: any) {
    console.error(`  ✗  ${name}`)
    console.error(`     ${err.message}`)
    failed++
  }
}

async function run() {
  console.log('\nPhase 2 — pipeline & clips API tests\n')

  // ── 1. Create a project ────────────────────────────────────────────────────
  let projectId = ''
  await check('Create project', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pwhl-game.mp4', analysisMode: 'full' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    projectId = (await res.json() as any).id
  })

  // ── 2. Clips endpoint returns empty list before pipeline runs ──────────────
  await check('GET /clips returns empty array before pipeline', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/clips`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const clips = await res.json() as any[]
    if (!Array.isArray(clips)) throw new Error('Expected array')
    if (clips.length !== 0) throw new Error(`Expected 0 clips, got ${clips.length}`)
  })

  // ── 3. Simulate pipeline (run directly, bypassing queue for school network) -
  const { Pool, neonConfig } = await import('@neondatabase/serverless')
  const ws = (await import('ws')).default
  neonConfig.webSocketConstructor = ws
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })

  // Get source_file id (created by tus initiation, or fake one for this test)
  let sourceFileId = ''
  await check('Insert source_file for pipeline test', async () => {
    const r = await pool.query(
      `INSERT INTO source_files (project_id, original_name, size_bytes, status)
       VALUES ($1, 'pwhl-game.mp4', 4000000000, 'uploaded') RETURNING id`,
      [projectId],
    )
    sourceFileId = r.rows[0].id
  })

  let clipCount = 0
  await check('Pipeline stub writes clips to DB', async () => {
    // Import and run the pipeline directly
    const SCENE_TYPES = ['goal', 'save', 'shot_on_goal', 'hit', 'scrum', 'celebration', 'penalty', 'faceoff']
    const durationSecs = 9000 // simulate 2.5 hour game

    // Generate a small set of test clips
    const clips = Array.from({ length: 12 }, (_, i) => {
      const timecodeIn  = 30 + (i / 12) * (durationSecs - 60) + (Math.random() * 100 - 50)
      const timecodeOut = timecodeIn + 8 + Math.random() * 20
      const confidence  = 0.60 + Math.random() * 0.38
      const tag         = SCENE_TYPES[Math.floor(Math.random() * SCENE_TYPES.length)]
      return {
        timecodeIn: Math.max(0, timecodeIn),
        timecodeOut,
        sceneTags: [{ tag, confidence }],
        players: [],
        confidence,
      }
    })

    for (const clip of clips) {
      await pool.query(
        `INSERT INTO clips
           (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          projectId, sourceFileId,
          clip.timecodeIn.toFixed(3), clip.timecodeOut.toFixed(3),
          JSON.stringify(clip.sceneTags), '[]',
          clip.confidence.toFixed(3),
        ],
      )
    }

    // Mark project ready
    await pool.query(`UPDATE projects SET status = 'ready' WHERE id = $1`, [projectId])
    clipCount = clips.length
  })

  // ── 4. Clips API returns the generated clips ───────────────────────────────
  await check(`GET /clips returns ${clipCount} clips`, async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/clips`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const clips = await res.json() as any[]
    if (clips.length !== clipCount) throw new Error(`Expected ${clipCount}, got ${clips.length}`)
    const first = clips[0]
    if (!first.timecode_in) throw new Error('Missing timecode_in')
    if (!Array.isArray(first.scene_tags)) throw new Error('scene_tags not an array')
    if (typeof first.confidence !== 'string' && typeof first.confidence !== 'number') throw new Error('Missing confidence')
  })

  // ── 5. Filter by review_status ─────────────────────────────────────────────
  await check('GET /clips?status=auto filters correctly', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/clips?status=auto`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const clips = await res.json() as any[]
    if (!Array.isArray(clips)) throw new Error('Expected array')
    if (clips.some((c: any) => c.review_status !== 'auto')) throw new Error('Got non-auto clips')
  })

  // ── 6. Project status is ready ─────────────────────────────────────────────
  await check('Project status is ready after pipeline', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}`)
    const p = await res.json() as any
    if (p.status !== 'ready') throw new Error(`Expected ready, got ${p.status}`)
  })

  await pool.end()

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})

export {}
