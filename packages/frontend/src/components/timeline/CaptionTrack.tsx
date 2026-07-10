import { useState, memo } from 'react'

export interface TextSlot {
  id: string
  text: string
  style: 'caption' | 'lower-third' | 'title'
}

const STYLE_COLOR: Record<TextSlot['style'], string> = {
  caption:       '#40a0d0',
  'lower-third': '#6c63ff',
  title:         '#f0c020',
}

const STYLE_LABEL: Record<TextSlot['style'], string> = {
  caption:       'CAPTION',
  'lower-third': 'LOWER-3RD',
  title:         'TITLE',
}

interface Props {
  slots:    TextSlot[]
  onAdd:    (style: TextSlot['style'], text?: string) => void
  onUpdate: (id: string, patch: Partial<TextSlot>) => void
  onRemove: (id: string) => void
  onMove:   (id: string, toIndex: number) => void
  suggestedPlayer?: string   // from the active video clip's player tag
}

// Memoized: with stable handlers from EditorPage, only re-renders when the
// text slots or the suggested player actually change
export const CaptionTrack = memo(function CaptionTrack({ slots, onAdd, onUpdate, onRemove, onMove, suggestedPlayer }: Props) {
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editText, setEditText]     = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overIndex, setOverIndex]   = useState<number | null>(null)
  const [showMenu, setShowMenu]     = useState(false)

  function startEdit(slot: TextSlot) {
    setEditingId(slot.id)
    setEditText(slot.text)
  }

  function commitEdit() {
    if (editingId) onUpdate(editingId, { text: editText })
    setEditingId(null)
  }

  function handleDragStart(e: React.DragEvent, id: string) {
    setDraggingId(id)
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setOverIndex(idx)
  }

  function handleDrop(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (draggingId) onMove(draggingId, idx)
    setDraggingId(null)
    setOverIndex(null)
  }

  return (
    <div style={styles.wrapper}>
      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={styles.header}>
        <span style={styles.trackLabel}>TEXT</span>

        <div style={{ position: 'relative' }}>
          <button style={styles.addBtn} onClick={() => setShowMenu((v) => !v)}>
            + Add text
          </button>
          {showMenu && (
            <div style={styles.menu} onMouseLeave={() => setShowMenu(false)}>
              {(['caption', 'lower-third', 'title'] as TextSlot['style'][]).map((s) => (
                <button
                  key={s}
                  style={{ ...styles.menuItem, color: STYLE_COLOR[s] }}
                  onClick={() => { onAdd(s); setShowMenu(false) }}
                >
                  {STYLE_LABEL[s]}
                </button>
              ))}
              {suggestedPlayer && (
                <button
                  style={{ ...styles.menuItem, color: STYLE_COLOR['lower-third'], borderTop: '1px solid #1e1e30' }}
                  onClick={() => { onAdd('lower-third', suggestedPlayer); setShowMenu(false) }}
                >
                  Lower-3rd: {suggestedPlayer}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Slot strip ──────────────────────────────────────────── */}
      <div style={styles.strip}>
        {slots.length === 0 && (
          <span style={styles.empty}>No text overlays — click "+ Add text" to insert one</span>
        )}

        {slots.map((slot, idx) => {
          const color     = STYLE_COLOR[slot.style]
          const isDragging = draggingId === slot.id
          const isOver    = overIndex === idx && draggingId !== null && draggingId !== slot.id

          return (
            <div
              key={slot.id}
              style={{
                ...styles.block,
                borderColor: isOver ? '#fff' : color,
                borderLeftColor: color,
                opacity: isDragging ? 0.35 : 1,
              }}
              draggable
              onDragStart={(e) => handleDragStart(e, slot.id)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={() => { setDraggingId(null); setOverIndex(null) }}
            >
              <span style={{ ...styles.styleLabel, color }}>{STYLE_LABEL[slot.style]}</span>

              {editingId === slot.id ? (
                <input
                  autoFocus
                  style={styles.editInput}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  style={styles.slotText}
                  onDoubleClick={() => startEdit(slot)}
                  title="Double-click to edit"
                >
                  {slot.text || <em style={{ color: '#404060' }}>click to edit</em>}
                </span>
              )}

              <div style={styles.actions}>
                <button
                  style={styles.editBtn}
                  onClick={() => startEdit(slot)}
                  title="Edit text"
                >
                  ✎
                </button>
                {/* Style cycle */}
                <button
                  style={{ ...styles.styleBtn, color }}
                  title="Change style"
                  onClick={() => {
                    const order: TextSlot['style'][] = ['caption', 'lower-third', 'title']
                    const next = order[(order.indexOf(slot.style) + 1) % order.length]
                    onUpdate(slot.id, { style: next })
                  }}
                >
                  ⇄
                </button>
                <button
                  style={styles.delBtn}
                  onClick={() => onRemove(slot.id)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex', flexDirection: 'column',
    background: '#0a0a18', borderRadius: 8,
    border: '1px solid #1a1a2e',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '5px 12px', borderBottom: '1px solid #1a1a2e',
  },
  trackLabel: {
    fontSize: 10, fontWeight: 700, color: '#404060',
    letterSpacing: '0.1em', textTransform: 'uppercase',
  },
  addBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#6060a0',
    fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
  },
  menu: {
    position: 'absolute', right: 0, top: '100%', marginTop: 4,
    background: '#111128', border: '1px solid #1e1e30',
    borderRadius: 6, zIndex: 50, minWidth: 160,
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  menuItem: {
    background: 'none', border: 'none',
    fontSize: 12, fontWeight: 700, padding: '8px 14px',
    cursor: 'pointer', textAlign: 'left', letterSpacing: '0.04em',
  },
  strip: {
    display: 'flex', alignItems: 'center',
    minHeight: 44, padding: '6px 10px', gap: 5,
    overflowX: 'auto',
  },
  empty: {
    fontSize: 12, color: '#282848', fontStyle: 'italic', whiteSpace: 'nowrap',
  },
  block: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '4px 8px', borderRadius: 5,
    border: '1px solid', borderLeft: '3px solid',
    background: '#0d0d1a', flexShrink: 0,
    maxWidth: 280, cursor: 'grab',
    userSelect: 'none',
  },
  styleLabel: {
    fontSize: 8, fontWeight: 800, letterSpacing: '0.08em',
    flexShrink: 0,
  },
  slotText: {
    fontSize: 12, color: '#c0c0e0',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    maxWidth: 140, cursor: 'text',
  },
  editInput: {
    background: '#1a1a3a', border: '1px solid #6c63ff',
    color: '#e0e0ff', fontSize: 12, padding: '2px 6px',
    borderRadius: 4, outline: 'none', width: 140,
  },
  actions: { display: 'flex', gap: 2, marginLeft: 'auto', flexShrink: 0 },
  editBtn: {
    background: 'none', border: 'none', color: '#505080',
    fontSize: 13, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
  },
  styleBtn: {
    background: 'none', border: 'none',
    fontSize: 12, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
  },
  delBtn: {
    background: 'none', border: 'none', color: '#503060',
    fontSize: 15, cursor: 'pointer', padding: '0 2px', lineHeight: 1,
  },
}
