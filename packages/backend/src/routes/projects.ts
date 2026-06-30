import type { FastifyInstance } from 'fastify'

export async function projectRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      name: string
      analysisMode: 'full' | 'quick'
      quickSearchParams?: { players: string[]; scenes: string[] }
    }
  }>('/projects', async (req, reply) => {
    const { name, analysisMode, quickSearchParams } = req.body

    const result = await fastify.pg.query(
      `INSERT INTO projects (name, analysis_mode, quick_search_params)
       VALUES ($1, $2, $3)
       RETURNING id, name, analysis_mode, status, created_at`,
      [name, analysisMode, quickSearchParams ? JSON.stringify(quickSearchParams) : null]
    )

    reply.status(201).send(result.rows[0])
  })

  fastify.get('/projects', async (_req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, name, analysis_mode, status, created_at, updated_at
       FROM projects
       ORDER BY created_at DESC`
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
       GROUP BY p.id`,
      [req.params.id]
    )

    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }

    reply.send(result.rows[0])
  })
}
