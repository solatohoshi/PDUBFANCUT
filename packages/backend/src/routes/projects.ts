import type { FastifyInstance } from 'fastify'
import { requireAuth, getClerkUserId } from '../plugins/auth'

export async function projectRoutes(fastify: FastifyInstance) {
  // Create a project (called before the tus upload begins)
  fastify.post<{
    Body: {
      name: string
      analysisMode: 'full' | 'quick'
      quickSearchParams?: { players: string[]; scenes: string[] }
    }
  }>(
    '/projects',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clerkUserId = getClerkUserId(req)
      const { name, analysisMode, quickSearchParams } = req.body

      // Upsert user
      const userRes = await fastify.pg.query(
        `INSERT INTO users (clerk_id, email)
         VALUES ($1, $2)
         ON CONFLICT (clerk_id) DO UPDATE SET email = EXCLUDED.email
         RETURNING id`,
        [clerkUserId, ''] // email populated on first real profile fetch; fine for now
      )
      const userId: string = userRes.rows[0].id

      const projectRes = await fastify.pg.query(
        `INSERT INTO projects (user_id, name, analysis_mode, quick_search_params)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, analysis_mode, status, created_at`,
        [userId, name, analysisMode, quickSearchParams ? JSON.stringify(quickSearchParams) : null]
      )

      reply.status(201).send(projectRes.rows[0])
    }
  )

  // List projects for the logged-in user
  fastify.get('/projects', { preHandler: requireAuth }, async (req, reply) => {
    const clerkUserId = getClerkUserId(req)

    const result = await fastify.pg.query(
      `SELECT p.id, p.name, p.analysis_mode, p.status, p.created_at, p.updated_at
       FROM projects p
       JOIN users u ON u.id = p.user_id
       WHERE u.clerk_id = $1
       ORDER BY p.created_at DESC`,
      [clerkUserId]
    )

    reply.send(result.rows)
  })

  // Get a single project
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const clerkUserId = getClerkUserId(req)
      const { id } = req.params

      const result = await fastify.pg.query(
        `SELECT p.id, p.name, p.analysis_mode, p.quick_search_params,
                p.status, p.file_hash, p.created_at, p.updated_at,
                json_agg(sf.*) FILTER (WHERE sf.id IS NOT NULL) AS source_files,
                json_agg(j.*) FILTER (WHERE j.id IS NOT NULL) AS jobs
         FROM projects p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN source_files sf ON sf.project_id = p.id
         LEFT JOIN jobs j ON j.project_id = p.id
         WHERE p.id = $1 AND u.clerk_id = $2
         GROUP BY p.id`,
        [id, clerkUserId]
      )

      if (!result.rows[0]) {
        reply.status(404).send({ error: 'Project not found' })
        return
      }

      reply.send(result.rows[0])
    }
  )
}
