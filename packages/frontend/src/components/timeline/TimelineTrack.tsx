import { useState, useEffect, useRef, memo } from 'react'
import type { TimelineClip, ColorAdjust } from '../../hooks/useTimeline'
import { canMerge, isDefaultColorAdjust, MIN_SPEED, MAX_SPEED } from '../../hooks/useTimeline'
import type { TextSlot } from './CaptionTrack'
import { STYLE_COLOR, STYLE_LABEL } from './CaptionTrack'
import { mediaUrl, type MusicTrack } from '../../lib/api'

function formatTC(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = (secs % 60).toFixed(1).padStart(4, '0')
  return `${m}:${s}`
}

function parseTC(str: string): number | null {
  const parts = str.trim().split(':')
  if (parts.length === 2) {
    const m = parseFloat(parts[0])
    const s = parseFloat(parts[1])
    if (isNaN(m) || isNaN(s)) return null
    return m * 60 + s
  }
  const v = parseFloat(str)
  return isNaN(v) ? null : v
}

const PPS = 6        // base pixels per second
const MIN_BLOCK_PX = 80

// Shared time↔pixel origin for every row (video/text/music) — must match the
// video track's own layout (`styles.track` padding-left + flex gap) so a
// text/music block dragged to line up with a clip actually lines up with it.
const TRACK_PAD_LEFT = 12
const TRACK_GAP = 6

const FILMSTRIP_THUMB_WIDTH_PX = 70
const MAX_FILMSTRIP_FRAMES = 10
// Must match the backend's FRAME_CACHE_GRANULARITY_SECS (files.ts). Rounding
// here too means that during a continuous drag (trim, zoom), most consecutive
// re-renders compute the *identical* timestamp for a given filmstrip slot —
// same <img src>, so React leaves the DOM node alone and the browser never
// re-requests it. Without this, every mousemove tick would compute a
// slightly different fractional timestamp and fire a fresh request/redirect
// round-trip per image, even though the backend would ultimately resolve
// them all to the same cached frame — a large, avoidable source of jank.
const FRAME_CACHE_GRANULARITY_SECS = 0.25

function roundToFrameGrid(t: number): number {
  return Math.max(0, Math.round(t / FRAME_CACHE_GRANULARITY_SECS) * FRAME_CACHE_GRANULARITY_SECS)
}

/** Evenly-spaced sample times (absolute source-file seconds) across the
 * clip's visible (post-trim) range, one per filmstrip thumbnail slot. */
function computeFilmstripTimes(effIn: number, effOut: number, visibleWidthPx: number): number[] {
  const dur = effOut - effIn
  if (dur <= 0 || visibleWidthPx <= 0) return []
  const count = Math.max(1, Math.min(MAX_FILMSTRIP_FRAMES, Math.round(visibleWidthPx / FILMSTRIP_THUMB_WIDTH_PX)))
  const times: number[] = []
  for (let i = 0; i < count; i++) {
    times.push(roundToFrameGrid(effIn + dur * ((i + 0.5) / count)))
  }
  return times
}

/** A clip's on-screen block width follows its OUTPUT duration (post-trim,
 * post-speed) — the same domain `effectiveDuration()`/`totalDuration` use —
 * so a 2× sped-up clip renders half as wide, matching how long it actually
 * plays in the export. Clamped to MIN_BLOCK_PX so short/fast clips stay
 * draggable at low zoom. */
function blockWidthFor(slot: TimelineClip, pps: number): number {
  const effDur = Math.max(0, (slot.tcOut - slot.trimEnd) - (slot.tcIn + slot.trimStart))
  return Math.max(MIN_BLOCK_PX, (effDur / slot.speed) * pps)
}

interface Breakpoint { t: number; px: number }

/** Cumulative time↔pixel mapping across the video row's actual rendered
 * layout (including the MIN_BLOCK_PX clamp and inter-block gaps), so text/
 * music positioned by time can be placed at the pixel that visually lines up
 * with the right clip — not just `t * pps`, which would drift out of sync
 * with any clamped-short clip. */
function buildTimeAxis(slots: TimelineClip[], pps: number): Breakpoint[] {
  const bp: Breakpoint[] = [{ t: 0, px: TRACK_PAD_LEFT }]
  let t = 0
  let px = TRACK_PAD_LEFT
  for (const slot of slots) {
    const outDur = Math.max(0, (slot.tcOut - slot.trimEnd) - (slot.tcIn + slot.trimStart)) / slot.speed
    const blockW = blockWidthFor(slot, pps)
    t += outDur
    px += blockW + TRACK_GAP
    bp.push({ t, px })
  }
  return bp
}

function timeToPx(bp: Breakpoint[], pps: number, t: number): number {
  const first = bp[0]
  if (t <= first.t) return first.px + (t - first.t) * pps
  for (let i = 1; i < bp.length; i++) {
    if (t <= bp[i].t) {
      const a = bp[i - 1], b = bp[i]
      const span = b.t - a.t
      const frac = span > 0 ? (t - a.t) / span : 0
      return a.px + frac * (b.px - a.px)
    }
  }
  const last = bp[bp.length - 1]
  return last.px + (t - last.t) * pps
}

