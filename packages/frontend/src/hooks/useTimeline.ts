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

export interface ColorAdjust {
  brightness: number   // -1..1, default 0 (ffmpeg eq brightness)
  contrast: number     // -1..1, default 0 (ffmpeg eq contrast = 1 + value)
  saturation: number   // -1..1, default 0 (ffmpeg eq saturation = 1 + value)
  hue: number           // -180..180 degrees, default 0 (ffmpeg hue=h=)
}

export const DEFAULT_COLOR_ADJUST: ColorAdjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0 }

export function isDefaultColorAdjust(c: ColorAdjust): boolean {
  return c.brightness === 0 && c.contrast === 0 && c.saturation === 0 && c.hue === 0
}

function colorAdjustEqual(a: ColorAdjust, b: ColorAdjust): boolean {
  return a.brightness === b.brightness && a.contrast === b.contrast
    && a.saturation === b.saturation && a.hue === b.hue
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
  colorAdjust: ColorAdjust
}

/** Two slots can be merged back into one contiguous slot iff they're the same
 * source clip, back-to-back in time (no gap/overlap), and share render-affecting
 * settings that a single ffmpeg segment can't represent two values of. */
export function canMerge(a: TimelineClip, b: TimelineClip): boolean {
  if (a.sourceFileId !== b.sourceFileId) return false
  if (a.speed !== b.speed) return false
  if (!colorAdjustEqual(a.colorAdjust, b.colorAdjust)) return false
  const aEffOut = a.tcOut - a.trimEnd
  const bEffIn  = b.tcIn + b.trimStart
  return Math.abs(aEffOut - bEffIn) < 0.05
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
    colorAdjust: { ...DEFAULT_COLOR_ADJUST },
  }
}

export function effectiveDuration(s: TimelineClip) {
  return Math.max(0, (s.tcOut - s.trimEnd) - (s.tcIn + s.trimStart)) / s.speed
}

export const MIN_SPEED = 0.1
export const MAX_SPEED = 4
const MAX_HISTORY = 50

