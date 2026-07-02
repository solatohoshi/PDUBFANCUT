import { Queue } from 'bullmq'
import IORedis from 'ioredis'

// Upstash blocks plain TCP (6379) in restricted networks; use TLS on 6380 instead.
function buildRedisUrl(raw: string) {
  if (raw.includes('.upstash.io') && raw.startsWith('redis://')) {
    return raw.replace('redis://', 'rediss://').replace(':6379', ':6380')
  }
  return raw
}

const redisUrl = buildRedisUrl(process.env.REDIS_URL || 'redis://localhost:6379')
export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
  tls: redisUrl.startsWith('rediss://') ? {} : undefined,
})

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
