import { useState, useEffect } from 'react'
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

export function useTimeline(projectId: string) {
  const [slots, setSlots] = useState<TimelineClip[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(slotKey(projectId)) ?? '[]')
    } catch {
      return []
    }
  })

  useEffect(() => {
    localStorage.setItem(slotKey(projectId), JSON.stringify(slots))
  }, [slots, projectId])

  function addClip(clip: Clip) {
    if (slots.some((s) => s.clipId === clip.id)) return
    setSlots((prev) => [...prev, clipToSlot(clip)])
  }

  function addClips(clips: Clip[]) {
    const existing = new Set(slots.map((s) => s.clipId))
    const toAdd = clips.filter((c) => !existing.has(c.id)).map(clipToSlot)
    if (toAdd.length === 0) return
    setSlots((prev) => [...prev, ...toAdd])
  }

  function removeSlot(id: string) {
    setSlots((prev) => prev.filter((s) => s.id !== id))
  }

  function moveSlot(id: string, toIndex: number) {
    setSlots((prev) => {
      const from = prev.findIndex((s) => s.id === id)
      if (from === -1 || from === toIndex) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(toIndex, 0, item)
      return next
    })
  }

  function updateSlot(id: string, patch: Partial<Pick<TimelineClip, 'trimStart' | 'trimEnd' | 'speed'>>) {
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
  }

  function clearTimeline() {
    setSlots([])
  }

  function effectiveDuration(s: TimelineClip) {
    return Math.max(0, (s.tcOut - s.trimEnd) - (s.tcIn + s.trimStart)) / s.speed
  }

  const totalDuration = slots.reduce((sum, s) => sum + effectiveDuration(s), 0)

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
