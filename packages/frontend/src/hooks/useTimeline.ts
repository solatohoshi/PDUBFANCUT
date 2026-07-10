import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { Clip } from '../lib/api'

export const SCENE_COLOR: Record<string, string> = {
  goal:         '#f0c020',
  save:         '#40d080',
  shot_on_goal: '#6c63ff',
  hit:          '#f08020',
  faceoff:      '#60c0f0',
  scrum:        '#c060d0',
  penalty:      '#f05060',
  celebration:  '#f0d040',
}

export const SCENE_LABEL: Record<string, string> = {
  goal:         'GOAL',
  save:         'SAVE',
  shot_on_goal: 'SHOT',
  hit:          'HIT',
  faceoff:      'FACEOFF',
  scrum:        'SCRUM',
  penalty:      'PENALTY',
  celebration:  'CELEB',
}

export interface TimelineClip {
  id: string           // unique slot UUID (not the DB clip ID)
  clipId: string       // DB clip UUID
  sourceFileId: string
  thumbKey: string | null
  label: string        // e.g. "GOAL"
  color: string
  tcIn: number         // timecode_in (seconds)
  tcOut: number        // timecode_out (seconds)
  trimStart: number    // seconds trimmed from start (≥ 0)
  trimEnd: number      // seconds trimmed from end (≥ 0)
  speed: number        // 1.0 | 0.5 | 0.25 | 2.0
}

function slotKey(projectId: string) {
  return `timeline:${projectId}`
}

function clipToSlot(c: Clip): TimelineClip {
  return {
    id: crypto.randomUUID(),
    clipId: c.id,
    sourceFileId: c.source_file_id,
    thumbKey: c.thumb_key,
    label: SCENE_LABEL[c.scene_tags[0]?.tag ?? ''] ?? 'CLIP',
    color: SCENE_COLOR[c.scene_tags[0]?.tag ?? ''] ?? '#6c63ff',
    tcIn: parseFloat(c.timecode_in),
    tcOut: parseFloat(c.timecode_out),
    trimStart: 0,
    trimEnd: 0,
    speed: 1.0,
  }
}

export function effectiveDuration(s: TimelineClip) {
  return Math.max(0, (s.tcOut - s.trimEnd) - (s.tcIn + s.trimStart)) / s.speed
}

export function useTimeline(projectId: string) {
  const [slots, setSlots] = useState<TimelineClip[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(slotKey(projectId)) ?? '[]')
    } catch {
      return []
    }
  })

  // Persist debounced — trim drags update slots on every mousemove, so a
  // synchronous write here would serialize the whole timeline per pixel moved.
  const latestSlots = useRef(slots)
  latestSlots.current = slots

  useEffect(() => {
    const timer = setTimeout(() => {
      try { localStorage.setItem(slotKey(projectId), JSON.stringify(slots)) } catch {}
    }, 250)
    return () => clearTimeout(timer)
  }, [slots, projectId])

  // Flush any pending write on unmount so the last edit isn't lost
  useEffect(() => () => {
    try { localStorage.setItem(slotKey(projectId), JSON.stringify(latestSlots.current)) } catch {}
  }, [projectId])

  const addClip = useCallback((clip: Clip) => {
    setSlots((prev) =>
      prev.some((s) => s.clipId === clip.id) ? prev : [...prev, clipToSlot(clip)],
    )
  }, [])

  const addClips = useCallback((clips: Clip[]) => {
    setSlots((prev) => {
      const existing = new Set(prev.map((s) => s.clipId))
      const toAdd = clips.filter((c) => !existing.has(c.id)).map(clipToSlot)
      return toAdd.length === 0 ? prev : [...prev, ...toAdd]
    })
  }, [])

  const removeSlot = useCallback((id: string) => {
    setSlots((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const moveSlot = useCallback((id: string, toIndex: number) => {
    setSlots((prev) => {
      const from = prev.findIndex((s) => s.id === id)
      if (from === -1 || from === toIndex) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(toIndex, 0, item)
      return next
    })
  }, [])

  const updateSlot = useCallback((id: string, patch: Partial<Pick<TimelineClip, 'trimStart' | 'trimEnd' | 'speed'>>) => {
    setSlots((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        const merged = { ...s, ...patch }
        const raw = merged.tcOut - merged.tcIn
        // Clamp: total trim must leave at least 1 second
        const maxTrim = Math.max(0, raw - 1)
        merged.trimStart = Math.min(merged.trimStart, maxTrim)
        merged.trimEnd   = Math.min(merged.trimEnd,   Math.max(0, maxTrim - merged.trimStart))
        return merged
      }),
    )
  }, [])

  const clearTimeline = useCallback(() => {
    setSlots([])
  }, [])

  const totalDuration = useMemo(
    () => slots.reduce((sum, s) => sum + effectiveDuration(s), 0),
    [slots],
  )

  return {
    slots,
    addClip,
    addClips,
    removeSlot,
    moveSlot,
    updateSlot,
    clearTimeline,
    effectiveDuration,
    totalDuration,
  }
}
