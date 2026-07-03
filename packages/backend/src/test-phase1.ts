/**
 * Phase 1 integration test — runs against the live dev server on port 3001.
 * Usage: npm run test (server must be running)
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
  console.log('\nPhase 1 — integration tests\n')

  // ── 1. Health check ──────────────────────────────────────────────────────
  await check('GET /healthz returns ok', async () => {
    const res = await fetch(`${BASE}/healthz`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json() as any
    if (!body.ok) throw new Error(`Expected {ok:true}, got ${JSON.stringify(body)}`)
  })

  // ── 2. Create project (full analysis) ────────────────────────────────────
  let projectId = ''
  await check('POST /api/projects creates a project (full)', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test-game.mp4', analysisMode: 'full' }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const p = await res.json() as any
    if (!p.id) throw new Error(`No id in response: ${JSON.stringify(p)}`)
    if (p.analysis_mode !== 'full') throw new Error(`Expected full, got ${p.analysis_mode}`)
    if (p.status !== 'uploading') throw new Error(`Expected uploading, got ${p.status}`)
    projectId = p.id
  })

  // ── 3. Create project (quick search) ─────────────────────────────────────
  await check('POST /api/projects creates a project (quick)', async () => {
    const res = await fetch(`${BASE}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test-quick.mp4',
        analysisMode: 'quick',
        quickSearchParams: { players: ['#18'], scenes: ['goal', 'save'] },
      }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    const p = await res.json() as any
    if (p.analysis_mode !== 'quick') throw new Error(`Expected quick, got ${p.analysis_mode}`)
  })

  // ── 4. List projects ──────────────────────────────────────────────────────
  await check('GET /api/projects returns array', async () => {
    const res = await fetch(`${BASE}/api/projects`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const list = await res.json() as any[]
    if (!Array.isArray(list)) throw new Error('Expected array')
    if (list.length === 0) throw new Error('Expected at least one project')
  })

  // ── 5. Get single project ─────────────────────────────────────────────────
  await check('GET /api/projects/:id returns project', async () => {
    if (!projectId) throw new Error('No projectId from step 2')
    const res = await fetch(`${BASE}/api/projects/${projectId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const p = await res.json() as any
    if (p.id !== projectId) throw new Error(`ID mismatch`)
  })

  // ── 6. tus upload creation (POST) ────────────────────────────────────────
  let uploadLocation = ''
  await check('POST /api/upload creates tus upload slot', async () => {
    if (!projectId) throw new Error('No projectId from step 2')
    const meta = [
      `filename ${btoa('test-game.mp4')}`,
      `filetype ${btoa('video/mp4')}`,
      `projectid ${btoa(projectId)}`,
    ].join(',')

    const res = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1024',
        'Upload-Metadata': meta,
        'Content-Length': '0',
      },
    })
    if (res.status !== 201) throw new Error(`Expected 201, got ${res.status}: ${await res.text()}`)
    const loc = res.headers.get('location')
    if (!loc) throw new Error('No Location header in tus response')
    uploadLocation = loc
  })

  // ── 7. tus upload chunk (PATCH) ───────────────────────────────────────────
  await check('PATCH /api/upload/:id accepts a chunk', async () => {
    if (!uploadLocation) throw new Error('No upload location from step 6')
    const chunk = new Uint8Array(1024)
    const res = await fetch(uploadLocation, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
        'Content-Length': '1024',
      },
      body: chunk,
    })
    if (res.status !== 204) throw new Error(`Expected 204, got ${res.status}: ${await res.text()}`)
    const offset = res.headers.get('upload-offset')
    if (offset !== '1024') throw new Error(`Expected offset 1024, got ${offset}`)
  })

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})

export {}