function pxToTime(bp: Breakpoint[], pps: number, px: number): number {
  const first = bp[0]
  if (px <= first.px) return Math.max(0, first.t + (px - first.px) / pps)
  for (let i = 1; i < bp.length; i++) {
    if (px <= bp[i].px) {
      const a = bp[i - 1], b = bp[i]
      const span = b.px - a.px
      const frac = span > 0 ? (px - a.px) / span : 0
      return a.t + frac * (b.t - a.t)
    }
  }
  const last = bp[bp.length - 1]
  return last.t + (px - last.px) / pps
}

/** Greedy interval-scheduling lane assignment so overlapping text blocks
 * stack into separate rows instead of drawing on top of each other. */
function assignLanes(items: { id: string; start: number; end: number }[]): Map<string, number> {
  const laneEnds: number[] = []
  const laneOf = new Map<string, number>()
  const sorted = [...items].sort((a, b) => a.start - b.start)
  for (const it of sorted) {
    let lane = laneEnds.findIndex((endT) => endT <= it.start + 1e-6)
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(it.end) }
    else laneEnds[lane] = it.end
    laneOf.set(it.id, lane)
  }
  return laneOf
}

function TCInput({ value, onCommit }: { value: number; onCommit: (raw: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText]       = useState('')

  function startEdit() {
    setText(formatTC(value))
    setEditing(true)
  }

  function commit() {
    onCommit(text)
    setEditing(false)
  }

  return editing ? (
    <input
      autoFocus
      style={styles.tcInput}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur() }
        if (e.key === 'Escape') { setEditing(false) }
      }}
    />
  ) : (
    <span style={styles.tcValue} onClick={startEdit} title="Click to edit">
      {formatTC(value)}
    </span>
  )
}

interface TrimDrag {
  slotId: string
  edge: 'start' | 'end'
  startX: number
  initTrimStart: number
  initTrimEnd: number
  origDur: number
  secsPerPx: number
}

interface ReorderDrag {
  slotId: string
  startIndex: number
  startX: number
  startY: number
}

const REORDER_MOVE_THRESHOLD_PX = 4

const MIN_TEXT_DUR_SECS  = 0.3
const MIN_MUSIC_DUR_SECS = 0.5
const TEXT_LANE_H  = 26
const TEXT_ROW_PAD = 6
const MUSIC_ROW_H  = 40
const MIN_OBJ_BLOCK_PX = 36

interface ObjDrag {
  kind: 'text' | 'music'
  id: string
  mode: 'move' | 'left' | 'right'
  grabOffsetSecs: number
  initStart: number
  initDuration: number
  initTrimStart: number
  initTrimEnd: number
  fileDuration: number
}

const COLOR_FIELDS: { key: keyof ColorAdjust; label: string; min: number; max: number; step: number }[] = [
  { key: 'brightness', label: 'Bright',  min: -1,   max: 1,   step: 0.01 },
  { key: 'contrast',   label: 'Contrast', min: -1,   max: 1,   step: 0.01 },
  { key: 'saturation', label: 'Sat',     min: -1,   max: 1,   step: 0.01 },
  { key: 'hue',        label: 'Hue',     min: -180, max: 180, step: 1 },
]

interface Props {
  slots:             TimelineClip[]
  activeId:          string | null
  onSelect:          (id: string) => void
  onRemove:          (id: string) => void
  onMove:            (id: string, toIndex: number) => void
  onUpdate:          (id: string, patch: { trimStart?: number; trimEnd?: number; speed?: number }) => void
  onUpdateColor:     (id: string, patch: Partial<ColorAdjust>) => void
  onSplit:           () => void
  onMerge:           (idA: string, idB: string) => void
  /** Call once at the start of a continuous gesture (trim drag, slider drag)
   * so the whole gesture collapses into a single undo step. */
  onCheckpoint:      () => void
  onDropClip?:       (clipId: string) => void

  // ── Text overlays — same shared timeline, absolutely positioned ─────────
  textSlots:         TextSlot[]
  onAddText:         (style: TextSlot['style']) => void
  onUpdateText:      (id: string, patch: Partial<TextSlot>) => void
  onRemoveText:      (id: string) => void

  // ── Background music — same shared timeline ──────────────────────────────
  projectId:         string
  mediaToken?:       string | null
  music:             MusicTrack | null
  musicVolume:       number
  onVolumeChange:    (v: number) => void
  onUploadMusic:     (file: File) => void
  onRemoveMusic:     () => void
  onUpdateMusic:     (patch: { startSecs?: number; trimStart?: number; trimEnd?: number }) => void
}

