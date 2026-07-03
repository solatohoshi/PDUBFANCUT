import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { verifyToken } from '@clerk/backend'

// Routes that don't require authentication
const PUBLIC_PREFIXES = ['/healthz', '/api/upload']

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const secretKey = process.env.CLERK_SECRET_KEY

  if (!secretKey) {
    fastify.log.warn('CLERK_SECRET_KEY not set — auth verification disabled (dev mode)')
    return
  }

  fastify.addHook('onRequest', async (req, reply) => {
    // Skip non-API routes and tus upload endpoints
    const url = req.url.split('?')[0]
    if (PUBLIC_PREFIXES.some((p) => url.startsWith(p))) return

    const token = req.headers.authorization?.split(' ')[1]
    if (!token) {
      reply.status(401).send({ error: 'Unauthorized' })
      return
    }

    try {
      const payload = await verifyToken(token, { secretKey })
      req.userId = payload.sub
    } catch {
      reply.status(401).send({ error: 'Invalid or expired token' })
    }
  })
}

export default fp(authPlugin)
