import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'

type ResourceKind = 'project' | 'sourceFile' | 'clip' | 'export' | 'thumbnail'

function param(req: FastifyRequest, name: string): string | undefined {
  return (req.params as Record<string, string> | undefined)?.[name]
}

function queryFor(kind: ResourceKind): string {
  switch (kind) {
    case 'project':
      return `SELECT p.id AS project_id FROM projects p WHERE p.id = $1 AND p.user_id = $2`
    case 'sourceFile':
      return `SELECT sf.project_id FROM source_files sf JOIN projects p ON p.id = sf.project_id
              WHERE sf.id = $1 AND p.user_id = $2`
    case 'clip':
      return `SELECT c.project_id FROM clips c JOIN projects p ON p.id = c.project_id
              WHERE c.id = $1 AND p.user_id = $2`
    case 'export':
      return `SELECT e.project_id FROM exports e JOIN projects p ON p.id = e.project_id
              WHERE e.id = $1 AND p.user_id = $2`
    case 'thumbnail':
      return `SELECT c.project_id FROM clips c JOIN projects p ON p.id = c.project_id
              WHERE c.thumb_key = $1 AND p.user_id = $2`
  }
}

function ownerGuard(kind: ResourceKind, paramName = 'id'): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const resourceId = param(req, paramName)
    if (!resourceId || !req.userId) {
      reply.status(404).send({ error: 'Resource not found' })
      return
    }

    const result = await req.server.pg.query(queryFor(kind), [resourceId, req.userId])
    const projectId = result.rows[0]?.project_id as string | undefined
    if (!projectId || (req.authProjectId && req.authProjectId !== projectId)) {
      // Deliberately use 404 so callers cannot enumerate another user's resources.
      reply.status(404).send({ error: 'Resource not found' })
      return
    }
    req.ownedProjectId = projectId
  }
}

export const requireProjectOwner = (paramName = 'id') => ownerGuard('project', paramName)
export const requireSourceFileOwner = (paramName = 'id') => ownerGuard('sourceFile', paramName)
export const requireClipOwner = (paramName = 'id') => ownerGuard('clip', paramName)
export const requireExportOwner = (paramName = 'id') => ownerGuard('export', paramName)
export const requireThumbnailOwner = (paramName = 'key') => ownerGuard('thumbnail', paramName)
