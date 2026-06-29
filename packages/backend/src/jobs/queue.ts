import { Queue } from 'bullmq'
import IORedis from 'ioredis'

export const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
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
