import fp from 'fastify-plugin'
import type { FastifyPluginAsync } from 'fastify'
import { verifyToken } from '@clerk/backend'
import { bearerToken, validateCapabilityTokenConfig, verifyCapabilityToken } from '../lib/capabilityTokens'

const PUBLIC_PATHS = new Set(['/healthz'])

function requestPath(rawUrl: string): string {
  return new URL(rawUrl, 'http://pdubfancut.local').pathname
}

function mediaCapability(rawUrl: string): string | null {
  return new URL(rawUrl, 'http://pdubfancut.local').searchParams.get('token')
}

function isMediaPath(path: string): boolean {
  return [
    /^\/api\/files\/[0-9a-fA-F-]{36}\/stream$/,
    /^\/api\/files\/thumb-[0-9a-fA-F-]{36}\.jpg$/,
    /^\/api\/source-files\/[0-9a-fA-F-]{36}\/frame$/,
    /^\/api\/projects\/[0-9a-fA-F-]{36}\/music\/stream$/,
    /^\/api\/exports\/[0-9a-fA-F-]{36}\/download$/,
  ].some((pattern) => pattern.test(path))
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  const secretKey = process.env.CLERK_SECRET_KEY
  const jwtKey = process.env.CLERK_JWT_KEY
  const devBypass = process.env.DEV_BYPASS_AUTH === 'true'

  if (process.env.NODE_ENV === 'production' && devBypass) {
    throw new Error('DEV_BYPASS_AUTH cannot be enabled in production')
  }
  if (!devBypass && !secretKey) {
    throw new Error('CLERK_SECRET_KEY is required unless DEV_BYPASS_AUTH=true in local development')
  }
  validateCapabilityTokenConfig()

  if (devBypass) {
    fastify.log.warn('DEV_BYPASS_AUTH=true — using the isolated local development identity')
  }

  fastify.addHook('onRequest', async (req, reply) => {
    const path = requestPath(req.raw.url ?? req.url)
    if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(path) || !path.startsWith('/api/')) return

    // tus traffic is authenticated by the upload capability in upload.ts.
    if (path === '/api/upload' || path.startsWith('/api/upload/')) return

    // Browser-native media elements cannot attach a Clerk Authorization
    // header. They receive a short-lived project-scoped media capability from
    // an authenticated JSON request.
    const signedMediaToken = mediaCapability(req.raw.url ?? req.url)
    if (signedMediaToken && isMediaPath(path) && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const claims = verifyCapabilityToken(signedMediaToken, 'media')
        req.userId = claims.sub
        req.authProjectId = claims.projectId
        return
      } catch {
        reply.status(401).send({ error: 'Invalid or expired media token' })
        return
      }
    }

    if (devBypass) {
      req.userId = process.env.DEV_USER_ID || 'local-development-user'
      return
    }

    const token = bearerToken(req.headers.authorization)
    if (!token) {
      reply.status(401).send({ error: 'Authentication required' })
      return
    }

    try {
      const payload = await verifyToken(token, {
        secretKey: secretKey!,
        ...(jwtKey ? { jwtKey } : {}),
      })
      req.userId = payload.sub
    } catch (err: any) {
      fastify.log.warn({ errMsg: err.message }, 'Clerk token verification failed')
      reply.status(401).send({ error: 'Invalid or expired session' })
    }
  })
}

export default fp(authPlugin)
