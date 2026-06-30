import { useState, useCallback } from 'react'
import * as tus from 'tus-js-client'
import { api } from '../lib/api'
import type { CreateProjectPayload } from '../lib/api'

export type UploadPhase = 'idle' | 'creating' | 'uploading' | 'processing' | 'done' | 'error'

export interface UploadState {
  phase: UploadPhase
  progress: number
  projectId: string | null
  error: string | null
  bytesUploaded: number
  bytesTotal: number
  speedBytesPerSec: number
}

const INITIAL: UploadState = {
  phase: 'idle',
  progress: 0,
  projectId: null,
  error: null,
  bytesUploaded: 0,
  bytesTotal: 0,
  speedBytesPerSec: 0,
}

export function useUpload() {
  const [state, setState] = useState<UploadState>(INITIAL)

  const reset = useCallback(() => setState(INITIAL), [])

  const startUpload = useCallback(
    async (file: File, projectMeta: Omit<CreateProjectPayload, 'name'>) => {
      setState({ ...INITIAL, phase: 'creating' })

      let projectId: string
      try {
        const project = await api.createProject({ name: file.name, ...projectMeta })
        projectId = project.id
      } catch (err: any) {
        setState((s) => ({ ...s, phase: 'error', error: err.message }))
        return
      }

      setState((s) => ({ ...s, phase: 'uploading', projectId }))

      let lastBytes = 0
      let lastTime = Date.now()

      const upload = new tus.Upload(file, {
        endpoint: '/api/upload',
        retryDelays: [0, 3000, 5000, 10000, 20000],
        chunkSize: 50 * 1024 * 1024,
        metadata: {
          filename: file.name,
          filetype: file.type,
          projectid: projectId,
        },
        onProgress(bytesUploaded, bytesTotal) {
          const now = Date.now()
          const elapsed = (now - lastTime) / 1000
          const speed = elapsed > 0 ? (bytesUploaded - lastBytes) / elapsed : 0
          lastBytes = bytesUploaded
          lastTime = now
          setState((s) => ({
            ...s,
            bytesUploaded,
            bytesTotal,
            progress: Math.round((bytesUploaded / bytesTotal) * 100),
            speedBytesPerSec: speed,
          }))
        },
        onSuccess() {
          setState((s) => ({ ...s, phase: 'processing', progress: 100 }))
        },
        onError(err) {
          setState((s) => ({ ...s, phase: 'error', error: err.message }))
        },
      })

      upload.findPreviousUploads().then((prev) => {
        if (prev.length > 0) upload.resumeFromPreviousUpload(prev[0])
        upload.start()
      })
    },
    []
  )

  return { state, startUpload, reset }
}