// Memoized: with stable handlers from EditorPage, the track skips re-renders
// caused by unrelated editor state (library search, …)
export const TimelineTrack = memo(function TimelineTrack({
  slots, activeId, onSelect, onRemove, onMove, onUpdate, onUpdateColor, onSplit, onMerge, onCheckpoint, onDropClip,
  textSlots, onAddText, onUpdateText, onRemoveText,
  projectId, mediaToken, music, musicVolume, onVolumeChange, onUploadMusic, onRemoveMusic, onUpdateMusic,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overIndex, setOverIndex]   = useState<number | null>(null)
  const [zoom, setZoom]             = useState(1)
  const [trimDrag, setTrimDrag]     = useState<TrimDrag | null>(null)
  const [reorderDrag, setReorderDrag] = useState<ReorderDrag | null>(null)
  const isTrimming                  = useRef(false)
  const trackRef                    = useRef<HTMLDivElement>(null)
  const stackRef                    = useRef<HTMLDivElement>(null)
  const overIndexRef                = useRef<number | null>(null)
  const hasMovedRef                 = useRef(false)
  const onUpdateRef                 = useRef(onUpdate)
  const onMoveRef                   = useRef(onMove)
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])
  useEffect(() => { onMoveRef.current = onMove }, [onMove])

  // Text overlay editing + menu state
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [editText, setEditText]           = useState('')
  const [showAddMenu, setShowAddMenu]     = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Object (text/music) drag state — separate from the video row's trim/reorder drags
  const [objDrag, setObjDrag] = useState<ObjDrag | null>(null)
  const onUpdateTextRef  = useRef(onUpdateText)
  const onUpdateMusicRef = useRef(onUpdateMusic)
  useEffect(() => { onUpdateTextRef.current = onUpdateText }, [onUpdateText])
  useEffect(() => { onUpdateMusicRef.current = onUpdateMusic }, [onUpdateMusic])

  const pps = PPS * zoom
  const breakpoints = buildTimeAxis(slots, pps)
  const breakpointsRef = useRef(breakpoints)
  breakpointsRef.current = breakpoints
  const ppsRef = useRef(pps)
  ppsRef.current = pps

  // ── Global mouse events for trim drag ───────────────────────────────
  useEffect(() => {
    if (!trimDrag) return
    const { slotId, edge, startX, initTrimStart, initTrimEnd, origDur, secsPerPx } = trimDrag

    function onMouseMove(e: MouseEvent) {
      const ds = (e.clientX - startX) * secsPerPx
      if (edge === 'start') {
        const max = Math.max(0, origDur - initTrimEnd - 1)
        onUpdateRef.current(slotId, { trimStart: Math.max(0, Math.min(max, initTrimStart + ds)) })
      } else {
        const max = Math.max(0, origDur - initTrimStart - 1)
        onUpdateRef.current(slotId, { trimEnd: Math.max(0, Math.min(max, initTrimEnd - ds)) })
      }
    }

    function onMouseUp() {
      setTrimDrag(null)
      isTrimming.current = false
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [trimDrag])

  function startTrim(e: React.MouseEvent, slot: TimelineClip, edge: 'start' | 'end') {
    e.preventDefault()
    e.stopPropagation()
    onCheckpoint()
    const origDur = slot.tcOut - slot.tcIn
    // secsPerPx is derived from the block's current *effective* (visible)
    // width, not the full source duration — short/heavily-trimmed clips get
    // clamped to MIN_BLOCK_PX, which deliberately makes dragging slower/more
    // precise on them than the raw pixels-per-second rate would give.
    const blockW = blockWidthFor(slot, pps)
    const effDur = Math.max(0, (slot.tcOut - slot.trimEnd) - (slot.tcIn + slot.trimStart))
    isTrimming.current = true
    setTrimDrag({
      slotId: slot.id,
      edge,
      startX: e.clientX,
      initTrimStart: slot.trimStart,
      initTrimEnd:   slot.trimEnd,
      origDur,
      secsPerPx: effDur / blockW,
    })
  }

  // ── Custom pointer-based reorder drag ─────────────────────────────────
  // Native HTML5 drag-and-drop (draggable + dragstart/dragover/drop) turned
  // out to be unreliable here in practice — it requires setData in dragstart
  // to work consistently cross-browser, and its browser-native gesture
  // detection interacts poorly with the trim handles layered on top of the
  // same block. A manual mousedown→mousemove→mouseup drag (the same pattern
  // already used for trim handles below) sidesteps all of that: full control,
  // no native DnD state machine, consistent behavior everywhere.
  useEffect(() => {
    if (!reorderDrag) return
    const { slotId, startIndex, startX, startY } = reorderDrag

    function computeOverIndex(clientX: number): number {
      const track = trackRef.current
      if (!track) return startIndex
      const blocks = Array.from(track.querySelectorAll<HTMLElement>('[data-slot-idx]'))
      for (const el of blocks) {
        const rect = el.getBoundingClientRect()
        if (clientX < rect.left + rect.width / 2) {
          return parseInt(el.dataset.slotIdx!, 10)
        }
      }
      return blocks.length - 1
    }

    function onMouseMove(e: MouseEvent) {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!hasMovedRef.current) {
        if (Math.abs(dx) < REORDER_MOVE_THRESHOLD_PX && Math.abs(dy) < REORDER_MOVE_THRESHOLD_PX) return
        hasMovedRef.current = true
        isTrimming.current = true // suppress the click-to-select once a real drag is happening
        setDraggingId(slotId)
      }
      const idx = computeOverIndex(e.clientX)
      overIndexRef.current = idx
      setOverIndex(idx)
    }

    function onMouseUp() {
      if (hasMovedRef.current && overIndexRef.current !== null) {
        onMoveRef.current(slotId, overIndexRef.current)
      }
      setReorderDrag(null)
      setDraggingId(null)
      setOverIndex(null)
      overIndexRef.current = null
      hasMovedRef.current = false
      isTrimming.current = false
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [reorderDrag])

  function startReorder(e: React.MouseEvent, slot: TimelineClip, index: number) {
    // Don't preventDefault or flag isTrimming yet — a plain click (no
    // movement) must still fall through to onClick and select the clip.
    // onMouseMove flips isTrimming once real movement is detected.
    setReorderDrag({ slotId: slot.id, startIndex: index, startX: e.clientX, startY: e.clientY })
  }

  // Library-clip drops only — reordering existing timeline clips no longer
  // goes through native DnD (see above), so these just handle a clip dragged
  // in from the library sidebar.
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const clipId = e.dataTransfer.getData('text/clip-id')
    if (clipId && onDropClip) onDropClip(clipId)
  }

  // ── Text/music object drag (move + edge-resize) ─────────────────────────
  useEffect(() => {
    if (!objDrag) return
    const { kind, id, mode, grabOffsetSecs, initStart, initDuration, initTrimStart, initTrimEnd, fileDuration } = objDrag

    function contentXToTime(clientX: number): number {
      const rect = stackRef.current?.getBoundingClientRect()
      const contentX = rect ? clientX - rect.left : clientX
      return pxToTime(breakpointsRef.current, ppsRef.current, contentX)
    }

    function onMouseMove(e: MouseEvent) {
      const t = contentXToTime(e.clientX)

      if (kind === 'text') {
        if (mode === 'move') {
          onUpdateTextRef.current(id, { startSecs: Math.max(0, t - grabOffsetSecs) })
        } else if (mode === 'left') {
          const endT = initStart + initDuration
          const newStart = Math.max(0, Math.min(endT - MIN_TEXT_DUR_SECS, t))
          onUpdateTextRef.current(id, { startSecs: newStart, durationSecs: endT - newStart })
        } else {
          const newDuration = Math.max(MIN_TEXT_DUR_SECS, t - initStart)
          onUpdateTextRef.current(id, { durationSecs: newDuration })
        }
        return
      }

      // music
      if (mode === 'move') {
        onUpdateMusicRef.current({ startSecs: Math.max(0, t - grabOffsetSecs) })
      } else if (mode === 'left') {
        const delta = t - initStart
        const newTrimStart = Math.max(0, Math.min(fileDuration - initTrimEnd - MIN_MUSIC_DUR_SECS, initTrimStart + delta))
        const newStart = Math.max(0, initStart + (newTrimStart - initTrimStart))
        onUpdateMusicRef.current({ startSecs: newStart, trimStart: newTrimStart })
      } else {
        const newEnd = t
        const effDur = Math.max(MIN_MUSIC_DUR_SECS, Math.min(fileDuration - initTrimStart, newEnd - initStart))
        const newTrimEnd = Math.max(0, fileDuration - initTrimStart - effDur)
        onUpdateMusicRef.current({ trimEnd: newTrimEnd })
      }
    }

    function onMouseUp() {
      setObjDrag(null)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [objDrag])

  function startTextDrag(e: React.MouseEvent, slot: TextSlot, mode: 'move' | 'left' | 'right') {
    e.preventDefault()
    e.stopPropagation()
    const rect = stackRef.current?.getBoundingClientRect()
    const contentX = rect ? e.clientX - rect.left : e.clientX
    const grabT = pxToTime(breakpoints, pps, contentX)
    setObjDrag({
      kind: 'text', id: slot.id, mode,
      grabOffsetSecs: grabT - slot.startSecs,
      initStart: slot.startSecs, initDuration: slot.durationSecs,
      initTrimStart: 0, initTrimEnd: 0, fileDuration: 0,
    })
  }

  function startMusicDrag(e: React.MouseEvent, mode: 'move' | 'left' | 'right') {
    if (!music) return
    e.preventDefault()
    e.stopPropagation()
    const startSecs = parseFloat(music.start_secs)
    const trimStart = parseFloat(music.trim_start)
    const trimEnd   = parseFloat(music.trim_end)
    const fileDur   = parseFloat(music.duration_secs ?? '0')
    const rect = stackRef.current?.getBoundingClientRect()
    const contentX = rect ? e.clientX - rect.left : e.clientX
    const grabT = pxToTime(breakpoints, pps, contentX)
    setObjDrag({
      kind: 'music', id: 'music', mode,
      grabOffsetSecs: grabT - startSecs,
      initStart: startSecs, initDuration: fileDur - trimStart - trimEnd,
      initTrimStart: trimStart, initTrimEnd: trimEnd, fileDuration: fileDur,
    })
  }

  function startEditText(slot: TextSlot) {
    setEditingTextId(slot.id)
    setEditText(slot.text)
  }

  function commitEditText() {
    if (editingTextId) onUpdateText(editingTextId, { text: editText })
    setEditingTextId(null)
  }

  // ── Layout: text lanes + total content width ─────────────────────────────
  const textLayout = textSlots.map((s) => ({ id: s.id, start: s.startSecs, end: s.startSecs + s.durationSecs }))
  const laneOf = assignLanes(textLayout)
  const laneCount = Math.max(1, ...Array.from(laneOf.values(), (l) => l + 1))
  const textRowH = laneCount * TEXT_LANE_H + TEXT_ROW_PAD * 2

  const lastBp = breakpoints[breakpoints.length - 1]
  let contentWidthPx = lastBp.px
  for (const s of textSlots) {
    contentWidthPx = Math.max(contentWidthPx, timeToPx(breakpoints, pps, s.startSecs + s.durationSecs) + 8)
  }
  if (music) {
    const musicEnd = parseFloat(music.start_secs) + (parseFloat(music.duration_secs ?? '0') - parseFloat(music.trim_start) - parseFloat(music.trim_end))
    contentWidthPx = Math.max(contentWidthPx, timeToPx(breakpoints, pps, musicEnd) + 8)
  }
  contentWidthPx = Math.max(contentWidthPx, 200)

  return (
    <div style={styles.wrapper}>
      {/* ── Track header ─────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.trackLabel}>TIMELINE</span>
        <div style={styles.headerControls}>
          <div style={{ position: 'relative' }}>
            <button style={styles.addBtn} onClick={() => setShowAddMenu((v) => !v)}>+ Add text</button>
            {showAddMenu && (
              <div style={styles.addMenu} onMouseLeave={() => setShowAddMenu(false)}>
                {(['caption', 'lower-third', 'title'] as TextSlot['style'][]).map((s) => (
                  <button
                    key={s}
                    style={{ ...styles.addMenuItem, color: STYLE_COLOR[s] }}
                    onClick={() => { onAddText(s); setShowAddMenu(false) }}
                  >
                    {STYLE_LABEL[s]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {music ? (
            <div style={styles.musicInfo}>
              <span style={styles.musicIcon}>🎵</span>
              <span style={styles.musicName} title={music.original_name}>{music.original_name}</span>
              <label style={styles.volumeLabel}>
                Vol
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={musicVolume}
                  onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                  style={styles.volumeSlider}
                />
                <span style={styles.volumePct}>{Math.round(musicVolume * 100)}%</span>
              </label>
              <audio controls src={mediaUrl(`/api/projects/${projectId}/music/stream`, mediaToken)} style={styles.audioEl} />
              <button style={styles.musicRemoveBtn} onClick={onRemoveMusic} title="Remove music">×</button>
            </div>
          ) : (
            <button style={styles.addBtn} onClick={() => fileInputRef.current?.click()}>+ Add music</button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/mpeg,audio/mp3,audio/wav,audio/aac,audio/mp4,audio/x-m4a,audio/ogg"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onUploadMusic(f)
              e.target.value = ''
            }}
          />

          <div style={styles.zoomControl}>
            <span style={styles.zoomLabel}>Zoom</span>
            <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.max(0.25, z / 2))}>−</button>
            <span style={styles.zoomValue}>{zoom}×</span>
            <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.min(8, z * 2))}>+</button>
          </div>
        </div>
      </div>

      {/* ── Timecode strip for active slot ───────────────────────────── */}
      {activeId && (() => {
        const found = slots.find((s) => s.id === activeId)
        if (!found) return null
        const { id: slotId, tcIn, tcOut, trimStart, trimEnd, label, speed, colorAdjust } = found
        const origDur      = tcOut - tcIn
        const effectiveIn  = tcIn + trimStart
        const effectiveOut = tcOut - trimEnd

        function commitIn(raw: string) {
          const val = parseTC(raw)
          if (val === null) return
          onCheckpoint()
          const clamped = Math.max(tcIn, Math.min(effectiveOut - 1, val))
          onUpdate(slotId, { trimStart: Math.max(0, clamped - tcIn) })
        }

        function commitOut(raw: string) {
          const val = parseTC(raw)
          if (val === null) return
          onCheckpoint()
          const clamped = Math.max(effectiveIn + 1, Math.min(tcOut, val))
          onUpdate(slotId, { trimEnd: Math.max(0, tcOut - clamped) })
        }

        return (
          <>
            <div style={styles.tcStrip}>
              <span style={styles.tcSlotLabel}>{label}</span>
              <span style={styles.tcSep}>IN</span>
              <TCInput value={effectiveIn} onCommit={commitIn} />
              <span style={styles.tcArrow}>→</span>
              <span style={styles.tcSep}>OUT</span>
              <TCInput value={effectiveOut} onCommit={commitOut} />
              <span style={styles.tcDur}>
                {(effectiveOut - effectiveIn).toFixed(1)}s
                {trimStart > 0 || trimEnd > 0 ? ` (of ${origDur.toFixed(1)}s)` : ''}
              </span>
              <span style={styles.tcSep}>Speed</span>
              <input
                type="range"
                min={MIN_SPEED}
                max={MAX_SPEED}
                step={0.05}
                value={speed}
                onPointerDown={onCheckpoint}
                onChange={(e) => onUpdate(slotId, { speed: parseFloat(e.target.value) })}
                style={styles.speedSlider}
              />
              <span style={styles.speedValue}>{speed.toFixed(2)}×</span>
              <button style={styles.splitBtnPrimary} onClick={onSplit} title="Split into two clips at the playhead (S)">
                ✂ Split
              </button>
            </div>

            {/* ── Color correction for active slot ─────────────────────── */}
            <div style={styles.colorStrip}>
              <span style={styles.colorLabel}>Color</span>
              {COLOR_FIELDS.map(({ key, label: fLabel, min, max, step }) => (
                <div key={key} style={styles.colorField}>
                  <span style={styles.colorFieldLabel}>{fLabel}</span>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={colorAdjust[key]}
                    onPointerDown={onCheckpoint}
                    onChange={(e) => onUpdateColor(slotId, { [key]: parseFloat(e.target.value) })}
                    style={styles.colorSlider}
                  />
                  <span style={styles.colorFieldValue}>
                    {key === 'hue' ? colorAdjust[key].toFixed(0) : colorAdjust[key].toFixed(2)}
                  </span>
                </div>
              ))}
              {!isDefaultColorAdjust(colorAdjust) && (
                <button
                  style={styles.colorResetBtn}
                  onClick={() => { onCheckpoint(); onUpdateColor(slotId, { brightness: 0, contrast: 0, saturation: 0, hue: 0 }) }}
                >
                  Reset
                </button>
              )}
            </div>
          </>
        )
      })()}

      {/* ── Scrollable multi-track strip: video + text + music share one
           horizontal scroll and the same pixels-per-second scale, so
           dragging a text/music block lines it up with the clips below/
           above it — same container, same time axis. ─────────────────── */}
      <div
        style={styles.trackArea}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={(e) => {
          const clipId = e.dataTransfer.getData('text/clip-id')
          if (clipId && onDropClip) { e.stopPropagation(); onDropClip(clipId) }
        }}
      >
        <div ref={stackRef} style={{ width: contentWidthPx, minWidth: '100%' }}>
          {/* ── VIDEO row ─────────────────────────────────────────────── */}
          <div style={styles.track} ref={trackRef}>
            {slots.length === 0 && (
              <div style={styles.emptyTrack}>Add clips from the library →</div>
            )}

            {slots.map((slot, idx) => {
              const isDragging = draggingId === slot.id
              const isOver     = overIndex === idx && draggingId !== null && draggingId !== slot.id
              const isActive   = activeId === slot.id
              const blockW = blockWidthFor(slot, pps)

              const nextSlot = slots[idx + 1]
              const mergeableWithNext = nextSlot ? canMerge(slot, nextSlot) : false

              return (
                <div
                  key={slot.id}
                  data-slot-idx={idx}
                  style={{
                    position: 'relative',
                    width: blockW,
                    height: 56,
                    borderRadius: 6,
                    // Explicit per-side longhands (not the `border` shorthand) — mixing
                    // `border` with `borderLeft` on one style object makes React warn,
                    // since both write the same underlying border-left-* properties.
                    borderTop:    `1px solid ${isOver ? '#6c63ff' : isActive ? '#fff' : '#1e1e30'}`,
                    borderRight:  `1px solid ${isOver ? '#6c63ff' : isActive ? '#fff' : '#1e1e30'}`,
                    borderBottom: `1px solid ${isOver ? '#6c63ff' : isActive ? '#fff' : '#1e1e30'}`,
                    borderLeft:   `3px solid ${slot.color}`,
                    background: isActive ? '#1a1a3a' : '#111128',
                    opacity: isDragging ? 0.35 : 1,
                    flexShrink: 0,
                    userSelect: 'none',
                    overflow: 'hidden',
                    cursor: isDragging ? 'grabbing' : isTrimming.current ? 'ew-resize' : 'grab',
                  }}
                  onMouseDown={(e) => startReorder(e, slot, idx)}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => !isTrimming.current && onSelect(slot.id)}
                >
                  {/* ── Filmstrip: real sampled frames across the clip's visible
                       (post-trim) range, tiled to fill that span — not one
                       stretched image. Each half of a split clip gets its own
                       frames from its own range, since these are generated
                       on-demand per-timestamp rather than reusing a single
                       pre-baked thumbnail. ─────────────────────────────────── */}
                  {(() => {
                    const effIn = slot.tcIn + slot.trimStart
                    const effOut = slot.tcOut - slot.trimEnd
                    const times = computeFilmstripTimes(effIn, effOut, blockW)
                    if (times.length === 0) return null
                    return (
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', overflow: 'hidden', zIndex: 0, background: '#0a0a16',
                      }}>
                        {times.map((t, i) => (
                          <img
                            key={i}
                            src={mediaUrl(`/api/source-files/${slot.sourceFileId}/frame?t=${t.toFixed(2)}`, mediaToken)}
                            alt=""
                            draggable={false}
                            loading="lazy"
                            style={{ flex: '1 1 0', minWidth: 0, height: '100%', objectFit: 'cover', display: 'block' }}
                            onError={(e) => { e.currentTarget.style.visibility = 'hidden' }}
                          />
                        ))}
                      </div>
                    )
                  })()}

                  {/* ── Left trim handle ─────────────────────────────── */}
                  <div
                    title={`Trim start: ${slot.trimStart.toFixed(1)}s`}
                    style={{
                      position: 'absolute',
                      left: 1,
                      top: 6, bottom: 6, width: 8,
                      background: '#6c63ff',
                      borderRadius: 3,
                      cursor: 'ew-resize',
                      zIndex: 4,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseDown={(e) => startTrim(e, slot, 'start')}
                  >
                    <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 8, lineHeight: 1, pointerEvents: 'none' }}>⋮</span>
                  </div>

                  {/* ── Right trim handle ────────────────────────────── */}
                  <div
                    title={`Trim end: ${slot.trimEnd.toFixed(1)}s`}
                    style={{
                      position: 'absolute',
                      left: Math.max(12, blockW - 9),
                      top: 6, bottom: 6, width: 8,
                      background: '#6c63ff',
                      borderRadius: 3,
                      cursor: 'ew-resize',
                      zIndex: 4,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                    onMouseDown={(e) => startTrim(e, slot, 'end')}
                  >
                    <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 8, lineHeight: 1, pointerEvents: 'none' }}>⋮</span>
                  </div>

                  {/* ── Delete button ────────────────────────────────── */}
                  <button
                    style={{
                      position: 'absolute', top: 3, right: 4,
                      zIndex: 5,
                      background: 'none', border: 'none', color: '#504060',
                      fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1,
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onRemove(slot.id) }}
                    title="Remove from timeline"
                  >
                    ×
                  </button>

                  {/* ── Merge-with-next button ───────────────────────── */}
                  {mergeableWithNext && (
                    <button
                      style={{
                        position: 'absolute', top: 3, left: 4,
                        zIndex: 5,
                        background: 'none', border: 'none', color: '#6c63ff',
                        fontSize: 12, cursor: 'pointer', padding: 0, lineHeight: 1,
                      }}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => { e.stopPropagation(); onMerge(slot.id, nextSlot!.id) }}
                      title="Merge with next clip"
                    >
                      ⛓
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── TEXT row ──────────────────────────────────────────────── */}
          <div style={{ ...styles.objRow, height: textRowH }}>
            <span style={styles.rowLabel}>TEXT</span>
            {textSlots.map((slot) => {
              const lane = laneOf.get(slot.id) ?? 0
              const left = timeToPx(breakpoints, pps, slot.startSecs)
              const right = timeToPx(breakpoints, pps, slot.startSecs + slot.durationSecs)
              const width = Math.max(MIN_OBJ_BLOCK_PX, right - left)
              const color = STYLE_COLOR[slot.style]
              const isEditing = editingTextId === slot.id

              return (
                <div
                  key={slot.id}
                  style={{
                    position: 'absolute',
                    left, top: TEXT_ROW_PAD + lane * TEXT_LANE_H,
                    width, height: TEXT_LANE_H - 4,
                    background: '#111128',
                    border: `1px solid ${color}`,
                    borderLeft: `3px solid ${color}`,
                    borderRadius: 4,
                    overflow: 'hidden',
                    cursor: 'grab',
                    userSelect: 'none',
                    display: 'flex', alignItems: 'center',
                  }}
                  onMouseDown={(e) => startTextDrag(e, slot, 'move')}
                  onDoubleClick={() => startEditText(slot)}
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      style={styles.textEditInput}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={commitEditText}
                      onMouseDown={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur()
                        if (e.key === 'Escape') setEditingTextId(null)
                      }}
                    />
                  ) : (
                    <span style={{ ...styles.objLabel, color }} title="Double-click to edit">
                      {slot.text || '(click to edit)'}
                    </span>
                  )}

                  <button
                    style={styles.objRemoveBtn}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onRemoveText(slot.id) }}
                    title="Remove text"
                  >
                    ×
                  </button>

                  {/* Resize handles */}
                  <div
                    style={styles.objHandleLeft}
                    onMouseDown={(e) => startTextDrag(e, slot, 'left')}
                  />
                  <div
                    style={styles.objHandleRight}
                    onMouseDown={(e) => startTextDrag(e, slot, 'right')}
                  />
                </div>
              )
            })}
            {textSlots.length === 0 && (
              <span style={styles.objRowEmpty}>No text — click "+ Add text" then drag it into place</span>
            )}
          </div>

          {/* ── MUSIC row ─────────────────────────────────────────────── */}
          <div style={{ ...styles.objRow, height: MUSIC_ROW_H }}>
            <span style={styles.rowLabel}>MUSIC</span>
            {music && music.duration_secs && (() => {
              const startSecs = parseFloat(music.start_secs)
              const trimStart = parseFloat(music.trim_start)
              const trimEnd   = parseFloat(music.trim_end)
              const fileDur   = parseFloat(music.duration_secs!)
              const effDur    = Math.max(0, fileDur - trimStart - trimEnd)
              const left  = timeToPx(breakpoints, pps, startSecs)
              const right = timeToPx(breakpoints, pps, startSecs + effDur)
              const width = Math.max(MIN_OBJ_BLOCK_PX, right - left)

              return (
                <div
                  style={{
                    position: 'absolute',
                    left, top: 6,
                    width, height: MUSIC_ROW_H - 12,
                    background: '#1a1030',
                    border: '1px solid #a060e0',
                    borderLeft: '3px solid #a060e0',
                    borderRadius: 4,
                    overflow: 'hidden',
                    cursor: 'grab',
                    userSelect: 'none',
                    display: 'flex', alignItems: 'center',
                  }}
                  onMouseDown={(e) => startMusicDrag(e, 'move')}
                >
                  <span style={{ ...styles.objLabel, color: '#c090f0' }}>
                    🎵 {music.original_name}
                  </span>
                  <div style={styles.objHandleLeft} onMouseDown={(e) => startMusicDrag(e, 'left')} />
                  <div style={styles.objHandleRight} onMouseDown={(e) => startMusicDrag(e, 'right')} />
                </div>
              )
            })()}
            {!music && (
              <span style={styles.objRowEmpty}>No background music — click "+ Add music" then drag it into place</span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex', flexDirection: 'column',
    background: '#0d0d1a', borderRadius: 8,
    border: '1px solid #1e1e30', overflow: 'hidden',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '6px 12px', borderBottom: '1px solid #1a1a30', flexShrink: 0,
    flexWrap: 'wrap', gap: 8,
  },
  trackLabel: {
    fontSize: 10, fontWeight: 700, color: '#505080',
    letterSpacing: '0.1em', textTransform: 'uppercase',
  },
  headerControls: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  addBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#6060a0',
    fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  addMenu: {
    position: 'absolute', right: 0, top: '100%', marginTop: 4,
    background: '#111128', border: '1px solid #1e1e30',
    borderRadius: 6, zIndex: 50, minWidth: 150,
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  addMenuItem: {
    background: 'none', border: 'none',
    fontSize: 12, fontWeight: 700, padding: '8px 14px',
    cursor: 'pointer', textAlign: 'left', letterSpacing: '0.04em',
  },
  musicInfo: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#111128', border: '1px solid #1e1e30',
    borderRadius: 5, padding: '3px 8px',
  },
  musicIcon: { fontSize: 12 },
  musicName: {
    fontSize: 11, color: '#c0c0e0', maxWidth: 120,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  volumeLabel: {
    display: 'flex', alignItems: 'center', gap: 4,
    fontSize: 9, color: '#6060a0', textTransform: 'uppercase',
  },
  volumeSlider: { width: 54 },
  volumePct: { fontSize: 10, color: '#8080a0', width: 28 },
  audioEl: { height: 24, maxWidth: 140 },
  musicRemoveBtn: {
    background: 'none', border: 'none', color: '#503060',
    fontSize: 14, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
  },
  zoomControl: { display: 'flex', alignItems: 'center', gap: 6 },
  zoomLabel: { fontSize: 10, color: '#404060' },
  zoomBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080a0',
    width: 22, height: 22, borderRadius: 4, cursor: 'pointer', fontSize: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  zoomValue: { fontSize: 11, color: '#6060a0', width: 28, textAlign: 'center' },
  trackArea: { overflowX: 'auto', overflowY: 'hidden', flexShrink: 0 },
  track: {
    display: 'flex', alignItems: 'stretch',
    minHeight: 72, padding: '8px 12px', gap: 6,
  },
  emptyTrack: {
    fontSize: 12, color: '#303060', fontStyle: 'italic',
    display: 'flex', alignItems: 'center', paddingLeft: 8,
    whiteSpace: 'nowrap',
  },
  objRow: {
    position: 'relative',
    borderTop: '1px solid #16162a',
    background: '#0a0a16',
  },
  rowLabel: {
    position: 'absolute', left: 2, top: 2,
    fontSize: 8, fontWeight: 700, color: '#303050',
    letterSpacing: '0.08em', zIndex: 1, pointerEvents: 'none',
  },
  objRowEmpty: {
    position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
    fontSize: 11, color: '#282848', fontStyle: 'italic', whiteSpace: 'nowrap',
  },
  objLabel: {
    fontSize: 11, fontWeight: 600, padding: '0 8px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    pointerEvents: 'none', flex: 1,
  },
  objRemoveBtn: {
    background: 'none', border: 'none', color: '#504060',
    fontSize: 13, cursor: 'pointer', padding: '0 6px', lineHeight: 1,
    flexShrink: 0,
  },
  objHandleLeft: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 6,
    cursor: 'ew-resize', background: 'rgba(255,255,255,0.08)',
  },
  objHandleRight: {
    position: 'absolute', right: 0, top: 0, bottom: 0, width: 6,
    cursor: 'ew-resize', background: 'rgba(255,255,255,0.08)',
  },
  textEditInput: {
    background: '#1a1a3a', border: 'none', outline: 'none',
    color: '#e0e0ff', fontSize: 11, padding: '0 8px', flex: 1, height: '100%',
  },
  tcStrip: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 14px', borderBottom: '1px solid #1a1a30',
    flexShrink: 0, flexWrap: 'wrap',
  },
  tcSlotLabel: {
    fontSize: 10, fontWeight: 800, color: '#6060a0',
    letterSpacing: '0.08em', textTransform: 'uppercase',
    marginRight: 4,
  },
  tcSep: { fontSize: 10, color: '#404060', fontWeight: 700 },
  tcValue: {
    fontFamily: 'monospace', fontSize: 12, color: '#c0c0e8',
    background: '#12102a', border: '1px solid #2a2a4a',
    borderRadius: 4, padding: '2px 7px', cursor: 'text',
    letterSpacing: '0.03em',
  },
  tcInput: {
    fontFamily: 'monospace', fontSize: 12, color: '#e0e0ff',
    background: '#1a1840', border: '1px solid #6c63ff',
    borderRadius: 4, padding: '2px 7px', width: 64,
    outline: 'none', letterSpacing: '0.03em',
  },
  tcArrow: { fontSize: 11, color: '#303060' },
  tcDur: { fontSize: 11, color: '#505080', marginLeft: 4 },
  speedSlider: { width: 70, accentColor: '#6c63ff' },
  speedValue: {
    fontFamily: 'monospace', fontSize: 11, color: '#c0c0e8',
    width: 42, flexShrink: 0,
  },
  splitBtnPrimary: {
    background: 'none', border: '1px solid #6c63ff', color: '#c0c0e8',
    fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
    whiteSpace: 'nowrap', marginLeft: 'auto',
  },
  colorStrip: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '6px 14px', borderBottom: '1px solid #1a1a30',
    flexShrink: 0, flexWrap: 'wrap',
  },
  colorLabel: {
    fontSize: 10, fontWeight: 800, color: '#6060a0',
    letterSpacing: '0.08em', textTransform: 'uppercase',
  },
  colorField: { display: 'flex', alignItems: 'center', gap: 6 },
  colorFieldLabel: { fontSize: 10, color: '#606090', width: 44, flexShrink: 0 },
  colorSlider: { width: 80, accentColor: '#6c63ff' },
  colorFieldValue: {
    fontFamily: 'monospace', fontSize: 10, color: '#8080a0',
    width: 30, flexShrink: 0, textAlign: 'right',
  },
  colorResetBtn: {
    background: 'none', border: '1px solid #2a2a4a', color: '#8080a0',
    fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
    marginLeft: 'auto',
  },
}
