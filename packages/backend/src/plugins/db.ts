import fp from 'fastify-plugin'
import postgres from '@fastify/postgres'

export const dbPlugin = fp(async (fastify) => {
  await fastify.register(postgres, {
    connectionString: process.env.DATABASE_URL!,
  })
})
