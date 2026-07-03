/**
 * Phase 3 integration test — editor surface & clip review APIs.
 * Runs against the live dev server on port 3001 (server must be running).
 * Usage: npx tsx src/test-phase3.ts
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
  console.log('\nPhase 3 — editor surface & clip review API tests\n')

  // ── Setup: DB connection for seeding ──────────────────────────────────────
  const { Pool, neonConfig } = await import('@neondatabase/serverless')
  const ws = (await import('ws')).default
  neonConfig.webSocketConstructor = ws
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })

  // ── 1. Create a quick-search project (for upgrade test) ───────────────────
  let quickProjectId = ''
  await check('Create quick-search project', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'phase3-test-quick.mp4',
        analysisMode: 'quick',
        quickSearchParams: { players: ['#18'], scenes: ['goal'] },
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    quickProjectId = (await res.json() as any).id
  })

  // ── 2. Create a full-analysis project (for conflict test) ─────────────────
  let fullProjectId = ''
  await check('Create full-analysis project', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'phase3-test-full.mp4', analysisMode: 'full' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    fullProjectId = (await res.json() as any).id
  })

  // ── 3. Seed source_file + clips into the quick project ────────────────────
  let clipIds: string[] = []
  let sourceFileId = ''
  await check('Seed source file and clips for quick project', async () => {
    const sfRes = await pool.query(
      `INSERT INTO source_files (project_id, original_name, size_bytes, status)
       VALUES ($1, 'phase3-game.mp4', 2000000000, 'uploaded') RETURNING id`,
      [quickProjectId],
    )
    sourceFileId = sfRes.rows[0].id

    const clips = [
      { tcIn: 30.0,  tcOut: 45.0,  tag: 'goal', conf: 0.95 },  // high confidence → auto
      { tcIn: 90.0,  tcOut: 102.0, tag: 'save', conf: 0.78 },  // low confidence → review queue
      { tcIn: 150.0, tcOut: 163.0, tag: 'hit',  conf: 0.82 },  // low confidence → review queue
    ]
    for (const c of clips) {
      const r = await pool.query(
        `INSERT INTO clips
           (project_id, source_file_id, timecode_in, timecode_out,
            scene_tags, players, confidence, review_status)
         VALUES ($1, $2, $3, $4, $5, '[]', $6, 'auto')
         RETURNING id`,
        [
          quickProjectId, sourceFileId,
          c.tcIn, c.tcOut,
          JSON.stringify([{ tag: c.tag, confidence: c.conf }]),
          c.conf,
        ],
      )
      clipIds.push(r.rows[0].id)
    }
    await pool.query(`UPDATE projects SET status = 'ready' WHERE id = $1`, [quickProjectId])
    if (clipIds.length !== 3) throw new Error(`Expected 3 clip ids, got ${clipIds.length}`)
  })

  // ── 4. Confirm a clip ──────────────────────────────────────────────────────
  await check('PATCH /clips/:id — confirm a clip', async () => {
    if (!clipIds[1]) throw new Error('No clip id from step 3')
    const res = await fetch(`${BASE}/api/clips/${clipIds[1]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'confirmed' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const clip = await res.json() as any
    if (clip.review_status !== 'confirmed') throw new Error(`Expected confirmed, got ${clip.review_status}`)
    if (clip.id !== clipIds[1]) throw new Error('ID mismatch in response')
  })

  // ── 5. Dismiss a clip ─────────────────────────────────────────────────────
  await check('PATCH /clips/:id — dismiss a clip', async () => {
    if (!clipIds[2]) throw new Error('No clip id from step 3')
    const res = await fetch(`${BASE}/api/clips/${clipIds[2]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'dismissed' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const clip = await res.json() as any
    if (clip.review_status !== 'dismissed') throw new Error(`Expected dismissed, got ${clip.review_status}`)
  })

  // ── 6. Review status filters reflect the changes ──────────────────────────
  await check('GET /clips?status=confirmed returns only confirmed clips', async () => {
    const res = await fetch(`${BASE}/api/projects/${quickProjectId}/clips?status=confirmed`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const clips = await res.json() as any[]
    if (!clips.every((c: any) => c.review_status === 'confirmed'))
      throw new Error('Got non-confirmed clips in confirmed filter')
    if (clips.length !== 1) throw new Error(`Expected 1 confirmed clip, got ${clips.length}`)
  })

  await check('GET /clips?status=dismissed returns only dismissed clips', async () => {
    const res = await fetch(`${BASE}/api/projects/${quickProjectId}/clips?status=dismissed`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const clips = await res.json() as any[]
    if (!clips.every((c: any) => c.review_status === 'dismissed'))
      throw new Error('Got non-dismissed clips in dismissed filter')
    if (clips.length !== 1) throw new Error(`Expected 1 dismissed clip, got ${clips.length}`)
  })

  // ── 7. Invalid review_status → 400 ───────────────────────────────────────
  await check('PATCH /clips/:id — invalid status returns 400', async () => {
    if (!clipIds[0]) throw new Error('No clip id')
    const res = await fetch(`${BASE}/api/clips/${clipIds[0]}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'bogus' }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // ── 8. Non-existent clip → 404 ────────────────────────────────────────────
  await check('PATCH /clips/:id — unknown id returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await fetch(`${BASE}/api/clips/${fakeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_status: 'confirmed' }),
    })
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`)
  })

  // ── 9. Upgrade quick project to full analysis ─────────────────────────────
  await check('POST /projects/:id/full-analysis upgrades mode to full', async () => {
    if (!quickProjectId) throw new Error('No quickProjectId')
    const res = await fetch(`${BASE}/api/projects/${quickProjectId}/full-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (res.status !== 202) throw new Error(`Expected 202, got ${res.status}: ${await res.text()}`)
    const body = await res.json() as any
    if (!body.message) throw new Error('Missing message in response')

    // Verify DB was updated
    const proj = await pool.query(`SELECT analysis_mode, status FROM projects WHERE id = $1`, [quickProjectId])
    if (proj.rows[0].analysis_mode !== 'full') throw new Error(`Mode not updated to full`)
    if (proj.rows[0].status !== 'processing') throw new Error(`Expected processing status`)
  })

  // ── 10. Duplicate upgrade → 409 ───────────────────────────────────────────
  await check('POST /projects/:id/full-analysis on full project returns 409', async () => {
    if (!fullProjectId) throw new Error('No fullProjectId')
    const res = await fetch(`${BASE}/api/projects/${fullProjectId}/full-analysis`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (res.status !== 409) throw new Error(`Expected 409, got ${res.status}`)
  })

  // ── 11. Add search to quick project ───────────────────────────────────────
  let addSearchProjectId = ''
  await check('Create quick project for add-search test', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'phase3-search-test.mp4',
        analysisMode: 'quick',
        quickSearchParams: { players: ['#18'], scenes: ['goal'] },
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    addSearchProjectId = (await res.json() as any).id
  })

  await check('POST /projects/:id/searches merges new search params', async () => {
    if (!addSearchProjectId) throw new Error('No addSearchProjectId')
    const res = await fetch(`${BASE}/api/projects/${addSearchProjectId}/searches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: ['#30'], scenes: ['save', 'hit'] }),
    })
    if (res.status !== 202) throw new Error(`Expected 202, got ${res.status}: ${await res.text()}`)
    const body = await res.json() as any
    if (!body.params) throw new Error('Missing params in response')
    // Should have merged #18 (existing) + #30 (new)
    if (!body.params.players.includes('#18')) throw new Error('Missing original player #18')
    if (!body.params.players.includes('#30')) throw new Error('Missing new player #30')
    if (!body.params.scenes.includes('goal')) throw new Error('Missing original scene goal')
    if (!body.params.scenes.includes('save')) throw new Error('Missing new scene save')
  })

  // ── 12. Add-search with empty body → 400 ──────────────────────────────────
  await check('POST /projects/:id/searches with empty params returns 400', async () => {
    if (!addSearchProjectId) throw new Error('No addSearchProjectId')
    const res = await fetch(`${BASE}/api/projects/${addSearchProjectId}/searches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players: [], scenes: [] }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
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
