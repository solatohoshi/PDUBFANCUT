import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { verifyToken } from '@clerk/backend'

// Routes that don't require authentication
const PUBLIC_PREFIXES = ['/healthz', '/api/upload']

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const secretKey = process.env.CLERK_SECRET_KEY
  const jwtKey    = process.env.CLERK_JWT_KEY   // PEM public key for offline verification
  const devBypass = process.env.DEV_BYPASS_AUTH === 'true'

  if (devBypass) {
    fastify.log.warn('DEV_BYPASS_AUTH=true — authentication is disabled. Do not use in production.')
    return
  }

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
      // No token — allow unauthenticated access (req.userId stays undefined)
      return
    }

    try {
      const payload = await verifyToken(token, {
        secretKey,
        // jwtKey enables offline verification — no network call to Clerk's JWKS endpoint.
        // Set CLERK_JWT_KEY in .env from Clerk Dashboard → API Keys → JWT Verification Key.
        ...(jwtKey ? { jwtKey } : {}),
      })
      req.userId = payload.sub
    } catch (err: any) {
      // Log the real error so the cause is visible in server logs.
      // Common causes: network can't reach api.clerk.com (set CLERK_JWT_KEY for offline
      // verification), mismatched Clerk app keys, or genuinely expired token.
      fastify.log.warn({ errMsg: err.message }, 'Token verification failed')
      reply.status(401).send({ error: 'Invalid or expired token' })
    }
  })
}

export default fp(authPlugin)
