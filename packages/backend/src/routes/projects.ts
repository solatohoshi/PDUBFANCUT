import type { FastifyInstance } from 'fastify'
import { enqueueAnalysis, enqueueRethumb } from '../jobs/queue'
import { createCapabilityToken } from '../lib/capabilityTokens'
import { requireProjectOwner } from '../lib/ownership'
import { canCreateProject, canQueueAnalysis } from '../lib/quotas'
import { emptyBody, idParams, projectCreateBody } from '../lib/schemas'

const SCENE_TAGS = [
  'shot_on_goal', 'save', 'goal', 'blocked_shot', 'hit', 'penalty',
  'faceoff', 'power_play', 'breakaway', 'icing', 'offsides', 'turnover', 'pass',
]

const searchBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    players: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
    scenes: { type: 'array', maxItems: 20, items: { type: 'string', enum: SCENE_TAGS } },
  },
} as const

const clipsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { status: { type: 'string', enum: ['auto', 'confirmed', 'dismissed'] } },
} as const

function analysisType(mode: 'full' | 'quick') {
  return mode === 'full' ? 'full_analysis' : 'quick_search'
}

async function createAndEnqueueAnalysis(
  fastify: FastifyInstance,
  input: {
    projectId: string
    sourceFileId: string
    s3Key: string
    mode: 'full' | 'quick'
    params?: { players: string[]; scenes: string[] }
    replaceExistingClips: boolean
  },
): Promise<string> {
  const jobResult = await fastify.pg.query(
    `INSERT INTO jobs (project_id, type, status) VALUES ($1, $2, 'pending') RETURNING id`,
    [input.projectId, analysisType(input.mode)],
  )
  const jobId = jobResult.rows[0].id as string

  try {
    const bullmqId = await enqueueAnalysis({
      projectId: input.projectId,
      sourceFileId: input.sourceFileId,
      s3Key: input.s3Key,
      analysisMode: input.mode,
      quickSearchParams: input.params,
      replaceExistingClips: input.replaceExistingClips,
    })
    await fastify.pg.query(
      `UPDATE jobs SET bullmq_id = $2 WHERE id = $1`,
      [jobId, String(bullmqId)],
    )
    return jobId
  } catch (err: any) {
    await fastify.pg.query(
      `UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`,
      [jobId, `Queue unavailable: ${err.message}`.slice(0, 2000)],
    )
    throw err
  }
}

async function sourceForProject(fastify: FastifyInstance, projectId: string) {
  const result = await fastify.pg.query(
    `SELECT sf.id, sf.s3_key
     FROM source_files sf
     WHERE sf.project_id = $1 AND sf.status = 'uploaded'
     ORDER BY sf.created_at LIMIT 1`,
    [projectId],
  )
  return result.rows[0] as { id: string; s3_key: string } | undefined
}

