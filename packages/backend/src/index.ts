import Fastify from 'fastify'
import cors from '@fastify/cors'
import { dbPlugin } from './plugins/db'
import authPlugin from './plugins/auth'
import { uploadRoutes } from './routes/upload'
import { projectRoutes } from './routes/projects'
import { fileRoutes } from './routes/files'
import { exportRoutes } from './routes/exports'
import { clipRoutes } from './routes/clips'

const fastify = Fastify({ logger: { level: 'info' } })

async function main() {
  await fastify.register(cors, {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Tus-Resumable',
      'Upload-Length',
      'Upload-Metadata',
      'Upload-Offset',
      'X-HTTP-Method-Override',
      'X-Requested-With',
    ],
    exposedHeaders: ['Location', 'Tus-Resumable', 'Upload-Offset', 'Upload-Length'],
    credentials: true,
  })

  await fastify.register(dbPlugin)
  await fastify.register(authPlugin)
  await fastify.register(projectRoutes, { prefix: '/api' })
  await fastify.register(uploadRoutes, { prefix: '/api' })
  await fastify.register(fileRoutes, { prefix: '/api' })
  await fastify.register(exportRoutes, { prefix: '/api' })
  await fastify.register(clipRoutes,   { prefix: '/api' })

  fastify.get('/healthz', async () => ({ ok: true }))

  const port = parseInt(process.env.PORT || '3001')
  await fastify.listen({ port, host: '0.0.0.0' })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
