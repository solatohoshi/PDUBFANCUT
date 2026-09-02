import { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { api } from '../lib/api'
import type { ProjectDetail, Clip } from '../lib/api'
import { useTimeline, effectiveDuration } from '../hooks/useTimeline'
import { SCENE_LABEL, SCENE_COLOR } from '../hooks/useTimeline'
import { PreviewPlayer } from '../components/timeline/PreviewPlayer'
import type { PreviewPlayerHandle } from '../components/timeline/PreviewPlayer'
import { TimelineTrack } from '../components/timeline/TimelineTrack'
import { ExportModal } from '../components/ExportModal'
import type { TextSlot } from '../components/timeline/CaptionTrack'
import type { MusicTrack } from '../lib/api'
import { useMediaToken } from '../hooks/useMediaToken'

const DEFAULT_TEXT_DURATION_SECS = 3

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
  const { mediaToken, mediaTokenError } = useMediaToken(id)

  const timeline = useTimeline(id ?? '')
  const [activeId, setActiveId]       = useState<string | null>(null)

  // ── Text overlay track — positioned in absolute timeline seconds, shared
  // with the video track's own time axis (dragged directly on TimelineTrack) ──
  const captionKey = `captions:${id ?? ''}`
  const [textSlots, setTextSlots] = useState<TextSlot[]>(() => {
    try { return JSON.parse(localStorage.getItem(captionKey) ?? '[]') } catch { return [] }
  })

  useEffect(() => {
    try { localStorage.setItem(captionKey, JSON.stringify(textSlots)) } catch {}
  }, [textSlots, captionKey])

  // New text is dropped in at the active clip's own position on the shared
  // timeline (or t=0 if nothing's selected) so it starts out roughly where
  // the user's looking, ready to be dragged into its exact spot.
  const activeClipStartRef = useRef(0)

  // Stable (functional-update) callbacks so the memoized TimelineTrack only
  // re-renders when its slots actually change
  const addTextSlot = useCallback((style: TextSlot['style']) => {
    setTextSlots((prev) => [...prev, {
      id: crypto.randomUUID(), text: '', style,
      startSecs: activeClipStartRef.current,
      durationSecs: DEFAULT_TEXT_DURATION_SECS,
    }])
  }, [])

  const updateTextSlot = useCallback((slotId: string, patch: Partial<TextSlot>) => {
    setTextSlots((prev) => prev.map((s) => s.id === slotId ? { ...s, ...patch } : s))
  }, [])

  const removeTextSlot = useCallback((slotId: string) => {
    setTextSlots((prev) => prev.filter((s) => s.id !== slotId))
  }, [])

  // ── Background music ────────────────────────────────────────────────────
  const musicVolumeKey = `music-volume:${id ?? ''}`
  const [musicTrack, setMusicTrack]   = useState<MusicTrack | null>(null)
  const [musicVolume, setMusicVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem(musicVolumeKey) ?? '0.5')
    return isNaN(saved) ? 0.5 : saved
  })
  const musicPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!id) return
    api.getMusic(id).then(setMusicTrack).catch(() => {})
  }, [id])

  useEffect(() => {
    try { localStorage.setItem(musicVolumeKey, String(musicVolume)) } catch {}
  }, [musicVolume, musicVolumeKey])

  const handleUploadMusic = useCallback((file: File) => {
    if (!id) return
    api.uploadMusic(id, file).then(setMusicTrack).catch((e: any) => alert(e.message ?? 'Upload failed'))
  }, [id])

  const handleRemoveMusic = useCallback(() => {
    if (!id) return
    api.deleteMusic(id).then(() => setMusicTrack(null)).catch(() => {})
  }, [id])

  // Applies instantly to local state for responsive dragging, but debounces
  // the network PATCH — a drag fires this on every mousemove tick, and the
  // backend only needs the final resting position once the gesture settles.
  const handleUpdateMusic = useCallback((patch: { startSecs?: number; trimStart?: number; trimEnd?: number }) => {
    setMusicTrack((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        start_secs: patch.startSecs != null ? String(patch.startSecs) : prev.start_secs,
        trim_start: patch.trimStart != null ? String(patch.trimStart) : prev.trim_start,
        trim_end:   patch.trimEnd   != null ? String(patch.trimEnd)   : prev.trim_end,
      }
    })
    if (!id) return
    if (musicPatchTimer.current) clearTimeout(musicPatchTimer.current)
    musicPatchTimer.current = setTimeout(() => {
      api.updateMusic(id, patch).catch(() => {})
    }, 300)
  }, [id])

  const [libScene, setLibScene]       = useState('all')
  const [libSearch, setLibSearch]     = useState('')
  const [initDone, setInitDone]       = useState(false)
  const [showExport, setShowExport]   = useState(false)
  const previewRef = useRef<PreviewPlayerHandle>(null)

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

  useEffect(() => {
    if (mediaTokenError) setError(mediaTokenError)
  }, [mediaTokenError])

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

  // Auto-select the first slot so the preview shows immediately on page load
  useEffect(() => {
    if (!initDone || activeId !== null || timeline.slots.length === 0) return
    setActiveId(timeline.slots[0].id)
  }, [initDone, timeline.slots.length])

  const activeSlot = timeline.slots.find((s) => s.id === activeId) ?? null
  const { removeSlot, moveSlot, updateSlot, updateColorAdjust, splitSlot, mergeSlots, addClip } = timeline

  // The active clip's own start offset within the shared multi-track timeline
  // (sum of effectiveDuration for every slot before it) — used both to seed
  // new text at a sensible position and to let PreviewPlayer translate its
  // single-clip playhead into the same absolute domain text/music live in.
  const activeClipAbsoluteStart = useMemo(() => {
    let acc = 0
    for (const s of timeline.slots) {
      if (s.id === activeId) break
      acc += effectiveDuration(s)
    }
    return acc
  }, [timeline.slots, activeId])
  activeClipStartRef.current = activeClipAbsoluteStart

  // Stable handlers for the memoized TimelineTrack
  const handleSelect = useCallback((slotId: string) => {
    setActiveId((prev) => prev === slotId ? null : slotId)
  }, [])

  const handleRemove = useCallback((slotId: string) => {
    removeSlot(slotId)
    setActiveId((prev) => prev === slotId ? null : prev)
  }, [removeSlot])

  // Splits the active slot into two clips at the preview player's current
  // playhead position (the left half keeps the active slot's id, so
  // selection stays put; the right half becomes a new independent clip).
  // Selecting a clip always resets the preview to its start, so a user who
  // clicks Split without first scrubbing/playing would otherwise hit the
  // "too close to the edge" guard and get a silent no-op — fall back to the
  // clip's midpoint in that case so Split always does something useful.
  const handleSplit = useCallback(() => {
    if (!activeId || !activeSlot) return
    const effIn  = activeSlot.tcIn + activeSlot.trimStart
    const effOut = activeSlot.tcOut - activeSlot.trimEnd
    const MIN_SPLIT_SECS = 0.5
    const raw = previewRef.current?.getCurrentTime()
    const t = (raw == null || raw <= effIn + MIN_SPLIT_SECS || raw >= effOut - MIN_SPLIT_SECS)
      ? (effIn + effOut) / 2
      : raw
    splitSlot(activeId, t, 'both')
  }, [activeId, activeSlot, splitSlot])

  const allClipsRef = useRef(allClips)
  allClipsRef.current = allClips
  const handleDropClip = useCallback((clipId: string) => {
    const clip = allClipsRef.current.find((c) => c.id === clipId)
    if (clip) addClip(clip)
  }, [addClip])

  // Keyboard shortcuts: Space = play/pause, Delete/Backspace = remove, ←/→ = step
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isEditable = e.target instanceof HTMLInputElement
        || e.target instanceof HTMLTextAreaElement
        || e.target instanceof HTMLSelectElement
      if (isEditable) return
      if (e.key === ' ') {
        e.preventDefault()
        previewRef.current?.togglePlay()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!activeId) return
        e.preventDefault()
        timeline.removeSlot(activeId)
        setActiveId(null)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const idx = timeline.slots.findIndex((s) => s.id === activeId)
        if (idx > 0) setActiveId(timeline.slots[idx - 1].id)
        else if (idx === -1 && timeline.slots.length > 0) setActiveId(timeline.slots[timeline.slots.length - 1].id)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const idx = timeline.slots.findIndex((s) => s.id === activeId)
        if (idx >= 0 && idx < timeline.slots.length - 1) setActiveId(timeline.slots[idx + 1].id)
        else if (idx === -1 && timeline.slots.length > 0) setActiveId(timeline.slots[0].id)
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault()
        handleSplit()
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        timeline.undo()
      } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault()
        timeline.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, timeline.slots, timeline.removeSlot, timeline.undo, timeline.redo, handleSplit])

  // Clip library filtered list (scene + player search)
  const libraryClips = useMemo(() => {
    const q = libSearch.trim().toLowerCase()
    return allClips.filter((c) => {
      const sceneMatch = libScene === 'all' || c.scene_tags.some((st) => st.tag === libScene)
      const searchMatch = q === '' || c.players.some(
        (p) => p.jersey.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      )
      return sceneMatch && searchMatch
    })
  }, [allClips, libScene, libSearch])

  const timelineClipIds = useMemo(
    () => new Set(timeline.slots.map((s) => s.clipId)),
    [timeline.slots],
  )

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
          <button
            style={{ ...styles.undoBtn, opacity: timeline.canUndo ? 1 : 0.35, cursor: timeline.canUndo ? 'pointer' : 'not-allowed' }}
            disabled={!timeline.canUndo}
            onClick={timeline.undo}
            title="Undo (Ctrl/Cmd+Z)"
          >
            ↺ Undo
          </button>
          <button
            style={{ ...styles.undoBtn, opacity: timeline.canRedo ? 1 : 0.35, cursor: timeline.canRedo ? 'pointer' : 'not-allowed' }}
            disabled={!timeline.canRedo}
            onClick={timeline.redo}
            title="Redo (Ctrl/Cmd+Shift+Z)"
          >
            ↻ Redo
          </button>
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
          <PreviewPlayer
            ref={previewRef}
            clip={activeSlot}
            textSlots={textSlots}
            clipAbsoluteStart={activeClipAbsoluteStart}
            mediaToken={mediaToken}
          />

          {id && (
            <TimelineTrack
              slots={timeline.slots}
              activeId={activeId}
              onSelect={handleSelect}
              onRemove={handleRemove}
              onMove={moveSlot}
              onUpdate={updateSlot}
              onUpdateColor={updateColorAdjust}
              onSplit={handleSplit}
              onMerge={mergeSlots}
              onCheckpoint={timeline.checkpoint}
              onDropClip={handleDropClip}
              textSlots={textSlots}
              onAddText={addTextSlot}
              onUpdateText={updateTextSlot}
              onRemoveText={removeTextSlot}
              projectId={id}
              mediaToken={mediaToken}
              music={musicTrack}
              musicVolume={musicVolume}
              onVolumeChange={setMusicVolume}
              onUploadMusic={handleUploadMusic}
              onRemoveMusic={handleRemoveMusic}
              onUpdateMusic={handleUpdateMusic}
            />
          )}
        </div>

        {/* Right: clip library panel */}
        <div style={styles.library}>
          <div style={styles.libHeader}>
            <span style={styles.libTitle}>Clip library</span>
            <span style={styles.libCount}>{allClips.length} clips</span>
          </div>

          {/* Player search */}
          <div style={styles.libSearchWrap}>
            <input
              type="text"
              placeholder="Search by player name or #…"
              value={libSearch}
              onChange={(e) => setLibSearch(e.target.value)}
              style={styles.libSearchInput}
            />
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
                  draggable={!inTimeline}
                  onDragStart={(e) => {
                    if (inTimeline) { e.preventDefault(); return }
                    e.dataTransfer.setData('text/clip-id', clip.id)
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  style={{
                    ...styles.libClip,
                    opacity: inTimeline ? 0.5 : 1,
                    cursor: inTimeline ? 'default' : 'grab',
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
          musicVolume={musicTrack ? musicVolume : undefined}
          totalDuration={timeline.totalDuration}
          onClose={() => setShowExport(false)}
          mediaToken={mediaToken}
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
  undoBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080a0',
    fontSize: 12, padding: '4px 10px', borderRadius: 5,
  },
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
  libSearchWrap: { padding: '6px 10px 4px', flexShrink: 0 },
  libSearchInput: {
    width: '100%', background: '#111128', border: '1px solid #1e1e30',
    color: '#c0c0e0', fontSize: 11, padding: '5px 8px', borderRadius: 5,
    outline: 'none', boxSizing: 'border-box' as const,
  },
}
