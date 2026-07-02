import fp from 'fastify-plugin'
import { Pool, neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws

declare module 'fastify' {
  interface FastifyInstance {
    pg: Pool
  }
}

export const dbPlugin = fp(async (fastify) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
  fastify.decorate('pg', pool)
  fastify.addHook('onClose', async () => { await pool.end() })
})