export async function projectRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      name: string
      analysisMode: 'full' | 'quick'
      quickSearchParams?: { players: string[]; scenes: string[] }
    }
  }>('/projects', {
    schema: { body: projectCreateBody },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const userId = req.userId!
    if (!await canCreateProject(fastify.pg, userId)) {
      reply.status(429).send({ error: 'Project quota reached' })
      return
    }

    const name = req.body.name.trim()
    const params = req.body.quickSearchParams
    if (req.body.analysisMode === 'quick' && !(params?.players?.length || params?.scenes?.length)) {
      reply.status(400).send({ error: 'Quick analysis requires at least one player or scene' })
      return
    }

    const result = await fastify.pg.query(
      `INSERT INTO projects (name, analysis_mode, quick_search_params, user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, analysis_mode, status, created_at, updated_at`,
      [name, req.body.analysisMode, params ? JSON.stringify(params) : null, userId],
    )
    reply.status(201).send(result.rows[0])
  })

  fastify.get('/projects', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, name, analysis_mode, status, created_at, updated_at
       FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId],
    )
    reply.send(result.rows)
  })

  fastify.get<{ Params: { id: string } }>('/projects/:id', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT p.id, p.name, p.analysis_mode, p.quick_search_params,
              p.status, p.file_hash, p.created_at, p.updated_at,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', sf.id,
                          'original_name', sf.original_name,
                          'duration_secs', sf.duration_secs,
                          'status', sf.status
                        ) ORDER BY sf.created_at)
                        FROM source_files sf WHERE sf.project_id = p.id), '[]'::json) AS source_files,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', j.id,
                          'type', j.type,
                          'status', j.status,
                          'error', j.error
                        ) ORDER BY j.created_at DESC)
                        FROM jobs j WHERE j.project_id = p.id), '[]'::json) AS jobs
       FROM projects p WHERE p.id = $1`,
      [req.params.id],
    )
    reply.send(result.rows[0])
  })

  fastify.delete<{ Params: { id: string } }>('/projects/:id', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `DELETE FROM projects WHERE id = $1 AND status IN ('uploading', 'failed') RETURNING id`,
      [req.params.id],
    )
    if (!result.rows[0]) {
      reply.status(409).send({ error: 'Only uploading or failed projects can be deleted' })
      return
    }
    reply.status(204).send()
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>('/projects/:id/clips', {
    schema: { params: idParams(), querystring: clipsQuery },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const values: unknown[] = [req.params.id]
    const statusClause = req.query.status ? `AND review_status = $${values.push(req.query.status)}` : ''
    const result = await fastify.pg.query(
      `SELECT id, project_id, source_file_id, analysis_run_id,
              timecode_in, timecode_out, scene_tags, players, confidence,
              thumb_key, review_status, created_at
       FROM clips WHERE project_id = $1 ${statusClause} ORDER BY timecode_in`,
      values,
    )
    reply.send(result.rows)
  })

  fastify.get<{ Params: { id: string } }>('/projects/:id/analysis-runs', {
    schema: { params: idParams() },
    preHandler: requireProjectOwner(),
  }, async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT id, status, pipeline_version, provider, model, prompt_version,
              parameters, input_tokens, output_tokens, estimated_cost_usd,
              processing_ms, error, started_at, completed_at, created_at
       FROM analysis_runs WHERE project_id = $1 ORDER BY created_at DESC`,
      [req.params.id],
    )
    reply.send(result.rows)
  })

  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>('/projects/:id/upload-token', {
    schema: { params: idParams(), body: emptyBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.send(createCapabilityToken(
      { sub: req.userId!, projectId: req.params.id, scope: 'upload' },
      Number.parseInt(process.env.UPLOAD_TOKEN_TTL_SECS ?? '900', 10),
    ))
  })

  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>('/projects/:id/media-token', {
    schema: { params: idParams(), body: emptyBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    reply.send(createCapabilityToken(
      { sub: req.userId!, projectId: req.params.id, scope: 'media' },
      Number.parseInt(process.env.MEDIA_TOKEN_TTL_SECS ?? '3600', 10),
    ))
  })

  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>('/projects/:id/rethumb', {
    schema: { params: idParams(), body: emptyBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    try {
      await enqueueRethumb(req.params.id)
      reply.status(202).send({ message: 'Thumbnail generation queued' })
    } catch {
      reply.status(503).send({ error: 'Job queue unavailable' })
    }
  })

  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>('/projects/:id/reanalyze', {
    schema: { params: idParams(), body: emptyBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 3, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    if (!await canQueueAnalysis(fastify.pg, req.userId!)) {
      reply.status(429).send({ error: 'Analysis quota reached; wait for an active job to finish' })
      return
    }
    const source = await sourceForProject(fastify, req.params.id)
    if (!source?.s3_key) {
      reply.status(409).send({ error: 'Project has no completed source upload' })
      return
    }
    const project = await fastify.pg.query(
      `SELECT analysis_mode, quick_search_params FROM projects WHERE id = $1`,
      [req.params.id],
    )
    try {
      await createAndEnqueueAnalysis(fastify, {
        projectId: req.params.id,
        sourceFileId: source.id,
        s3Key: source.s3_key,
        mode: project.rows[0].analysis_mode,
        params: project.rows[0].quick_search_params ?? undefined,
        replaceExistingClips: true,
      })
      await fastify.pg.query(`UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`, [req.params.id])
      reply.status(202).send({ message: 'Re-analysis queued' })
    } catch {
      reply.status(503).send({ error: 'Job queue unavailable' })
    }
  })

  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>('/projects/:id/full-analysis', {
    schema: { params: idParams(), body: emptyBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 3, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    if (!await canQueueAnalysis(fastify.pg, req.userId!)) {
      reply.status(429).send({ error: 'Analysis quota reached; wait for an active job to finish' })
      return
    }
    const source = await sourceForProject(fastify, req.params.id)
    if (!source?.s3_key) {
      reply.status(409).send({ error: 'Project has no completed source upload' })
      return
    }
    try {
      await createAndEnqueueAnalysis(fastify, {
        projectId: req.params.id,
        sourceFileId: source.id,
        s3Key: source.s3_key,
        mode: 'full',
        replaceExistingClips: true,
      })
      await fastify.pg.query(
        `UPDATE projects SET analysis_mode = 'full', quick_search_params = NULL,
         status = 'processing', updated_at = NOW() WHERE id = $1`,
        [req.params.id],
      )
      reply.status(202).send({ message: 'Full analysis queued' })
    } catch {
      reply.status(503).send({ error: 'Job queue unavailable' })
    }
  })

  fastify.post<{
    Params: { id: string }
    Body: { players?: string[]; scenes?: string[] }
  }>('/projects/:id/searches', {
    schema: { params: idParams(), body: searchBody },
    preHandler: requireProjectOwner(),
    config: { rateLimit: { max: 5, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const players = req.body.players ?? []
    const scenes = req.body.scenes ?? []
    if (players.length === 0 && scenes.length === 0) {
      reply.status(400).send({ error: 'Provide at least one player or scene' })
      return
    }
    if (!await canQueueAnalysis(fastify.pg, req.userId!)) {
      reply.status(429).send({ error: 'Analysis quota reached; wait for an active job to finish' })
      return
    }
    const source = await sourceForProject(fastify, req.params.id)
    if (!source?.s3_key) {
      reply.status(409).send({ error: 'Project has no completed source upload' })
      return
    }

    const params = { players, scenes }
    try {
      await createAndEnqueueAnalysis(fastify, {
        projectId: req.params.id,
        sourceFileId: source.id,
        s3Key: source.s3_key,
        mode: 'quick',
        params,
        replaceExistingClips: false,
      })
      await fastify.pg.query(
        `UPDATE projects SET analysis_mode = 'quick', quick_search_params = $2,
         status = 'processing', updated_at = NOW() WHERE id = $1`,
        [req.params.id, JSON.stringify(params)],
      )
      reply.status(202).send({ message: 'Search queued', params })
    } catch {
      reply.status(503).send({ error: 'Job queue unavailable' })
    }
  })
}
