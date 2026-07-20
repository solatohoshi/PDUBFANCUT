import fp from 'fastify-plugin'
import { Pool } from 'pg'

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
