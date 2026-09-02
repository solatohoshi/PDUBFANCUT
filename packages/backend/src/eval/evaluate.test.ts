import assert from 'node:assert/strict'
import { evaluate } from './evaluate'

const report = evaluate([
  {
    id: 'game-1',
    events: [
      { type: 'goal', timestamp: 10, timecodeIn: 8, timecodeOut: 14 },
      { type: 'save', timestamp: 30, timecodeIn: 28, timecodeOut: 33 },
    ],
  },
], [
  {
    sourceId: 'game-1', processingMs: 2000, costUsd: 0.12,
    detections: [
      { type: 'goal', timecodeIn: 7, timecodeOut: 13, confidence: 0.9 },
      { type: 'goal', timecodeIn: 50, timecodeOut: 52, confidence: 0.7 },
      { type: 'save', timecodeIn: 28, timecodeOut: 34, confidence: 0.8 },
    ],
  },
], 3)

assert.equal(report.byEvent.goal.truePositives, 1)
assert.equal(report.byEvent.goal.falsePositives, 1)
assert.equal(report.byEvent.goal.falseNegatives, 0)
assert.equal(report.byEvent.save.truePositives, 1)
assert.equal(report.overall.precision, 2 / 3)
assert.equal(report.overall.recall, 1)
assert.equal(report.processing.totalCostUsd, 0.12)

// Matching must maximize event count. A confidence-first greedy matcher would
// attach the first prediction to t=10 and incorrectly leave the second pair
// unmatched, even though a valid two-event assignment exists.
const ambiguous = evaluate([{
  id: 'game-2',
  events: [
    { type: 'goal', timestamp: 10, timecodeIn: 8, timecodeOut: 12 },
    { type: 'goal', timestamp: 14, timecodeIn: 13, timecodeOut: 16 },
  ],
}], [{
  sourceId: 'game-2', processingMs: 1, costUsd: 0,
  detections: [
    { type: 'goal', timecodeIn: 11, timecodeOut: 12, confidence: 0.99 },
    { type: 'goal', timecodeIn: 8.5, timecodeOut: 9.5, confidence: 0.5 },
  ],
}], 3)
assert.equal(ambiguous.byEvent.goal.truePositives, 2)
assert.equal(ambiguous.byEvent.goal.falsePositives, 0)
assert.equal(ambiguous.byEvent.goal.falseNegatives, 0)
console.log('Evaluation metric tests passed')
