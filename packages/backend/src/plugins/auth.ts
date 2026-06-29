import { createClerkClient } from '@clerk/backend'
import type { FastifyRequest, FastifyReply } from 'fastify'

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! })

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) {
    reply.status(401).send({ error: 'Missing authorization token' })
    return
  }

  try {
    const payload = await clerk.verifyToken(token)
    ;(req as any).clerkUserId = payload.sub
  } catch {
    reply.status(401).send({ error: 'Invalid or expired token' })
  }
}

export function getClerkUserId(req: FastifyRequest): string {
  return (req as any).clerkUserId as string
}

export async function upsertUser(
  pg: any,
  clerkUserId: string,
  email: string
): Promise<string> {
  const result = await pg.query(
    `INSERT INTO users (clerk_id, email)
     VALUES ($1, $2)
     ON CONFLICT (clerk_id) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [clerkUserId, email]
  )
  return result.rows[0].id as string
}
