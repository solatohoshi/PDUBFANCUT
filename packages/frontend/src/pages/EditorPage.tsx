import { useEffect, useState, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import type { ProjectDetail, Clip } from '../lib/api'
import { useTimeline } from '../hooks/useTimeline'
import { SCENE_LABEL, SCENE_COLOR } from '../hooks/useTimeline'
import { PreviewPlayer } from '../components/timeline/PreviewPlayer'
import { TimelineTrack } from '../components/timeline/TimelineTrack'
import { ExportModal } from '../components/ExportModal'
import { CaptionTrack } from '../components/timeline/CaptionTrack'
import type { TextSlot } from '../components/timeline/CaptionTrack'

const ALL_SCENES = [
  'goal', 'save', 'shot_on_goal', 'hit',
  'faceoff', 'scrum', 'penalty', 'celebration',
]

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  const [project, setProject]   = useState<ProjectDetail | null>(null)
  const [allClips, setAllClips] = useState<Clip[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)

  const timeline = useTimeline(id ?? '')
  const [activeId, setActiveId]       = useState<string | null>(null)

  // ── Caption / text overlay track ──────────────────────────────────────────
  const captionKey = `captions:${id ?? ''}`
  const [textSlots, setTextSlots] = useState<TextSlot[]>(() => {
    try { return JSON.parse(localStorage.getItem(captionKey) ?? '[]') } catch { return [] }
  })

  function persistCaptions(next: TextSlot[]) {
    setTextSlots(next)
    try { localStorage.setItem(captionKey, JSON.stringify(next)) } catch {}
  }

  function addTextSlot(style: TextSlot['style'], text = '') {
    const slot: TextSlot = { id: crypto.randomUUID(), text, style }
    persistCaptions([...textSlots, slot])
  }

  function updateTextSlot(slotId: string, patch: Partial<TextSlot>) {
    persistCaptions(textSlots.map((s) => s.id === slotId ? { ...s, ...patch } : s))
  }

  function removeTextSlot(slotId: string) {
    persistCaptions(textSlots.filter((s) => s.id !== slotId))
  }

  function moveTextSlot(slotId: string, toIndex: number) {
    const from = textSlots.findIndex((s) => s.id === slotId)
    if (from === -1) return
    const next = [...textSlots]
    const [item] = next.splice(from, 1)
    next.splice(toIndex, 0, item)
    persistCaptions(next)
  }
  const [libScene, setLibScene]       = useState('all')
  const [initDone, setInitDone]       = useState(false)
  const [showExport, setShowExport]   = useState(false)

  // Load project + clips
  useEffect(() => {
    if (!id) return
    setLoading(true)
    Promise.all([api.getProject(id), api.getProjectClips(id)])
      .then(([proj, clips]) => {
        setProject(proj)
        setAllClips(clips)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [id])

  // Add any clips passed from the clip browser (one-time on mount)
  useEffect(() => {
    if (initDone || allClips.length === 0) return
    const addIds: string[] = (location.state as any)?.addClipIds ?? []
    if (addIds.length > 0) {
      const toAdd = allClips.filter((c) => addIds.includes(c.id))
      timeline.clearTimeline()
      timeline.addClips(toAdd)
    }
    setInitDone(true)
  }, [allClips])

  const activeSlot = timeline.slots.find((s) => s.id === activeId) ?? null

  // Clip library filtered list
  const libraryClips = useMemo(() => {
    return allClips.filter((c) =>
      libScene === 'all' || c.scene_tags.some((st) => st.tag === libScene),
    )
  }, [allClips, libScene])

  const timelineClipIds = new Set(timeline.slots.map((s) => s.clipId))

  if (loading) return (
    <div style={styles.center}>
      <p style={styles.hint}>Loading editor…</p>
    </div>
  )

  if (error || !project) return (
    <div style={styles.center}>
      <p style={{ ...styles.hint, color: '#f05060' }}>{error ?? 'Project not found'}</p>
      <button style={styles.backBtn} onClick={() => navigate('/')}>← Back</button>
    </div>
  )

  return (
    <div style={styles.page}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.backBtn} onClick={() => navigate(`/projects/${id}`)}>
            ← Clips
          </button>
          <span style={styles.projectName}>{project.name}</span>
          <span style={styles.duration}>
            {formatDuration(timeline.totalDuration)} total
            · {timeline.slots.length} clip{timeline.slots.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={styles.headerRight}>
          {timeline.slots.length > 0 && (
            <button style={styles.clearBtn} onClick={timeline.clearTimeline}>
              Clear timeline
            </button>
          )}
          <button
            style={{
              ...styles.exportBtn,
              opacity: timeline.slots.length === 0 ? 0.4 : 1,
              cursor: timeline.slots.length === 0 ? 'not-allowed' : 'pointer',
            }}
            disabled={timeline.slots.length === 0}
            onClick={() => setShowExport(true)}
          >
            Export ↓
          </button>
        </div>
      </div>

      {/* ── Main content ───────────────────────────────────────────────── */}
      <div style={styles.main}>

        {/* Left: preview + timeline */}
        <div style={styles.leftCol}>
          <PreviewPlayer clip={activeSlot} />

          <TimelineTrack
            slots={timeline.slots}
            activeId={activeId}
            effectiveDuration={timeline.effectiveDuration}
            onSelect={(slotId) => setActiveId((prev) => prev === slotId ? null : slotId)}
            onRemove={(slotId) => {
              timeline.removeSlot(slotId)
              if (activeId === slotId) setActiveId(null)
            }}
            onMove={timeline.moveSlot}
            onUpdate={timeline.updateSlot}
          />

          <CaptionTrack
            slots={textSlots}
            onAdd={addTextSlot}
            onUpdate={updateTextSlot}
            onRemove={removeTextSlot}
            onMove={moveTextSlot}
            suggestedPlayer={
              activeSlot
                ? (() => {
                    const clip = allClips.find((c) => c.id === activeSlot.clipId)
                    return clip?.players[0]
                      ? `#${clip.players[0].jersey} ${clip.players[0].name}`
                      : undefined
                  })()
                : undefined
            }
          />
        </div>

        {/* Right: clip library panel */}
        <div style={styles.library}>
          <div style={styles.libHeader}>
            <span style={styles.libTitle}>Clip library</span>
            <span style={styles.libCount}>{allClips.length} clips</span>
          </div>

          {/* Scene filter */}
          <div style={styles.libFilters}>
            <button
              style={{ ...styles.libPill, ...(libScene === 'all' ? styles.libPillActive : {}) }}
              onClick={() => setLibScene('all')}
            >
              All
            </button>
            {ALL_SCENES.map((s) => (
              <button
                key={s}
                style={{ ...styles.libPill, ...(libScene === s ? styles.libPillActive : {}) }}
                onClick={() => setLibScene(s)}
              >
                {SCENE_LABEL[s]}
              </button>
            ))}
          </div>

          {/* Clip list */}
          <div style={styles.libList}>
            {libraryClips.length === 0 && (
              <p style={styles.libEmpty}>No clips match this filter.</p>
            )}
            {libraryClips.map((clip) => {
              const inTimeline = timelineClipIds.has(clip.id)
              const tag = clip.scene_tags[0]?.tag ?? ''
              const color = SCENE_COLOR[tag] ?? '#6c63ff'
              const label = SCENE_LABEL[tag] ?? 'CLIP'
              const dur = Math.round(
                parseFloat(clip.timecode_out) - parseFloat(clip.timecode_in),
              )

              return (
                <div
                  key={clip.id}
                  style={{
                    ...styles.libClip,
                    opacity: inTimeline ? 0.5 : 1,
                    cursor: inTimeline ? 'default' : 'pointer',
                    borderLeftColor: color,
                  }}
                  onClick={() => !inTimeline && timeline.addClip(clip)}
                >
                  <div style={styles.libClipTop}>
                    <span style={{ ...styles.libTag, color }}>{label}</span>
                    <span style={styles.libDur}>{dur}s</span>
                    {inTimeline && <span style={styles.inTimelineBadge}>✓</span>}
                  </div>
                  <span style={styles.libTc}>
                    {formatDuration(parseFloat(clip.timecode_in))}
                    {' → '}
                    {formatDuration(parseFloat(clip.timecode_out))}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {showExport && id && (
        <ExportModal
          projectId={id}
          timeline={timeline.slots}
          captions={textSlots}
          totalDuration={timeline.totalDuration}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: 'flex', flexDirection: 'column', height: 'calc(100vh - 53px)',
    overflow: 'hidden',
  },
  center: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: 48, gap: 16,
  },
  hint: { fontSize: 14, color: '#6060a0' },

  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 20px', borderBottom: '1px solid #1a1a2e', flexShrink: 0,
    gap: 12, flexWrap: 'wrap',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  backBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080a0',
    fontSize: 12, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  projectName: { fontSize: 15, fontWeight: 700, color: '#d0d0f0' },
  duration: { fontSize: 12, color: '#505080' },
  clearBtn: {
    background: 'none', border: '1px solid #2a1a3a', color: '#806090',
    fontSize: 12, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
  },
  exportBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 12, fontWeight: 700, padding: '5px 14px',
    borderRadius: 5, cursor: 'pointer',
  },

  main: {
    display: 'flex', flex: 1, overflow: 'hidden', gap: 0,
  },
  leftCol: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 8,
    padding: '12px 8px 12px 12px', overflow: 'hidden', minWidth: 0,
  },

  library: {
    width: 260, flexShrink: 0,
    display: 'flex', flexDirection: 'column',
    borderLeft: '1px solid #1a1a2e', overflow: 'hidden',
  },
  libHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 14px 6px', flexShrink: 0,
  },
  libTitle: { fontSize: 11, fontWeight: 700, color: '#6060a0', textTransform: 'uppercase', letterSpacing: '0.08em' },
  libCount: { fontSize: 11, color: '#404060' },
  libFilters: {
    display: 'flex', flexWrap: 'wrap', gap: 4, padding: '0 10px 8px',
    flexShrink: 0, borderBottom: '1px solid #1a1a2e',
  },
  libPill: {
    background: 'none', border: '1px solid #1a1a2e', color: '#6060a0',
    fontSize: 10, padding: '2px 7px', borderRadius: 3, cursor: 'pointer',
  },
  libPillActive: { background: '#6c63ff', borderColor: '#6c63ff', color: '#fff' },
  libList: { flex: 1, overflowY: 'auto', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 },
  libEmpty: { fontSize: 12, color: '#404060', textAlign: 'center', padding: '24px 0', margin: 0 },
  libClip: {
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: '7px 10px', background: '#111128',
    border: '1px solid #1e1e30', borderLeft: '3px solid',
    borderRadius: 6, flexShrink: 0,
  },
  libClipTop: { display: 'flex', alignItems: 'center', gap: 6 },
  libTag: { fontSize: 10, fontWeight: 800, letterSpacing: '0.06em' },
  libDur: { fontSize: 10, color: '#505080' },
  inTimelineBadge: { marginLeft: 'auto', fontSize: 11, color: '#6c63ff', fontWeight: 700 },
  libTc: { fontSize: 10, color: '#404060', fontFamily: 'monospace' },
}
