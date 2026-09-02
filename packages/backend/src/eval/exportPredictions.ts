import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import type { PredictionRun } from './evaluate'

interface RunMap {
  sources: Array<{
    corpusSourceId: string
    sourceFileId: string
    analysisRunId: string
  }>
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const mapPath = argument('--map')
  const outputPath = argument('--out')
  if (!mapPath || !outputPath) {
    throw new Error('Usage: npm run eval:export -- --map <run-map.json> --out <predictions.json>')
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  const commandRoot = process.env.INIT_CWD ?? process.cwd()
  const resolvedMapPath = resolve(commandRoot, mapPath)
  const resolvedOutputPath = resolve(commandRoot, outputPath)
  const map = JSON.parse(await readFile(resolvedMapPath, 'utf8')) as RunMap
  if (!Array.isArray(map.sources) || map.sources.length === 0) {
    throw new Error('Run map must contain at least one source')
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const runs: PredictionRun[] = []
    for (const item of map.sources) {
      if (!item.corpusSourceId || !item.sourceFileId || !item.analysisRunId) {
        throw new Error('Each run-map source needs corpusSourceId, sourceFileId, and analysisRunId')
      }
      const result = await pool.query(
        `SELECT ar.processing_ms, ar.estimated_cost_usd,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'type', d.event_type,
                      'timecodeIn', d.timecode_in,
                      'timecodeOut', d.timecode_out,
                      'confidence', d.confidence
                    ) ORDER BY d.timecode_in
                  ) FILTER (WHERE d.id IS NOT NULL AND d.event_type IN ('goal', 'save')),
                  '[]'::json
                ) AS detections
           FROM analysis_runs ar
           LEFT JOIN detections d ON d.analysis_run_id = ar.id
          WHERE ar.id = $1 AND ar.source_file_id = $2 AND ar.status = 'completed'
          GROUP BY ar.id`,
        [item.analysisRunId, item.sourceFileId],
      )
      const row = result.rows[0]
      if (!row) {
        throw new Error(`Completed analysis run ${item.analysisRunId} was not found for source ${item.sourceFileId}`)
      }
      runs.push({
        sourceId: item.corpusSourceId,
        processingMs: Number(row.processing_ms ?? 0),
        costUsd: Number(row.estimated_cost_usd ?? 0),
        detections: row.detections.map((detection: Record<string, unknown>) => ({
          type: String(detection.type),
          timecodeIn: Number(detection.timecodeIn),
          timecodeOut: Number(detection.timecodeOut),
          confidence: Number(detection.confidence),
        })),
      })
    }

    await writeFile(resolvedOutputPath, `${JSON.stringify({ runs }, null, 2)}\n`, 'utf8')
    console.log(`Exported ${runs.length} completed analysis run(s) to ${resolvedOutputPath}`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
