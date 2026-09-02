import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evaluate, type EvalSource, type PredictionRun } from './evaluate'

interface CorpusManifest {
  version: number
  sources: Array<EvalSource & {
    videoPath: string
    license: { source: string; terms: string; confirmedBy: string }
  }>
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(process.env.INIT_CWD ?? process.cwd(), path), 'utf8')) as T
}

function validateCorpus(corpus: CorpusManifest) {
  if (corpus.version !== 1 || !Array.isArray(corpus.sources) || corpus.sources.length === 0) {
    throw new Error('Corpus manifest must contain at least one source and version=1')
  }
  const ids = new Set<string>()
  for (const source of corpus.sources) {
    if (!source.id || !source.videoPath || !source.license?.source
      || !source.license?.terms || !source.license?.confirmedBy
      || !Array.isArray(source.events)) {
      throw new Error(`Source ${source.id || '(unknown)'} is missing video or license provenance`)
    }
    if (ids.has(source.id)) throw new Error(`Corpus source id ${source.id} is duplicated`)
    ids.add(source.id)
    for (const event of source.events) {
      if (!['goal', 'save'].includes(event.type)
        || event.timecodeIn < 0 || event.timestamp < event.timecodeIn
        || event.timecodeOut <= event.timestamp) {
        throw new Error(`Source ${source.id} contains an invalid event boundary`)
      }
    }
  }
}

function validatePredictions(corpus: CorpusManifest, runs: PredictionRun[]) {
  if (!Array.isArray(runs)) throw new Error('Predictions file must contain a runs array')
  const expected = new Set(corpus.sources.map((source) => source.id))
  const seen = new Set<string>()
  for (const run of runs) {
    if (!expected.has(run.sourceId)) throw new Error(`Prediction source ${run.sourceId} is not in the corpus`)
    if (seen.has(run.sourceId)) throw new Error(`Prediction source ${run.sourceId} is duplicated`)
    if (!Number.isFinite(run.processingMs) || run.processingMs < 0
      || !Number.isFinite(run.costUsd) || run.costUsd < 0
      || !Array.isArray(run.detections)) {
      throw new Error(`Prediction run ${run.sourceId} has invalid time, cost, or detections`)
    }
    for (const detection of run.detections) {
      if (!Number.isFinite(detection.timecodeIn) || !Number.isFinite(detection.timecodeOut)
        || detection.timecodeIn < 0 || detection.timecodeOut <= detection.timecodeIn
        || !Number.isFinite(detection.confidence) || detection.confidence < 0 || detection.confidence > 1) {
        throw new Error(`Prediction run ${run.sourceId} contains an invalid detection`)
      }
    }
    seen.add(run.sourceId)
  }
  const missing = [...expected].filter((id) => !seen.has(id))
  if (missing.length) throw new Error(`Predictions are missing corpus source(s): ${missing.join(', ')}`)
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

async function main() {
  const labelsPath = argument('--labels')
  const predictionsPath = argument('--predictions')
  const tolerance = Number(argument('--tolerance') ?? 3)
  if (!labelsPath || !predictionsPath) {
    throw new Error('Usage: npm run eval -- --labels <manifest.json> --predictions <predictions.json> [--tolerance 3]')
  }

  const corpus = await json<CorpusManifest>(labelsPath)
  const predictions = await json<{ runs: PredictionRun[] }>(predictionsPath)
  validateCorpus(corpus)
  validatePredictions(corpus, predictions.runs)
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 60) {
    throw new Error('Tolerance must be a number between 0 and 60 seconds')
  }
  const report = evaluate(corpus.sources, predictions.runs, tolerance)

  console.log(`Event matching tolerance: ±${report.toleranceSecs.toFixed(1)}s`)
  console.table(Object.entries(report.byEvent).map(([event, metrics]) => ({
    event,
    TP: metrics.truePositives,
    FP: metrics.falsePositives,
    FN: metrics.falseNegatives,
    precision: percent(metrics.precision),
    recall: percent(metrics.recall),
    F1: percent(metrics.f1),
    boundaryMAE: metrics.meanBoundaryErrorSecs?.toFixed(2) ?? 'n/a',
  })))
  console.log(`Overall precision=${percent(report.overall.precision)} recall=${percent(report.overall.recall)} F1=${percent(report.overall.f1)}`)
  console.log(`Processing total=${(report.processing.totalMs / 1000).toFixed(1)}s mean=${(report.processing.meanMs / 1000).toFixed(1)}s/run`)
  console.log(`Estimated API cost total=$${report.processing.totalCostUsd.toFixed(4)} mean=$${report.processing.meanCostUsd.toFixed(4)}/run`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
