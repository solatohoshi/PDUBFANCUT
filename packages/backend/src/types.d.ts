import 'fastify'

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    authProjectId?: string
    ownedProjectId?: string
  }
}