export function useTimeline(projectId: string) {
  const [slots, setSlotsRaw] = useState<TimelineClip[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(slotKey(projectId)) ?? '[]')
    } catch {
      return []
    }
  })

  const latestSlots = useRef(slots)
  latestSlots.current = slots

  // ── Undo/redo history ───────────────────────────────────────────────────
  // Snapshot-based rather than a per-action Command object: cheap and hard
  // to get wrong for a flat array of slots. Discrete actions (add/remove/
  // move/split/merge/clear) auto-checkpoint via `withHistory` below. For a
  // continuous gesture (trim drag, a slider drag) call `checkpoint()` once
  // when the gesture starts, then use the silent `updateSlot`/
  // `updateColorAdjust` for every intermediate value — that way an entire
  // drag collapses into a single undo step instead of one per pixel/tick.
  const pastRef   = useRef<TimelineClip[][]>([])
  const futureRef = useRef<TimelineClip[][]>([])
  const [pastCount, setPastCount]     = useState(0)
  const [futureCount, setFutureCount] = useState(0)

  const checkpoint = useCallback(() => {
    pastRef.current.push(latestSlots.current)
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift()
    futureRef.current = []
    setPastCount(pastRef.current.length)
    setFutureCount(0)
  }, [])

  /** Wraps a discrete, atomic mutation with an automatic history checkpoint.
   * A reducer that returns the same array reference (its no-op guard) is
   * treated as a no-op and doesn't get recorded. */
  const withHistory = useCallback((updater: (prev: TimelineClip[]) => TimelineClip[]) => {
    const prev = latestSlots.current
    const next = updater(prev)
    if (next === prev) return
    pastRef.current.push(prev)
    if (pastRef.current.length > MAX_HISTORY) pastRef.current.shift()
    futureRef.current = []
    setPastCount(pastRef.current.length)
    setFutureCount(0)
    setSlotsRaw(next)
  }, [])

  const undo = useCallback(() => {
    if (pastRef.current.length === 0) return
    const prev = pastRef.current.pop()!
    futureRef.current.push(latestSlots.current)
    setPastCount(pastRef.current.length)
    setFutureCount(futureRef.current.length)
    setSlotsRaw(prev)
  }, [])

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return
    const next = futureRef.current.pop()!
    pastRef.current.push(latestSlots.current)
    setPastCount(pastRef.current.length)
    setFutureCount(futureRef.current.length)
    setSlotsRaw(next)
  }, [])

  // Persist debounced — continuous gestures call the silent updaters on
  // every mousemove/slider tick, so a synchronous write here would
  // serialize the whole timeline per pixel moved.
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
    withHistory((prev) =>
      prev.some((s) => s.clipId === clip.id) ? prev : [...prev, clipToSlot(clip)],
    )
  }, [withHistory])

  const addClips = useCallback((clips: Clip[]) => {
    withHistory((prev) => {
      const existing = new Set(prev.map((s) => s.clipId))
      const toAdd = clips.filter((c) => !existing.has(c.id)).map(clipToSlot)
      return toAdd.length === 0 ? prev : [...prev, ...toAdd]
    })
  }, [withHistory])

  const removeSlot = useCallback((id: string) => {
    withHistory((prev) => prev.some((s) => s.id === id) ? prev.filter((s) => s.id !== id) : prev)
  }, [withHistory])

  const moveSlot = useCallback((id: string, toIndex: number) => {
    withHistory((prev) => {
      const from = prev.findIndex((s) => s.id === id)
      if (from === -1 || from === toIndex) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(toIndex, 0, item)
      return next
    })
  }, [withHistory])

  /** Silent update (no history checkpoint) — intended for continuous
   * gestures. Call `checkpoint()` once before the gesture starts. */
  const updateSlot = useCallback((id: string, patch: Partial<Pick<TimelineClip, 'trimStart' | 'trimEnd' | 'speed'>>) => {
    setSlotsRaw((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        const merged = { ...s, ...patch }
        if (patch.speed !== undefined) {
          merged.speed = Math.min(MAX_SPEED, Math.max(MIN_SPEED, merged.speed))
        }
        const raw = merged.tcOut - merged.tcIn
        // Clamp: total trim must leave at least 1 second
        const maxTrim = Math.max(0, raw - 1)
        merged.trimStart = Math.min(merged.trimStart, maxTrim)
        merged.trimEnd   = Math.min(merged.trimEnd,   Math.max(0, maxTrim - merged.trimStart))
        return merged
      }),
    )
  }, [])

  /** Silent update (no history checkpoint) — see `updateSlot`. */
  const updateColorAdjust = useCallback((id: string, patch: Partial<ColorAdjust>) => {
    setSlotsRaw((prev) =>
      prev.map((s) => s.id === id ? { ...s, colorAdjust: { ...s.colorAdjust, ...patch } } : s),
    )
  }, [])

  const MIN_SPLIT_SECS = 0.5

  /** Splits the slot at absolute source-file time `atSeconds`. `retainSide`
   * controls what survives: `'both'` (default) keeps two adjacent slots —
   * the left half keeps the original slot id so the active selection stays
   * valid. `'left'`/`'right'` discard the other side in the same action
   * instead of split-then-delete. No-ops if the split point would leave
   * either kept half shorter than MIN_SPLIT_SECS.
   *
   * Each half's `tcIn`/`tcOut` are rewritten to its own new bounds (rather
   * than kept at the original span with a bigger `trimStart`/`trimEnd`) so
   * it renders as a full-width, fully independent clip with no "trimmed
   * away" dead zone — leaving the old span in place made a freshly-split
   * clip's block up to ~2x wider than its visible duration, which put the
   * trim handle right where a reorder-drag would grab the block and hijacked
   * the gesture into an accidental trim instead of a reorder. */
  const splitSlot = useCallback((id: string, atSeconds: number, retainSide: 'both' | 'left' | 'right' = 'both') => {
    withHistory((prev) => {
      const idx = prev.findIndex((s) => s.id === id)
      if (idx === -1) return prev
      const s = prev[idx]
      const effIn  = s.tcIn + s.trimStart
      const effOut = s.tcOut - s.trimEnd
      if (atSeconds <= effIn + MIN_SPLIT_SECS || atSeconds >= effOut - MIN_SPLIT_SECS) return prev

      if (retainSide === 'left') {
        const next = [...prev]
        next[idx] = { ...s, tcOut: atSeconds, trimEnd: 0 }
        return next
      }
      if (retainSide === 'right') {
        const next = [...prev]
        next[idx] = { ...s, tcIn: atSeconds, trimStart: 0 }
        return next
      }

      const left:  TimelineClip = { ...s, tcOut: atSeconds, trimEnd: 0 }
      const right: TimelineClip = { ...s, id: crypto.randomUUID(), tcIn: atSeconds, trimStart: 0 }
      const next = [...prev]
      next.splice(idx, 1, left, right)
      return next
    })
  }, [withHistory])

  /** Merges slot `idB` into `idA` if they're adjacent in the track and
   * `canMerge` allows it (same source, contiguous, same speed/color). No-op
   * otherwise. Returns the merged slot's id (== idA) via the id already known
   * to the caller — nothing to return since the merged slot keeps idA. */
  const mergeSlots = useCallback((idA: string, idB: string) => {
    withHistory((prev) => {
      const idxA = prev.findIndex((s) => s.id === idA)
      const idxB = prev.findIndex((s) => s.id === idB)
      if (idxA === -1 || idxB === -1 || Math.abs(idxA - idxB) !== 1) return prev
      const [firstIdx, first, second] = idxA < idxB
        ? [idxA, prev[idxA], prev[idxB]]
        : [idxB, prev[idxB], prev[idxA]]
      if (!canMerge(first, second)) return prev

      const merged: TimelineClip = { ...first, tcOut: second.tcOut, trimEnd: second.trimEnd }
      const next = [...prev]
      next.splice(firstIdx, 2, merged)
      return next
    })
  }, [withHistory])

  const clearTimeline = useCallback(() => {
    withHistory((prev) => prev.length === 0 ? prev : [])
  }, [withHistory])

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
    updateColorAdjust,
    splitSlot,
    mergeSlots,
    clearTimeline,
    effectiveDuration,
    totalDuration,
    checkpoint,
    undo,
    redo,
    canUndo: pastCount > 0,
    canRedo: futureCount > 0,
  }
}
