/**
 * Phase 4 integration test — export & share API.
 * Runs against the live dev server on port 3001 (server must be running).
 * Usage: npx tsx src/test-phase4.ts
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function run() {
  console.log('\nPhase 4 — export & share API tests\n')

  // ── Setup ─────────────────────────────────────────────────────────────────
  const { Pool, neonConfig } = await import('@neondatabase/serverless')
  const ws = (await import('ws')).default
  neonConfig.webSocketConstructor = ws
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })

  let projectId = ''
  await check('Create project for export tests', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'phase4-test.mp4', analysisMode: 'full' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    projectId = (await res.json() as any).id
  })

  // Seed a source file so the project looks real
  let sourceFileId = ''
  await check('Seed source file', async () => {
    const r = await pool.query(
      `INSERT INTO source_files (project_id, original_name, size_bytes, status)
       VALUES ($1, 'phase4-game.mp4', 3000000000, 'uploaded') RETURNING id`,
      [projectId],
    )
    sourceFileId = r.rows[0].id
    await pool.query(`UPDATE projects SET status = 'ready' WHERE id = $1`, [projectId])
  })

  // A minimal timeline payload (timecodes match seeded source file)
  const sampleTimeline = [
    { clipId: 'stub', tcIn: 30.0, tcOut: 45.0, trimStart: 0, trimEnd: 0 },
    { clipId: 'stub', tcIn: 90.0, tcOut: 105.0, trimStart: 2, trimEnd: 1 },
  ]

  // ── 1. Create export — TikTok preset ──────────────────────────────────────
  let exportId = ''
  await check('POST /projects/:id/exports creates export (tiktok)', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'tiktok', timeline: sampleTimeline }),
    })
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`)
    const exp = await res.json() as any
    if (!exp.id) throw new Error('Missing id in response')
    if (exp.preset !== 'tiktok') throw new Error(`Expected tiktok, got ${exp.preset}`)
    if (exp.status !== 'rendering') throw new Error(`Expected rendering, got ${exp.status}`)
    if (!exp.duration_secs) throw new Error('Missing duration_secs')
    exportId = exp.id
  })

  // ── 2. Poll status — should start as rendering ────────────────────────────
  await check('GET /exports/:id returns rendering status immediately', async () => {
    if (!exportId) throw new Error('No exportId from step 1')
    const res = await fetch(`${BASE}/api/exports/${exportId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const exp = await res.json() as any
    if (exp.id !== exportId) throw new Error('ID mismatch')
    if (!['rendering', 'done'].includes(exp.status))
      throw new Error(`Unexpected status: ${exp.status}`)
  })

  // ── 3. Wait for stub render to complete (max 8 s) ─────────────────────────
  let finalExport: any = null
  await check('Export transitions to done within 8 seconds', async () => {
    if (!exportId) throw new Error('No exportId')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const res = await fetch(`${BASE}/api/exports/${exportId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const exp = await res.json() as any
      if (exp.status === 'done') {
        finalExport = exp
        break
      }
      if (exp.status === 'failed') throw new Error('Export failed')
      await sleep(500)
    }
    if (!finalExport) throw new Error('Export did not reach done within 8 s')
    if (!finalExport.output_key) throw new Error('Missing output_key after done')
  })

  // ── 4. List exports for project ───────────────────────────────────────────
  await check('GET /projects/:id/exports lists all exports', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/exports`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = await res.json() as any[]
    if (!Array.isArray(list)) throw new Error('Expected array')
    if (list.length === 0) throw new Error('Expected at least 1 export')
    if (!list.some((e: any) => e.id === exportId)) throw new Error('Created export not in list')
  })

  // ── 5. All 4 presets are accepted ─────────────────────────────────────────
  const presets = ['twitter', 'instagram', 'fullres'] as const
  for (const preset of presets) {
    await check(`POST /exports accepts preset: ${preset}`, async () => {
      const res = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset, timeline: sampleTimeline }),
      })
      if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`)
      const exp = await res.json() as any
      if (exp.preset !== preset) throw new Error(`Preset mismatch: ${exp.preset}`)
    })
  }

  // ── 6. Invalid preset → 400 ───────────────────────────────────────────────
  await check('POST /exports with invalid preset returns 400', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'betamax', timeline: sampleTimeline }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // ── 7. Empty timeline → 400 ───────────────────────────────────────────────
  await check('POST /exports with empty timeline returns 400', async () => {
    const res = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'tiktok', timeline: [] }),
    })
    if (res.status !== 400) throw new Error(`Expected 400, got ${res.status}`)
  })

  // ── 8. Unknown project → 404 ─────────────────────────────────────────────
  await check('POST /exports on unknown project returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await fetch(`${BASE}/api/projects/${fakeId}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'tiktok', timeline: sampleTimeline }),
    })
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`)
  })

  // ── 9. Unknown export → 404 ───────────────────────────────────────────────
  await check('GET /exports/:id on unknown id returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await fetch(`${BASE}/api/exports/${fakeId}`)
    if (res.status !== 404) throw new Error(`Expected 404, got ${res.status}`)
  })

  // ── 10. Download — stub mode returns informative 404 ──────────────────────
  await check('GET /exports/:id/download returns 404 in stub mode (no R2 object)', async () => {
    if (!exportId) throw new Error('No exportId')
    // Wait for it to be done first (already verified above)
    const res = await fetch(`${BASE}/api/exports/${exportId}/download`)
    // Stub mode: no real file in R2, should be 404 with a helpful message
    if (![404, 409].includes(res.status))
      throw new Error(`Expected 404 or 409, got ${res.status}`)
    const body = await res.json() as any
    if (!body.error) throw new Error('Expected error message in body')
  })

  // ── 11. Duration is calculated from trimmed timeline ──────────────────────
  await check('Export duration_secs accounts for trim', async () => {
    // sampleTimeline has:
    //   clip 1: 45-30 = 15s, no trim
    //   clip 2: 105-90 = 15s, trimStart=2, trimEnd=1 → 15-3 = 12s
    // Total = 27s
    const res = await fetch(`${BASE}/api/projects/${projectId}/exports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'fullres', timeline: sampleTimeline }),
    })
    if (res.status !== 201) throw new Error(`HTTP ${res.status}`)
    const exp = await res.json() as any
    const dur = parseFloat(exp.duration_secs)
    if (Math.abs(dur - 27) > 0.1) throw new Error(`Expected ~27s duration, got ${dur}`)
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
