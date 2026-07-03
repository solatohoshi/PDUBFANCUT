import type { FastifyInstance } from 'fastify'
import { enqueueAnalysis } from '../jobs/queue'
import { sendClipsReadyEmail } from '../lib/notify'

export async function projectRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      name: string
      analysisMode: 'full' | 'quick'
      quickSearchParams?: { players: string[]; scenes: string[] }
    }
  }>('/projects', async (req, reply) => {
    const { name, analysisMode, quickSearchParams } = req.body
    const userId = req.userId ?? null

    const result = await fastify.pg.query(
      `INSERT INTO projects (name, analysis_mode, quick_search_params, user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, analysis_mode, status, created_at`,
      [name, analysisMode, quickSearchParams ? JSON.stringify(quickSearchParams) : null, userId]
    )

    reply.status(201).send(result.rows[0])
  })

  fastify.get('/projects', async (req, reply) => {
    const userId = req.userId
    const result = userId
      ? await fastify.pg.query(
          `SELECT id, name, analysis_mode, status, created_at, updated_at
           FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        )
      : await fastify.pg.query(
          `SELECT id, name, analysis_mode, status, created_at, updated_at
           FROM projects ORDER BY created_at DESC`,
        )
    reply.send(result.rows)
  })

  fastify.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT p.id, p.name, p.analysis_mode, p.quick_search_params,
              p.status, p.file_hash, p.created_at, p.updated_at,
              json_agg(sf.*) FILTER (WHERE sf.id IS NOT NULL) AS source_files,
              json_agg(j.*) FILTER (WHERE j.id IS NOT NULL) AS jobs
       FROM projects p
       LEFT JOIN source_files sf ON sf.project_id = p.id
       LEFT JOIN jobs j ON j.project_id = p.id
       WHERE p.id = $1
         AND (p.user_id = $2 OR p.user_id IS NULL OR $2 IS NULL)
       GROUP BY p.id`,
      [req.params.id, req.userId ?? null]
    )

    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }

    reply.send(result.rows[0])
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/projects/:id/clips',
    async (req, reply) => {
      const { id } = req.params
      const { status } = req.query

      // Verify project exists
      const proj = await fastify.pg.query(`SELECT id FROM projects WHERE id = $1`, [id])
      if (!proj.rows[0]) {
        reply.status(404).send({ error: 'Project not found' })
        return
      }

      const result = await fastify.pg.query(
        `SELECT id, project_id, source_file_id,
                timecode_in, timecode_out,
                scene_tags, players, confidence, thumb_key, review_status, created_at
         FROM clips
         WHERE project_id = $1
           ${status ? `AND review_status = $2` : ''}
         ORDER BY timecode_in`,
        status ? [id, status] : [id],
      )

      reply.send(result.rows)
    },
  )

  // ── Upgrade quick search project to full analysis ──────────────────────────
  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>(
    '/projects/:id/full-analysis', async (req, reply) => {
    const { id } = req.params
    const proj = await fastify.pg.query(
      `SELECT id, name, analysis_mode, status, user_id FROM projects WHERE id = $1`,
      [id],
    )
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }
    if (proj.rows[0].analysis_mode === 'full') {
      reply.status(409).send({ error: 'Already running full analysis' })
      return
    }
    const { name: projectName, user_id: projectUserId } = proj.rows[0]

    await fastify.pg.query(
      `UPDATE projects
       SET analysis_mode = 'full', quick_search_params = NULL,
           status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [id],
    )

    const jobRes = await fastify.pg.query(
      `INSERT INTO jobs (project_id, type, status) VALUES ($1, 'full_analysis', 'pending')
       RETURNING id`,
      [id],
    )

    const sfRes = await fastify.pg.query(
      `SELECT id FROM source_files WHERE project_id = $1 LIMIT 1`, [id],
    )

    // Stub: re-seed additional clips and mark ready after delay
    const delayMs = 6000 + Math.random() * 4000
    setTimeout(async () => {
      try {
        if (sfRes.rows[0]) {
          await seedStubClips(fastify, id, sfRes.rows[0].id, true)
        }
        await fastify.pg.query(
          `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [jobRes.rows[0].id],
        )
        await fastify.pg.query(
          `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`, [id],
        )
        await sendClipsReadyEmail({ log: fastify.log }, id, projectName, projectUserId)
      } catch (err: any) {
        fastify.log.error({ err: err.message }, 'Full analysis stub failed')
      }
    }, delayMs)

    reply.status(202).send({ message: 'Full analysis started' })
  })

  // ── Add new quick-search target to an existing project ────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { players?: string[]; scenes?: string[] }
  }>('/projects/:id/searches', async (req, reply) => {
    const { id } = req.params
    const { players = [], scenes = [] } = req.body

    if (players.length === 0 && scenes.length === 0) {
      reply.status(400).send({ error: 'Provide at least one player or scene to search' })
      return
    }

    const proj = await fastify.pg.query(
      `SELECT id, name, quick_search_params, user_id FROM projects WHERE id = $1`, [id],
    )
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }
    const { name: searchProjectName, user_id: searchUserId } = proj.rows[0]

    const existing = proj.rows[0].quick_search_params ?? { players: [], scenes: [] }
    const merged = {
      players: [...new Set([...existing.players, ...players])],
      scenes:  [...new Set([...existing.scenes,  ...scenes])],
    }

    await fastify.pg.query(
      `UPDATE projects
       SET quick_search_params = $2, status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify(merged)],
    )

    const jobRes = await fastify.pg.query(
      `INSERT INTO jobs (project_id, type, status) VALUES ($1, 'quick_search', 'pending')
       RETURNING id`,
      [id],
    )

    const sfRes = await fastify.pg.query(
      `SELECT id FROM source_files WHERE project_id = $1 LIMIT 1`, [id],
    )

    // Stub: seed a couple more clips for the new search terms and mark ready
    const delayMs = 4000 + Math.random() * 3000
    setTimeout(async () => {
      try {
        if (sfRes.rows[0]) {
          await seedSearchClips(fastify, id, sfRes.rows[0].id, players, scenes)
        }
        await fastify.pg.query(
          `UPDATE jobs SET status = 'completed', updated_at = NOW() WHERE id = $1`,
          [jobRes.rows[0].id],
        )
        await fastify.pg.query(
          `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`, [id],
        )
        await sendClipsReadyEmail({ log: fastify.log }, id, searchProjectName, searchUserId)
      } catch (err: any) {
        fastify.log.error({ err: err.message }, 'Add-search stub failed')
      }
    }, delayMs)

    reply.status(202).send({ message: 'Search started', params: merged })
  })
}

// ── Shared stub helpers ────────────────────────────────────────────────────

const FULL_STUB_CLIPS = [
  { tcIn: 28.5,  tcOut: 42.0,  tag: 'goal',         conf: 0.94, players: [{ jersey: '18', name: 'E. Maschmeyer', team: 'BOS' }] },
  { tcIn: 90.0,  tcOut: 101.5, tag: 'save',          conf: 0.88, players: [{ jersey: '35', name: 'K. Desbiens',   team: 'BOS' }] },
  { tcIn: 148.0, tcOut: 160.0, tag: 'shot_on_goal',  conf: 0.91, players: [] },
  { tcIn: 175.0, tcOut: 187.0, tag: 'hit',            conf: 0.76, players: [] },
  { tcIn: 230.0, tcOut: 241.5, tag: 'shot_on_goal',  conf: 0.89, players: [] },
  { tcIn: 290.0, tcOut: 302.0, tag: 'save',           conf: 0.82, players: [{ jersey: '30', name: 'A. Franson', team: 'MIN' }] },
  { tcIn: 310.0, tcOut: 322.0, tag: 'celebration',   conf: 0.86, players: [] },
  { tcIn: 370.0, tcOut: 380.0, tag: 'faceoff',        conf: 0.77, players: [] },
  { tcIn: 420.0, tcOut: 433.0, tag: 'goal',           conf: 0.97, players: [{ jersey: '9', name: 'J. Rattray', team: 'MIN' }] },
  { tcIn: 480.0, tcOut: 490.0, tag: 'penalty',        conf: 0.83, players: [] },
]

export async function seedStubClips(
  fastify: FastifyInstance,
  projectId: string,
  sourceFileId: string,
  fullMode = false,
) {
  const clips = fullMode ? FULL_STUB_CLIPS : FULL_STUB_CLIPS.slice(0, 5)
  for (const clip of clips) {
    const reviewStatus = clip.conf >= 0.85 ? 'auto' : 'auto'
    await fastify.pg.query(
      `INSERT INTO clips
         (project_id, source_file_id, timecode_in, timecode_out,
          scene_tags, players, confidence, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        projectId, sourceFileId,
        clip.tcIn, clip.tcOut,
        JSON.stringify([{ tag: clip.tag, confidence: clip.conf }]),
        JSON.stringify(clip.players),
        clip.conf,
        reviewStatus,
      ],
    )
  }
}

async function seedSearchClips(
  fastify: FastifyInstance,
  projectId: string,
  sourceFileId: string,
  players: string[],
  scenes: string[],
) {
  const pool = FULL_STUB_CLIPS.filter((c) =>
    scenes.length === 0 || scenes.includes(c.tag),
  ).slice(0, 3)

  for (const clip of pool) {
    await fastify.pg.query(
      `INSERT INTO clips
         (project_id, source_file_id, timecode_in, timecode_out,
          scene_tags, players, confidence, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto')
       ON CONFLICT DO NOTHING`,
      [
        projectId, sourceFileId,
        clip.tcIn + 50, clip.tcOut + 50,
        JSON.stringify([{ tag: clip.tag, confidence: clip.conf }]),
        players.length > 0
          ? JSON.stringify(players.map((p) => ({ jersey: p, name: p, team: '' })))
          : JSON.stringify(clip.players),
        clip.conf,
      ],
    )
  }
}
