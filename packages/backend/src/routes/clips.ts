import type { FastifyInstance } from 'fastify'
import { requireClipOwner } from '../lib/ownership'
import { idParams } from '../lib/schemas'

export async function clipRoutes(fastify: FastifyInstance) {
  fastify.patch<{
    Params: { id: string }
    Body: { review_status: 'confirmed' | 'dismissed' | 'auto' }
  }>('/clips/:id', {
    schema: {
      params: idParams(),
      body: {
        type: 'object', additionalProperties: false, required: ['review_status'],
        properties: { review_status: { type: 'string', enum: ['confirmed', 'dismissed', 'auto'] } },
      },
    },
    preHandler: requireClipOwner(),
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const { id } = req.params
    const { review_status } = req.body

    if (!['confirmed', 'dismissed', 'auto'].includes(review_status)) {
      reply.status(400).send({ error: 'review_status must be confirmed, dismissed, or auto' })
      return
    }

    const client = await fastify.pg.connect()
    let row
    try {
      await client.query('BEGIN')
      const result = await client.query(
        `UPDATE clips SET review_status = $2
         WHERE id = $1
         RETURNING id, project_id, source_file_id, analysis_run_id,
                   timecode_in, timecode_out, scene_tags, players, confidence,
                   thumb_key, review_status, created_at`,
        [id, review_status],
      )
      row = result.rows[0]

      if (row && review_status !== 'auto') {
        const primaryLabel = row.scene_tags?.[0]?.tag ?? 'unknown'
        await client.query(
          `INSERT INTO training_examples
             (project_id, source_file_id, clip_id, analysis_run_id, event_type,
              is_positive, timecode_in, timecode_out, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'review_queue',$9)
           ON CONFLICT (clip_id) DO UPDATE SET
             event_type = EXCLUDED.event_type,
             is_positive = EXCLUDED.is_positive,
             timecode_in = EXCLUDED.timecode_in,
             timecode_out = EXCLUDED.timecode_out,
             analysis_run_id = EXCLUDED.analysis_run_id,
             created_by = EXCLUDED.created_by,
             updated_at = NOW()`,
          [
            row.project_id, row.source_file_id, row.id, row.analysis_run_id,
            primaryLabel, review_status === 'confirmed', row.timecode_in,
            row.timecode_out, req.userId,
          ],
        )
      } else if (row) {
        await client.query(`DELETE FROM training_examples WHERE clip_id = $1`, [id])
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    if (!row) {
      reply.status(404).send({ error: 'Clip not found' })
      return
    }

    reply.send(row)
  })
}
