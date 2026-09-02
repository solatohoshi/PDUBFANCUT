import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export function useMediaToken(projectId: string | undefined) {
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined

    async function refresh() {
      if (!projectId) return
      try {
        const capability = await api.createMediaToken(projectId)
        if (cancelled) return
        setToken(capability.token)
        setError(null)
        const refreshIn = Math.max(
          30_000,
          new Date(capability.expiresAt).getTime() - Date.now() - 60_000,
        )
        refreshTimer = setTimeout(refresh, refreshIn)
      } catch (err: any) {
        if (cancelled) return
        setError(err.message ?? 'Could not authorize media playback')
        // A transient auth/network error should not permanently break a long
        // editing session. Retry without spinning aggressively.
        refreshTimer = setTimeout(refresh, 30_000)
      }
    }

    setToken(null)
    setError(null)
    void refresh()
    return () => {
      cancelled = true
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [projectId])

  return { mediaToken: token, mediaTokenError: error }
}
