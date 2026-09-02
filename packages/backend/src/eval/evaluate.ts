export type EvalEventType = 'goal' | 'save'

export interface GroundTruthEvent {
  type: EvalEventType
  timestamp: number
  timecodeIn: number
  timecodeOut: number
}

export interface PredictedEvent {
  type: string
  timecodeIn: number
  timecodeOut: number
  confidence: number
}

export interface EvalSource {
  id: string
  events: GroundTruthEvent[]
}

export interface PredictionRun {
  sourceId: string
  processingMs: number
  costUsd: number
  detections: PredictedEvent[]
}

export interface EventMetrics {
  truePositives: number
  falsePositives: number
  falseNegatives: number
  precision: number
  recall: number
  f1: number
  meanStartErrorSecs: number | null
  meanEndErrorSecs: number | null
  meanBoundaryErrorSecs: number | null
}

export interface EvaluationReport {
  toleranceSecs: number
  byEvent: Record<EvalEventType, EventMetrics>
  overall: EventMetrics
  processing: {
    runs: number
    totalMs: number
    meanMs: number
    totalCostUsd: number
    meanCostUsd: number
  }
}

interface Match {
  truth: GroundTruthEvent
  prediction: PredictedEvent
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function summarize(matches: Match[], falsePositives: number, falseNegatives: number): EventMetrics {
  const truePositives = matches.length
  const precision = safeRatio(truePositives, truePositives + falsePositives)
  const recall = safeRatio(truePositives, truePositives + falseNegatives)
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)
  const startErrors = matches.map((match) => Math.abs(match.prediction.timecodeIn - match.truth.timecodeIn))
  const endErrors = matches.map((match) => Math.abs(match.prediction.timecodeOut - match.truth.timecodeOut))
  const mean = (values: number[]) => values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
  const meanStartErrorSecs = mean(startErrors)
  const meanEndErrorSecs = mean(endErrors)

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    meanStartErrorSecs,
    meanEndErrorSecs,
    meanBoundaryErrorSecs: meanStartErrorSecs == null || meanEndErrorSecs == null
      ? null
      : (meanStartErrorSecs + meanEndErrorSecs) / 2,
  }
}

function matchSource(
  truths: GroundTruthEvent[],
  predictions: PredictedEvent[],
  eventType: EvalEventType,
  toleranceSecs: number,
): { matches: Match[]; falsePositives: number; falseNegatives: number } {
  const typedTruths = truths
    .filter((event) => event.type === eventType)
    .sort((a, b) => a.timestamp - b.timestamp)
  const typedPredictions = predictions
    .filter((event) => event.type === eventType)
    .sort((a, b) => {
      const aCenter = (a.timecodeIn + a.timecodeOut) / 2
      const bCenter = (b.timecodeIn + b.timecodeOut) / 2
      return aCenter - bCenter
    })

  interface Cell {
    count: number
    distance: number
    confidence: number
    action: 'none' | 'skip-truth' | 'skip-prediction' | 'match'
  }
  const better = (candidate: Cell, current: Cell) => candidate.count > current.count
    || (candidate.count === current.count && candidate.distance < current.distance)
    || (candidate.count === current.count && candidate.distance === current.distance
      && candidate.confidence > current.confidence)
  const dp: Cell[][] = Array.from(
    { length: typedTruths.length + 1 },
    () => Array.from(
      { length: typedPredictions.length + 1 },
      (): Cell => ({ count: 0, distance: 0, confidence: 0, action: 'none' }),
    ),
  )

  for (let i = 1; i <= typedTruths.length; i++) dp[i][0].action = 'skip-truth'
  for (let j = 1; j <= typedPredictions.length; j++) dp[0][j].action = 'skip-prediction'

  for (let i = 1; i <= typedTruths.length; i++) {
    for (let j = 1; j <= typedPredictions.length; j++) {
      const skipTruth: Cell = { ...dp[i - 1][j], action: 'skip-truth' }
      const skipPrediction: Cell = { ...dp[i][j - 1], action: 'skip-prediction' }
      let best = better(skipPrediction, skipTruth) ? skipPrediction : skipTruth

      const prediction = typedPredictions[j - 1]
      const predictionCenter = (prediction.timecodeIn + prediction.timecodeOut) / 2
      const distance = Math.abs(predictionCenter - typedTruths[i - 1].timestamp)
      if (distance <= toleranceSecs) {
        const previous = dp[i - 1][j - 1]
        const matched: Cell = {
          count: previous.count + 1,
          distance: previous.distance + distance,
          confidence: previous.confidence + prediction.confidence,
          action: 'match',
        }
        if (better(matched, best)) best = matched
      }
      dp[i][j] = best
    }
  }

  const matches: Match[] = []
  let i = typedTruths.length
  let j = typedPredictions.length
  while (i > 0 || j > 0) {
    const action = dp[i][j].action
    if (action === 'match') {
      matches.push({ truth: typedTruths[i - 1], prediction: typedPredictions[j - 1] })
      i--
      j--
    } else if (action === 'skip-truth') {
      i--
    } else if (action === 'skip-prediction') {
      j--
    } else {
      break
    }
  }

  return {
    matches: matches.reverse(),
    falsePositives: typedPredictions.length - matches.length,
    falseNegatives: typedTruths.length - matches.length,
  }
}

export function evaluate(
  sources: EvalSource[],
  runs: PredictionRun[],
  toleranceSecs = 3,
): EvaluationReport {
  const runBySource = new Map(runs.map((run) => [run.sourceId, run]))
  const eventResults = new Map<EvalEventType, { matches: Match[]; fp: number; fn: number }>([
    ['goal', { matches: [], fp: 0, fn: 0 }],
    ['save', { matches: [], fp: 0, fn: 0 }],
  ])

  for (const source of sources) {
    const predictions = runBySource.get(source.id)?.detections ?? []
    for (const eventType of ['goal', 'save'] as const) {
      const result = matchSource(source.events, predictions, eventType, toleranceSecs)
      const aggregate = eventResults.get(eventType)!
      aggregate.matches.push(...result.matches)
      aggregate.fp += result.falsePositives
      aggregate.fn += result.falseNegatives
    }
  }

  const goal = eventResults.get('goal')!
  const save = eventResults.get('save')!
  const byEvent = {
    goal: summarize(goal.matches, goal.fp, goal.fn),
    save: summarize(save.matches, save.fp, save.fn),
  }
  const totalMs = runs.reduce((sum, run) => sum + run.processingMs, 0)
  const totalCostUsd = runs.reduce((sum, run) => sum + run.costUsd, 0)

  return {
    toleranceSecs,
    byEvent,
    overall: summarize(
      [...goal.matches, ...save.matches],
      goal.fp + save.fp,
      goal.fn + save.fn,
    ),
    processing: {
      runs: runs.length,
      totalMs,
      meanMs: safeRatio(totalMs, runs.length),
      totalCostUsd,
      meanCostUsd: safeRatio(totalCostUsd, runs.length),
    },
  }
}
