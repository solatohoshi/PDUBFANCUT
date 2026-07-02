import type { FastifyInstance } from 'fastify'

export async function clipRoutes(fastify: FastifyInstance) {
  fastify.patch<{
    Params: { id: string }
    Body: { review_status: 'confirmed' | 'dismissed' | 'auto' }
  }>('/clips/:id', async (req, reply) => {
    const { id } = req.params
    const { review_status } = req.body

    if (!['confirmed', 'dismissed', 'auto'].includes(review_status)) {
      reply.status(400).send({ error: 'review_status must be confirmed, dismissed, or auto' })
      return
    }

    const result = await fastify.pg.query(
      `UPDATE clips SET review_status = $2
       WHERE id = $1
       RETURNING id, project_id, source_file_id, timecode_in, timecode_out,
                 scene_tags, players, confidence, thumb_key, review_status, created_at`,
      [id, review_status],
    )

    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Clip not found' })
      return
    }

    reply.send(result.rows[0])
  })
}
