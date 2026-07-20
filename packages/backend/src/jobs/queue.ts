import { Queue } from 'bullmq'
import IORedis from 'ioredis'

// Upstash requires TLS (rediss://) on port 6380. Normalise both the protocol
// and the port regardless of how the env var was set.
function buildRedisUrl(raw: string) {
  if (!raw.includes('.upstash.io')) return raw
  let url = raw.startsWith('redis://') ? raw.replace('redis://', 'rediss://') : raw
  if (url.includes(':6379')) url = url.replace(':6379', ':6380')
  return url
}

const redisUrl = buildRedisUrl(process.env.REDIS_URL || 'redis://localhost:6379')
export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  tls: redisUrl.startsWith('rediss://') ? {} : undefined,
}) as any
// Prevent unhandled 'error' events from crashing the process when Redis is unreachable.
// The upload route already has a 5-second timeout around enqueueAnalysis().
connection.on('error', () => {})

export const analysisQueue = new Queue('analysis', { connection })

export interface AnalysisJobData {
  projectId: string
  sourceFileId: string
  s3Key: string
  analysisMode: 'full' | 'quick'
  quickSearchParams?: { players: string[]; scenes: string[] }
}

export async function enqueueAnalysis(data: AnalysisJobData) {
  const job = await analysisQueue.add(data.analysisMode, data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: false,
    removeOnFail: false,
  })
  return job.id
}
