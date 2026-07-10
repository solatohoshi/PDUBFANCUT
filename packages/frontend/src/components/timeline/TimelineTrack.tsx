import { useState, useEffect, useRef, memo } from 'react'
import type { TimelineClip } from '../../hooks/useTimeline'

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
const SPEEDS = [0.25, 0.5, 1.0, 2.0]

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

interface Props {
  slots:             TimelineClip[]
  activeId:          string | null
  effectiveDuration: (s: TimelineClip) => number
  onSelect:          (id: string) => void
  onRemove:          (id: string) => void
  onMove:            (id: string, toIndex: number) => void
  onUpdate:          (id: string, patch: { trimStart?: number; trimEnd?: number; speed?: number }) => void
  onDropClip?:       (clipId: string) => void
}

// Memoized: with stable handlers from EditorPage, the track skips re-renders
// caused by unrelated editor state (library search, caption edits, …)
export const TimelineTrack = memo(function TimelineTrack({
  slots, activeId, effectiveDuration, onSelect, onRemove, onMove, onUpdate, onDropClip,
}: Props) {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overIndex, setOverIndex]   = useState<number | null>(null)
  const [zoom, setZoom]             = useState(1)
  const [trimDrag, setTrimDrag]     = useState<TrimDrag | null>(null)
  const isTrimming                  = useRef(false)
  const onUpdateRef                 = useRef(onUpdate)
  useEffect(() => { onUpdateRef.current = onUpdate }, [onUpdate])

  const pps = PPS * zoom

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
    const origDur = slot.tcOut - slot.tcIn
    const blockW  = Math.max(MIN_BLOCK_PX, origDur * pps)
    isTrimming.current = true
    setTrimDrag({
      slotId: slot.id,
      edge,
      startX: e.clientX,
      initTrimStart: slot.trimStart,
      initTrimEnd:   slot.trimEnd,
      origDur,
      secsPerPx: origDur / blockW,
    })
  }

  // ── HTML5 DnD reorder ────────────────────────────────────────────────
  function handleDragStart(e: React.DragEvent, id: string) {
    if (isTrimming.current) { e.preventDefault(); return }
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }

  function handleDrop(e: React.DragEvent, index: number) {
    e.preventDefault()
    if (draggingId) {
      onMove(draggingId, index)
    } else {
      const clipId = e.dataTransfer.getData('text/clip-id')
      if (clipId && onDropClip) onDropClip(clipId)
    }
    setDraggingId(null)
    setOverIndex(null)
  }

  function handleDragEnd() {
    setDraggingId(null)
    setOverIndex(null)
  }

  return (
    <div style={styles.wrapper}>
      {/* ── Track header ─────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.trackLabel}>VIDEO</span>
        <div style={styles.zoomControl}>
          <span style={styles.zoomLabel}>Zoom</span>
          <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.max(0.25, z / 2))}>−</button>
          <span style={styles.zoomValue}>{zoom}×</span>
          <button style={styles.zoomBtn} onClick={() => setZoom((z) => Math.min(8, z * 2))}>+</button>
        </div>
      </div>

      {/* ── Timecode strip for active slot ───────────────────────────── */}
      {activeId && (() => {
        const found = slots.find((s) => s.id === activeId)
        if (!found) return null
        const { id: slotId, tcIn, tcOut, trimStart, trimEnd, label, speed } = found
        const origDur      = tcOut - tcIn
        const effectiveIn  = tcIn + trimStart
        const effectiveOut = tcOut - trimEnd

        function commitIn(raw: string) {
          const val = parseTC(raw)
          if (val === null) return
          const clamped = Math.max(tcIn, Math.min(effectiveOut - 1, val))
          onUpdate(slotId, { trimStart: Math.max(0, clamped - tcIn) })
        }

        function commitOut(raw: string) {
          const val = parseTC(raw)
          if (val === null) return
          const clamped = Math.max(effectiveIn + 1, Math.min(tcOut, val))
          onUpdate(slotId, { trimEnd: Math.max(0, tcOut - clamped) })
        }

        return (
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
            <select
              style={styles.tcSpeedSelect}
              value={speed}
              onChange={(e) => onUpdate(slotId, { speed: parseFloat(e.target.value) })}
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>{s}×</option>
              ))}
            </select>
          </div>
        )
      })()}

      {/* ── Scrollable clip strip ─────────────────────────────────────── */}
      <div
        style={styles.trackArea}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={(e) => {
          const clipId = e.dataTransfer.getData('text/clip-id')
          if (clipId && onDropClip) { e.stopPropagation(); onDropClip(clipId) }
        }}
      >
        <div style={styles.track}>
          {slots.length === 0 && (
            <div style={styles.emptyTrack}>Add clips from the library →</div>
          )}

          {slots.map((slot, idx) => {
            const isDragging = draggingId === slot.id
            const isOver     = overIndex === idx && draggingId !== null && draggingId !== slot.id
            const isActive   = activeId === slot.id
            const origDur    = slot.tcOut - slot.tcIn
            const blockW     = Math.max(MIN_BLOCK_PX, origDur * pps)
            const ePps       = blockW / origDur
            const leftPx     = Math.min(blockW * 0.9, slot.trimStart * ePps)
            const rightPx    = Math.min(blockW * 0.9 - leftPx, slot.trimEnd * ePps)

            // Handle positions: clamp inside the block
            const leftHandleX  = Math.max(1, leftPx - 4)
            const rightHandleX = Math.max(leftHandleX + 12, blockW - rightPx - 4)

            return (
              <div
                key={slot.id}
                style={{
                  position: 'relative',
                  width: blockW,
                  height: 56,
                  borderRadius: 6,
                  border: `1px solid ${isOver ? '#6c63ff' : isActive ? '#fff' : '#1e1e30'}`,
                  borderLeft: `3px solid ${slot.color}`,
                  background: isActive ? '#1a1a3a' : '#111128',
                  opacity: isDragging ? 0.35 : 1,
                  flexShrink: 0,
                  userSelect: 'none',
                  overflow: 'hidden',
                  cursor: isTrimming.current ? 'ew-resize' : 'grab',
                }}
                draggable
                onDragStart={(e) => handleDragStart(e, slot.id)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={(e) => handleDrop(e, idx)}
                onDragEnd={handleDragEnd}
                onClick={() => !isTrimming.current && onSelect(slot.id)}
              >
                {/* ── Left trimmed overlay ─────────────────────────── */}
                {leftPx > 0 && (
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: leftPx,
                    background: 'rgba(0,0,0,0.55)',
                    borderRight: '1px dashed rgba(108,99,255,0.4)',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }} />
                )}

                {/* ── Right trimmed overlay ────────────────────────── */}
                {rightPx > 0 && (
                  <div style={{
                    position: 'absolute', right: 0, top: 0, bottom: 0,
                    width: rightPx,
                    background: 'rgba(0,0,0,0.55)',
                    borderLeft: '1px dashed rgba(108,99,255,0.4)',
                    pointerEvents: 'none',
                    zIndex: 1,
                  }} />
                )}

                {/* ── Active-region content ────────────────────────── */}
                <div style={{
                  position: 'absolute',
                  left: leftPx + 6,
                  right: rightPx + 6,
                  top: 0, bottom: 0,
                  display: 'flex', alignItems: 'center', gap: 5,
                  overflow: 'hidden', zIndex: 0,
                }}>
                  <span style={{ color: slot.color, fontSize: 10, fontWeight: 800, flexShrink: 0 }}>
                    {slot.label}
                  </span>
                  <span style={{ fontSize: 9, color: '#505080', flexShrink: 0 }}>
                    {effectiveDuration(slot).toFixed(1)}s
                  </span>
                  {blockW >= 140 && (
                    <select
                      style={styles.speedSelect}
                      value={slot.speed}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation()
                        onUpdate(slot.id, { speed: parseFloat(e.target.value) })
                      }}
                    >
                      {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
                    </select>
                  )}
                </div>

                {/* ── Left trim handle ─────────────────────────────── */}
                <div
                  title={`Trim start: ${slot.trimStart.toFixed(1)}s`}
                  style={{
                    position: 'absolute',
                    left: leftHandleX,
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
                    left: Math.min(blockW - 9, rightHandleX),
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
                    position: 'absolute', top: 3,
                    right: Math.max(4, rightPx + 2),
                    zIndex: 5,
                    background: 'none', border: 'none', color: '#504060',
                    fontSize: 15, cursor: 'pointer', padding: 0, lineHeight: 1,
                  }}
                  onClick={(e) => { e.stopPropagation(); onRemove(slot.id) }}
                  title="Remove from timeline"
                >
                  ×
                </button>
              </div>
            )
          })}
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
  },
  trackLabel: {
    fontSize: 10, fontWeight: 700, color: '#505080',
    letterSpacing: '0.1em', textTransform: 'uppercase',
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
    minWidth: '100%',
  },
  emptyTrack: {
    fontSize: 12, color: '#303060', fontStyle: 'italic',
    display: 'flex', alignItems: 'center', paddingLeft: 8,
    whiteSpace: 'nowrap',
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
  speedSelect: {
    background: '#0d0d1a', border: '1px solid #1e1e30',
    color: '#8080a0', fontSize: 10, padding: '1px 2px',
    borderRadius: 3, cursor: 'pointer', flexShrink: 0,
  },
  tcSpeedSelect: {
    background: '#12102a', border: '1px solid #2a2a4a',
    color: '#c0c0e8', fontSize: 11, padding: '2px 4px',
    borderRadius: 4, cursor: 'pointer', marginLeft: 4,
  },
}
