import type { FastifyInstance } from 'fastify'
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { mkdirSync, existsSync } from 'node:fs'
import { rm, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { enqueueAnalysis } from '../jobs/queue'
import { sendClipsReadyEmail } from '../lib/notify'
import { hasFFmpeg, generateClipThumbnail, ffprobe } from '../lib/ffmpeg'
import { analyzeVideoForClips } from '../lib/analyzeVideo'

const R2_READY = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_BUCKET
)
const LOCAL_UPLOADS_DIR = join(tmpdir(), 'pdubfancut-uploads')

function makeS3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID ?? 'placeholder'}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID  ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  })
}

export async function projectRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: {
      name: string
      analysisMode: 'full' | 'quick'
      quickSearchParams?: { players: string[]; scenes: string[] }
    }
  }>('/projects', async (req, reply) => {
    const { name, analysisMode, quickSearchParams } = req.body
    const userId = req.userId ?? null

    const result = await fastify.pg.query(
      `INSERT INTO projects (name, analysis_mode, quick_search_params, user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, analysis_mode, status, created_at`,
      [name, analysisMode, quickSearchParams ? JSON.stringify(quickSearchParams) : null, userId]
    )

    reply.status(201).send(result.rows[0])
  })

  fastify.get('/projects', async (req, reply) => {
    const userId = req.userId
    const result = userId
      ? await fastify.pg.query(
          `SELECT id, name, analysis_mode, status, created_at, updated_at
           FROM projects WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        )
      : await fastify.pg.query(
          `SELECT id, name, analysis_mode, status, created_at, updated_at
           FROM projects ORDER BY created_at DESC`,
        )
    reply.send(result.rows)
  })

  fastify.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const { id } = req.params
    // Only allow deletion of projects that never completed — prevents accidental
    // loss of finished projects that the user might still need.
    const result = await fastify.pg.query(
      `DELETE FROM projects
       WHERE id = $1
         AND status IN ('uploading', 'failed')
         AND (user_id = $2 OR user_id IS NULL OR $2 IS NULL)
       RETURNING id`,
      [id, req.userId ?? null],
    )
    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Project not found or cannot be deleted' })
      return
    }
    reply.status(204).send()
  })

  fastify.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const result = await fastify.pg.query(
      `SELECT p.id, p.name, p.analysis_mode, p.quick_search_params,
              p.status, p.file_hash, p.created_at, p.updated_at,
              json_agg(sf.*) FILTER (WHERE sf.id IS NOT NULL) AS source_files,
              json_agg(j.*) FILTER (WHERE j.id IS NOT NULL) AS jobs
       FROM projects p
       LEFT JOIN source_files sf ON sf.project_id = p.id
       LEFT JOIN jobs j ON j.project_id = p.id
       WHERE p.id = $1
         AND (p.user_id = $2 OR p.user_id IS NULL OR $2 IS NULL)
       GROUP BY p.id`,
      [req.params.id, req.userId ?? null]
    )

    if (!result.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }

    reply.send(result.rows[0])
  })

  fastify.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    '/projects/:id/clips',
    async (req, reply) => {
      const { id } = req.params
      const { status } = req.query

      // Verify project exists
      const proj = await fastify.pg.query(`SELECT id FROM projects WHERE id = $1`, [id])
      if (!proj.rows[0]) {
        reply.status(404).send({ error: 'Project not found' })
        return
      }

      const result = await fastify.pg.query(
        `SELECT id, project_id, source_file_id,
                timecode_in, timecode_out,
                scene_tags, players, confidence, thumb_key, review_status, created_at
         FROM clips
         WHERE project_id = $1
           ${status ? `AND review_status = $2` : ''}
         ORDER BY timecode_in`,
        status ? [id, status] : [id],
      )

      reply.send(result.rows)
    },
  )

  // ── Backfill thumbnails for clips that don't have one ─────────────────────
  // Responds 202 immediately; generation runs in the background.
  fastify.post<{ Params: { id: string } }>('/projects/:id/rethumb', async (req, reply) => {
    const { id } = req.params
    reply.status(202).send({ message: 'Thumbnail generation started' })

    ;(async () => {
      try {
        if (!await hasFFmpeg()) {
          fastify.log.warn({ projectId: id }, 'ffmpeg not available — cannot backfill thumbnails')
          return
        }

        const clipsRes = await fastify.pg.query(
          `SELECT c.id, c.timecode_in, c.timecode_out, sf.s3_key, sf.duration_secs
           FROM clips c
           JOIN source_files sf ON sf.id = c.source_file_id
           WHERE c.project_id = $1 AND c.thumb_key IS NULL`,
          [id],
        )
        if (clipsRes.rows.length === 0) return

        fastify.log.info({ projectId: id, count: clipsRes.rows.length }, 'Starting thumbnail backfill')
        const s3 = makeS3()

        // Group by s3_key so we generate one presigned URL per source video
        const byKey = new Map<string, typeof clipsRes.rows>()
        for (const row of clipsRes.rows) {
          if (!byKey.has(row.s3_key)) byKey.set(row.s3_key, [])
          byKey.get(row.s3_key)!.push(row)
        }

        for (const [s3Key, clips] of byKey) {
          const videoSource = R2_READY
            ? await getSignedUrl(
                s3,
                new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: s3Key }),
                { expiresIn: 3600 },
              )
            : join(LOCAL_UPLOADS_DIR, s3Key)

          for (const clip of clips) {
            const rawMid = (parseFloat(clip.timecode_in) + parseFloat(clip.timecode_out)) / 2
            const dur = clip.duration_secs ? parseFloat(clip.duration_secs) : undefined
            const midSecs = dur ? Math.min(rawMid, Math.max(0, dur - 0.5)) : Math.max(0, rawMid)
            const thumbKey = `thumb-${clip.id}.jpg`
            const tmpThumbPath = join(tmpdir(), thumbKey)
            try {
              await generateClipThumbnail(videoSource, midSecs, tmpThumbPath)
              // If ffmpeg wrote 0 frames (seek past actual content), fall back to time 0
              if (!existsSync(tmpThumbPath)) {
                fastify.log.warn({ clipId: clip.id, midSecs }, 'No frame at midpoint — retrying at t=0')
                await generateClipThumbnail(videoSource, 0, tmpThumbPath)
              }
              const thumbBuf = await readFile(tmpThumbPath)
              if (R2_READY) {
                await s3.send(new PutObjectCommand({
                  Bucket: process.env.R2_BUCKET!,
                  Key: thumbKey,
                  Body: thumbBuf,
                  ContentLength: thumbBuf.byteLength,
                  ContentType: 'image/jpeg',
                }))
              } else {
                const thumbDir = join(LOCAL_UPLOADS_DIR, 'thumbs')
                mkdirSync(thumbDir, { recursive: true })
                await rename(tmpThumbPath, join(thumbDir, thumbKey))
              }
              await fastify.pg.query(
                `UPDATE clips SET thumb_key = $1 WHERE id = $2`,
                [thumbKey, clip.id],
              )
              fastify.log.info({ clipId: clip.id, thumbKey }, 'Thumbnail generated')
            } catch (err: any) {
              fastify.log.warn({ err: err.message, clipId: clip.id }, 'Thumbnail generation failed')
            } finally {
              await rm(tmpThumbPath, { force: true }).catch(() => {})
            }
          }
        }

        fastify.log.info({ projectId: id }, 'Thumbnail backfill complete')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, projectId: id }, 'Thumbnail backfill error')
      }
    })()
  })

  // ── Re-analyze a project from scratch (delete clips → re-run Claude) ─────────
  // Use this to fix projects that were analyzed before ffprobe+duration were available.
  fastify.post<{ Params: { id: string } }>('/projects/:id/reanalyze', async (req, reply) => {
    const { id } = req.params
    const proj = await fastify.pg.query(
      `SELECT sf.id AS sf_id, sf.s3_key, sf.duration_secs, sf.tus_upload_id,
              p.name, p.user_id
       FROM projects p
       JOIN source_files sf ON sf.project_id = p.id
       WHERE p.id = $1 AND p.status = 'ready'
       LIMIT 1`,
      [id],
    )
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found or not ready' })
      return
    }
    const { sf_id, s3_key } = proj.rows[0]

    await fastify.pg.query(`UPDATE projects SET status = 'processing', updated_at = NOW() WHERE id = $1`, [id])
    reply.status(202).send({ message: 'Re-analysis started' })

    ;(async () => {
      try {
        const s3 = makeS3()

        // Separate presigned URLs: short-lived for ffprobe, 2-hour for Claude
        const makeVideoSource = async (expiresIn: number) => R2_READY
          ? { type: 'url' as const, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: s3_key }), { expiresIn }) }
          : { type: 'file' as const, path: join(LOCAL_UPLOADS_DIR, s3_key), mimeType: 'video/mp4' }

        // Re-run ffprobe to get accurate duration (stored value may be stale/wrong)
        let durationSecs: number | undefined
        if (await hasFFmpeg()) {
          const probeSource = await makeVideoSource(300)
          const probeTarget = R2_READY ? probeSource.url : (probeSource as any).path
          const meta = await ffprobe(probeTarget)
          if (meta && meta.duration_secs > 0) {
            durationSecs = meta.duration_secs
            await fastify.pg.query(
              `UPDATE source_files SET duration_secs=$2 WHERE id=$1`,
              [sf_id, durationSecs],
            )
            fastify.log.info({ projectId: id, durationSecs }, 'Re-analysis: ffprobe duration')
          }
        }

        const videoSource = await makeVideoSource(7200)
        fastify.log.info({ projectId: id, durationSecs }, 'Re-analysis: starting Claude…')
        const rawClips = await analyzeVideoForClips(videoSource, durationSecs)

        let clips = durationSecs
          ? rawClips.filter((c) => c.timecode_in >= 0 && c.timecode_in < durationSecs!)
          : rawClips

        if (clips.length === 0 && durationSecs && durationSecs > 0) {
          clips = [{ timecode_in: 0, timecode_out: durationSecs, scene_tags: [{ tag: 'shot_on_goal', confidence: 0.5 }], players: [], confidence: 0.5 }]
        }

        // Delete old clips for this project and insert fresh ones
        await fastify.pg.query(`DELETE FROM clips WHERE project_id = $1`, [id])

        const ffmpegAvail = await hasFFmpeg()
        // Generate a fresh presigned URL for ffmpeg (Claude's URL may have partially aged)
        const thumbSource = await makeVideoSource(3600)
        const ffmpegInput = R2_READY ? thumbSource.url : (thumbSource as any).path

        for (const clip of clips) {
          const insertRes = await fastify.pg.query(
            `INSERT INTO clips (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'auto') RETURNING id`,
            [id, sf_id, clip.timecode_in, clip.timecode_out, JSON.stringify(clip.scene_tags), JSON.stringify(clip.players), Math.min(1, Math.max(0, clip.confidence))],
          )
          const clipId: string = insertRes.rows[0].id

          if (ffmpegAvail) {
            const midSecs = (clip.timecode_in + clip.timecode_out) / 2
            const thumbKey = `thumb-${clipId}.jpg`
            const tmpThumbPath = join(tmpdir(), thumbKey)
            try {
              await generateClipThumbnail(ffmpegInput, midSecs, tmpThumbPath)
              if (!existsSync(tmpThumbPath)) await generateClipThumbnail(ffmpegInput, 0, tmpThumbPath)
              const thumbBuf = await readFile(tmpThumbPath)
              if (R2_READY) {
                await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: thumbKey, Body: thumbBuf, ContentLength: thumbBuf.byteLength, ContentType: 'image/jpeg' }))
              } else {
                mkdirSync(join(LOCAL_UPLOADS_DIR, 'thumbs'), { recursive: true })
                await rename(tmpThumbPath, join(LOCAL_UPLOADS_DIR, 'thumbs', thumbKey))
              }
              await fastify.pg.query(`UPDATE clips SET thumb_key = $1 WHERE id = $2`, [thumbKey, clipId])
            } catch (e: any) {
              fastify.log.warn({ err: e.message, clipId }, 'Thumb gen failed during reanalyze')
            } finally {
              await rm(tmpThumbPath, { force: true }).catch(() => {})
            }
          }
        }

        await fastify.pg.query(`UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`, [id])
        fastify.log.info({ projectId: id, clipCount: clips.length }, 'Re-analysis complete')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, projectId: id }, 'Re-analysis failed')
        await fastify.pg.query(`UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`, [id]).catch(() => {})
      }
    })()
  })

  // ── Upgrade quick search project to full analysis ──────────────────────────
  fastify.post<{ Params: { id: string }; Body: Record<string, never> }>(
    '/projects/:id/full-analysis', async (req, reply) => {
    const { id } = req.params
    const proj = await fastify.pg.query(
      `SELECT p.id, p.name, p.analysis_mode, p.user_id,
              sf.id AS sf_id, sf.s3_key, sf.duration_secs
       FROM projects p
       JOIN source_files sf ON sf.project_id = p.id
       WHERE p.id = $1
       LIMIT 1`,
      [id],
    )
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }
    if (proj.rows[0].analysis_mode === 'full') {
      reply.status(409).send({ error: 'Already running full analysis' })
      return
    }
    const { name: projectName, user_id: projectUserId, sf_id, s3_key } = proj.rows[0]

    await fastify.pg.query(
      `UPDATE projects
       SET analysis_mode = 'full', quick_search_params = NULL,
           status = 'processing', updated_at = NOW()
       WHERE id = $1`,
      [id],
    )
    const jobRes = await fastify.pg.query(
      `INSERT INTO jobs (project_id, type, status) VALUES ($1, 'full_analysis', 'pending') RETURNING id`,
      [id],
    )
    reply.status(202).send({ message: 'Full analysis started' })

    ;(async () => {
      try {
        const s3 = makeS3()
        const makeVideoSource = async (expiresIn: number) => R2_READY
          ? { type: 'url' as const, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: s3_key }), { expiresIn }) }
          : { type: 'file' as const, path: join(LOCAL_UPLOADS_DIR, s3_key), mimeType: 'video/mp4' }

        let durationSecs: number | undefined
        if (await hasFFmpeg()) {
          const probeSource = await makeVideoSource(300)
          const meta = await ffprobe(R2_READY ? probeSource.url : (probeSource as any).path)
          if (meta && meta.duration_secs > 0) {
            durationSecs = meta.duration_secs
            await fastify.pg.query(`UPDATE source_files SET duration_secs=$2 WHERE id=$1`, [sf_id, durationSecs])
          }
        }

        const videoSource = await makeVideoSource(7200)
        const rawClips = await analyzeVideoForClips(videoSource, durationSecs)
        let clips = durationSecs ? rawClips.filter((c) => c.timecode_in >= 0 && c.timecode_in < durationSecs!) : rawClips
        if (clips.length === 0 && durationSecs && durationSecs > 0) {
          clips = [{ timecode_in: 0, timecode_out: durationSecs, scene_tags: [{ tag: 'shot_on_goal', confidence: 0.5 }], players: [], confidence: 0.5 }]
        }

        await fastify.pg.query(`DELETE FROM clips WHERE project_id = $1`, [id])

        const ffmpegAvail = await hasFFmpeg()
        const thumbSource = await makeVideoSource(3600)
        const ffmpegInput = R2_READY ? thumbSource.url : (thumbSource as any).path

        for (const clip of clips) {
          const insertRes = await fastify.pg.query(
            `INSERT INTO clips (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'auto') RETURNING id`,
            [id, sf_id, clip.timecode_in, clip.timecode_out, JSON.stringify(clip.scene_tags), JSON.stringify(clip.players), Math.min(1, Math.max(0, clip.confidence))],
          )
          const clipId: string = insertRes.rows[0].id
          if (ffmpegAvail) {
            const midSecs = (clip.timecode_in + clip.timecode_out) / 2
            const thumbKey = `thumb-${clipId}.jpg`
            const tmpThumbPath = join(tmpdir(), thumbKey)
            try {
              await generateClipThumbnail(ffmpegInput, midSecs, tmpThumbPath)
              if (!existsSync(tmpThumbPath)) await generateClipThumbnail(ffmpegInput, 0, tmpThumbPath)
              const thumbBuf = await readFile(tmpThumbPath)
              if (R2_READY) {
                await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: thumbKey, Body: thumbBuf, ContentLength: thumbBuf.byteLength, ContentType: 'image/jpeg' }))
              } else {
                mkdirSync(join(LOCAL_UPLOADS_DIR, 'thumbs'), { recursive: true })
                await rename(tmpThumbPath, join(LOCAL_UPLOADS_DIR, 'thumbs', thumbKey))
              }
              await fastify.pg.query(`UPDATE clips SET thumb_key=$1 WHERE id=$2`, [thumbKey, clipId])
            } catch { } finally { await rm(tmpThumbPath, { force: true }).catch(() => {}) }
          }
        }

        await fastify.pg.query(`UPDATE jobs SET status='completed', updated_at=NOW() WHERE id=$1`, [jobRes.rows[0].id])
        await fastify.pg.query(`UPDATE projects SET status='ready', updated_at=NOW() WHERE id=$1`, [id])
        await sendClipsReadyEmail({ log: fastify.log }, id, projectName, projectUserId).catch(() => {})
        fastify.log.info({ projectId: id, clipCount: clips.length }, 'Full analysis complete')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, projectId: id }, 'Full analysis failed')
        await fastify.pg.query(`UPDATE jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [jobRes.rows[0].id]).catch(() => {})
        await fastify.pg.query(`UPDATE projects SET status='ready', updated_at=NOW() WHERE id=$1`, [id]).catch(() => {})
      }
    })()
  })

  // ── Add new quick-search target to an existing project ────────────────────
  fastify.post<{
    Params: { id: string }
    Body: { players?: string[]; scenes?: string[] }
  }>('/projects/:id/searches', async (req, reply) => {
    const { id } = req.params
    const { players = [], scenes = [] } = req.body

    if (players.length === 0 && scenes.length === 0) {
      reply.status(400).send({ error: 'Provide at least one player or scene to search' })
      return
    }

    const proj = await fastify.pg.query(
      `SELECT p.id, p.name, p.quick_search_params, p.user_id,
              sf.id AS sf_id, sf.s3_key, sf.duration_secs
       FROM projects p
       JOIN source_files sf ON sf.project_id = p.id
       WHERE p.id = $1 LIMIT 1`, [id],
    )
    if (!proj.rows[0]) {
      reply.status(404).send({ error: 'Project not found' })
      return
    }
    const { name: searchProjectName, user_id: searchUserId, sf_id, s3_key } = proj.rows[0]

    const existing = proj.rows[0].quick_search_params ?? { players: [], scenes: [] }
    const merged = {
      players: [...new Set([...existing.players, ...players])],
      scenes:  [...new Set([...existing.scenes,  ...scenes])],
    }

    await fastify.pg.query(
      `UPDATE projects SET quick_search_params=$2, status='processing', updated_at=NOW() WHERE id=$1`,
      [id, JSON.stringify(merged)],
    )
    const jobRes = await fastify.pg.query(
      `INSERT INTO jobs (project_id, type, status) VALUES ($1,'quick_search','pending') RETURNING id`, [id],
    )
    reply.status(202).send({ message: 'Search started', params: merged })

    ;(async () => {
      try {
        const s3 = makeS3()
        const makeVideoSource = async (expiresIn: number) => R2_READY
          ? { type: 'url' as const, url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: s3_key }), { expiresIn }) }
          : { type: 'file' as const, path: join(LOCAL_UPLOADS_DIR, s3_key), mimeType: 'video/mp4' }

        let durationSecs: number | undefined
        if (await hasFFmpeg()) {
          const probeSource = await makeVideoSource(300)
          const meta = await ffprobe(R2_READY ? probeSource.url : (probeSource as any).path)
          if (meta && meta.duration_secs > 0) durationSecs = meta.duration_secs
        }

        const videoSource = await makeVideoSource(7200)
        const rawClips = await analyzeVideoForClips(videoSource, durationSecs)
        let allNewClips = durationSecs ? rawClips.filter((c) => c.timecode_in >= 0 && c.timecode_in < durationSecs!) : rawClips

        // Keep only clips matching the new search terms (scenes filter)
        const sceneSet = new Set(scenes)
        if (scenes.length > 0) {
          allNewClips = allNewClips.filter((c) => c.scene_tags.some((st) => sceneSet.has(st.tag)))
        }

        // Fetch existing clip timecodes to skip duplicates (within 5 s)
        const existingRes = await fastify.pg.query(
          `SELECT timecode_in FROM clips WHERE project_id=$1`, [id],
        )
        const existingTcins: number[] = existingRes.rows.map((r: any) => parseFloat(r.timecode_in))

        const newClips = allNewClips.filter((c) =>
          !existingTcins.some((tc) => Math.abs(tc - c.timecode_in) < 5),
        )

        const ffmpegAvail = await hasFFmpeg()
        const thumbSource = await makeVideoSource(3600)
        const ffmpegInput = R2_READY ? thumbSource.url : (thumbSource as any).path

        for (const clip of newClips) {
          const insertRes = await fastify.pg.query(
            `INSERT INTO clips (project_id, source_file_id, timecode_in, timecode_out, scene_tags, players, confidence, review_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'auto') RETURNING id`,
            [id, sf_id, clip.timecode_in, clip.timecode_out, JSON.stringify(clip.scene_tags), JSON.stringify(clip.players), Math.min(1, Math.max(0, clip.confidence))],
          )
          const clipId: string = insertRes.rows[0].id
          if (ffmpegAvail) {
            const midSecs = (clip.timecode_in + clip.timecode_out) / 2
            const thumbKey = `thumb-${clipId}.jpg`
            const tmpThumbPath = join(tmpdir(), thumbKey)
            try {
              await generateClipThumbnail(ffmpegInput, midSecs, tmpThumbPath)
              if (!existsSync(tmpThumbPath)) await generateClipThumbnail(ffmpegInput, 0, tmpThumbPath)
              const thumbBuf = await readFile(tmpThumbPath)
              if (R2_READY) {
                await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET!, Key: thumbKey, Body: thumbBuf, ContentLength: thumbBuf.byteLength, ContentType: 'image/jpeg' }))
              } else {
                mkdirSync(join(LOCAL_UPLOADS_DIR, 'thumbs'), { recursive: true })
                await rename(tmpThumbPath, join(LOCAL_UPLOADS_DIR, 'thumbs', thumbKey))
              }
              await fastify.pg.query(`UPDATE clips SET thumb_key=$1 WHERE id=$2`, [thumbKey, clipId])
            } catch { } finally { await rm(tmpThumbPath, { force: true }).catch(() => {}) }
          }
        }

        await fastify.pg.query(`UPDATE jobs SET status='completed', updated_at=NOW() WHERE id=$1`, [jobRes.rows[0].id])
        await fastify.pg.query(`UPDATE projects SET status='ready', updated_at=NOW() WHERE id=$1`, [id])
        await sendClipsReadyEmail({ log: fastify.log }, id, searchProjectName, searchUserId).catch(() => {})
        fastify.log.info({ projectId: id, newClips: newClips.length }, 'Add-search complete')
      } catch (err: any) {
        fastify.log.warn({ err: err.message, projectId: id }, 'Add-search failed')
        await fastify.pg.query(`UPDATE jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [jobRes.rows[0].id]).catch(() => {})
        await fastify.pg.query(`UPDATE projects SET status='ready', updated_at=NOW() WHERE id=$1`, [id]).catch(() => {})
      }
    })()
  })
}

