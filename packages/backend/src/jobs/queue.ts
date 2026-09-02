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
connection.on('error', () => {})

// HTTP producers should fail quickly when Redis is unavailable. Workers keep
// the durable connection above, while queue.add() uses this bounded producer.
const producerConnection = new IORedis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  tls: redisUrl.startsWith('rediss://') ? {} : undefined,
}) as any
producerConnection.on('error', () => {})

export const analysisQueue = new Queue<AnalysisJobData>('analysis', { connection: producerConnection })
export const exportQueue = new Queue<ExportJobData>('exports', { connection: producerConnection })
export const maintenanceQueue = new Queue<MaintenanceJobData>('maintenance', { connection: producerConnection })

export interface AnalysisJobData {
  projectId: string
  sourceFileId: string
  s3Key: string
  analysisMode: 'full' | 'quick'
  quickSearchParams?: { players: string[]; scenes: string[] }
  replaceExistingClips?: boolean
  analysisRunId?: string
}

export interface ExportJobData {
  exportId: string
  projectId: string
  preset: 'tiktok' | 'twitter' | 'instagram' | 'fullres'
  timeline: object[]
  captions: object[]
  musicVolume: number
}

export interface MaintenanceJobData {
  kind: 'rethumb'
  projectId: string
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

export async function enqueueExport(data: ExportJobData) {
  const job = await exportQueue.add('render', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: false,
    removeOnFail: false,
  })
  return job.id
}

export async function enqueueRethumb(projectId: string) {
  const job = await maintenanceQueue.add('rethumb', { kind: 'rethumb', projectId }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: false,
  })
  return job.id
}
