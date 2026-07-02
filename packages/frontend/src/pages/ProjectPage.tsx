import { useEffect, useState, useMemo, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import type { ProjectDetail, Clip } from '../lib/api'
import { ClipCard } from '../components/ClipCard'

const ALL_SCENES = [
  'goal', 'save', 'shot_on_goal', 'hit',
  'faceoff', 'scrum', 'penalty', 'celebration',
]

const SCENE_LABEL: Record<string, string> = {
  goal: 'Goal', save: 'Save', shot_on_goal: 'Shot', hit: 'Hit',
  faceoff: 'Faceoff', scrum: 'Scrum', penalty: 'Penalty', celebration: 'Celeb',
}

const STATUS_COLOR: Record<string, string> = {
  uploading:  '#a0a0b0',
  processing: '#f0a020',
  ready:      '#40d080',
  failed:     '#f05060',
}

export function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [project, setProject]   = useState<ProjectDetail | null>(null)
  const [clips, setClips]       = useState<Clip[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [readyBanner, setReadyBanner] = useState(false)
  const prevStatus = useRef<string | null>(null)

  // Filters
  const [sceneFilter, setSceneFilter]     = useState('all')
  const [minConfidence, setMinConfidence] = useState(0)
  const [statusFilter, setStatusFilter]   = useState('all')
  const [sortBy, setSortBy]               = useState<'time' | 'confidence'>('time')

  // Multi-select
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Add-search modal
  const [showAddSearch, setShowAddSearch]   = useState(false)
  const [searchPlayers, setSearchPlayers]   = useState('')
  const [searchScenes, setSearchScenes]     = useState<string[]>([])
  const [searchSubmitting, setSearchSubmitting] = useState(false)

  function loadData() {
    if (!id) return
    return Promise.all([api.getProject(id), api.getProjectClips(id)])
      .then(([proj, cls]) => {
        setProject((prev) => {
          if (prev?.status === 'processing' && proj.status === 'ready') {
            setReadyBanner(true)
          }
          prevStatus.current = proj.status
          return proj
        })
        setClips(cls)
      })
      .catch((err) => setError(err.message))
  }

  useEffect(() => {
    setLoading(true)
    loadData()?.finally(() => setLoading(false))
  }, [id])

  // Auto-refresh while processing
  useEffect(() => {
    if (!id || project?.status !== 'processing') return
    const timer = setInterval(loadData, 5000)
    return () => clearInterval(timer)
  }, [id, project?.status])

  const filteredClips = useMemo(() => {
    let result = clips.filter((c) => {
      if (sceneFilter !== 'all' && !c.scene_tags.some((st) => st.tag === sceneFilter)) return false
      if (parseFloat(c.confidence) < minConfidence) return false
      if (statusFilter !== 'all' && c.review_status !== statusFilter) return false
      return true
    })
    return sortBy === 'confidence'
      ? [...result].sort((a, b) => parseFloat(b.confidence) - parseFloat(a.confidence))
      : [...result].sort((a, b) => parseFloat(a.timecode_in) - parseFloat(b.timecode_in))
  }, [clips, sceneFilter, minConfidence, statusFilter, sortBy])

  const reviewQueueClips = useMemo(
    () => clips.filter((c) => c.review_status === 'auto' && parseFloat(c.confidence) < 0.85),
    [clips],
  )

  function toggleClip(clipId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(clipId)) next.delete(clipId)
      else next.add(clipId)
      return next
    })
  }

  function addAllScene(scene: string) {
    const ids = clips
      .filter((c) => c.scene_tags.some((st) => st.tag === scene))
      .map((c) => c.id)
    if (ids.length === 0) return
    navigate(`/projects/${id}/editor`, { state: { addClipIds: ids } })
  }

  async function handleReviewStatus(clipId: string, status: 'confirmed' | 'dismissed' | 'auto') {
    try {
      const updated = await api.updateClipStatus(clipId, status)
      setClips((prev) => prev.map((c) => c.id === updated.id ? updated : c))
    } catch {}
  }

  async function handleUpgradeAnalysis() {
    if (!id) return
    try {
      await api.upgradeToFullAnalysis(id)
      setProject((p) => p ? { ...p, analysis_mode: 'full', status: 'processing' } : p)
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleAddSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!id) return
    const players = searchPlayers.split(',').map((s) => s.trim()).filter(Boolean)
    if (players.length === 0 && searchScenes.length === 0) return
    setSearchSubmitting(true)
    try {
      await api.addSearch(id, { players, scenes: searchScenes })
      setProject((p) => p ? { ...p, status: 'processing' } : p)
      setShowAddSearch(false)
      setSearchPlayers('')
      setSearchScenes([])
    } catch (e: any) {
      alert(e.message)
    } finally {
      setSearchSubmitting(false)
    }
  }

  if (loading) return (
    <div style={styles.center}><p style={styles.hint}>Loading project…</p></div>
  )

  if (error || !project) return (
    <div style={styles.center}>
      <p style={styles.errorText}>{error ?? 'Project not found'}</p>
      <button style={styles.backBtn} onClick={() => navigate('/')}>← Back to projects</button>
    </div>
  )

  const isQuick = project.analysis_mode === 'quick'
  const qsp     = project.quick_search_params

  return (
    <div style={styles.page}>

      {/* ── Clips-ready notification ────────────────────────────────── */}
      {readyBanner && (
        <div style={styles.readyBanner}>
          <span>🎉 Clips are ready!</span>
          <button style={styles.readyClose} onClick={() => setReadyBanner(false)}>✕</button>
        </div>
      )}

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div style={styles.pageHeader}>
        <button style={styles.backBtn} onClick={() => navigate('/')}>← Projects</button>
        <div style={styles.projectMeta}>
          <h1 style={styles.projectName}>{project.name}</h1>
          <div style={styles.metaRow}>
            <span style={{ ...styles.statusBadge, color: STATUS_COLOR[project.status] ?? '#a0a0b0' }}>
              ● {project.status}
            </span>
            <span style={styles.modeChip}>
              {isQuick ? 'Quick search' : 'Full analysis'}
            </span>
            {reviewQueueClips.length > 0 && (
              <span style={styles.reviewChip}>
                {reviewQueueClips.length} in review queue
              </span>
            )}
            <span style={styles.clipCountLabel}>{clips.length} clip{clips.length !== 1 ? 's' : ''}</span>
            {clips.length > 0 && (
              <button style={styles.editorBtn} onClick={() => navigate(`/projects/${id}/editor`)}>
                Open editor →
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Quick search banner ─────────────────────────────────────── */}
      {isQuick && qsp && (
        <div style={styles.quickBanner}>
          <div style={styles.bannerTop}>
            <span style={styles.bannerIcon}>⚡</span>
            <strong style={styles.bannerTitle}>Quick search mode</strong>
            {qsp.scenes.length > 0 && (
              <span style={styles.bannerDetail}> · scenes: {qsp.scenes.join(', ')}</span>
            )}
            {qsp.players.length > 0 && (
              <span style={styles.bannerDetail}> · players: {qsp.players.join(', ')}</span>
            )}
          </div>
          <p style={styles.bannerNote}>
            Only requested events were scanned. Full analysis covers all scene types.
          </p>
          <div style={styles.bannerActions}>
            <button style={styles.upgradeBtn} onClick={handleUpgradeAnalysis}>
              Run full analysis
            </button>
            <button style={styles.addSearchBtn} onClick={() => setShowAddSearch(true)}>
              + Add search
            </button>
          </div>
        </div>
      )}

      {/* ── Processing banner ───────────────────────────────────────── */}
      {project.status === 'processing' && (
        <div style={styles.processingBanner}>
          <span style={styles.spinner}>⟳</span>
          AI pipeline running — this page refreshes automatically every 5 seconds
        </div>
      )}

      {/* ── Add-to-timeline presets ─────────────────────────────────── */}
      {clips.length > 0 && (
        <div style={styles.presetsRow}>
          <span style={styles.presetsLabel}>Quick add:</span>
          {ALL_SCENES.filter((s) => clips.some((c) => c.scene_tags.some((st) => st.tag === s))).map((s) => {
            const count = clips.filter((c) => c.scene_tags.some((st) => st.tag === s)).length
            return (
              <button key={s} style={styles.presetBtn} onClick={() => addAllScene(s)}>
                All {SCENE_LABEL[s]}s ({count}) →
              </button>
            )
          })}
        </div>
      )}

      {/* ── Filter bar ─────────────────────────────────────────────── */}
      <div style={styles.filterBar}>
        <div style={styles.filterGroup}>
          <span style={styles.filterLabel}>Scene type</span>
          <div style={styles.pills}>
            <Pill label="All" active={sceneFilter === 'all'} onClick={() => setSceneFilter('all')} />
            {ALL_SCENES.map((s) => (
              <Pill key={s} label={SCENE_LABEL[s]} active={sceneFilter === s} onClick={() => setSceneFilter(s)} />
            ))}
          </div>
        </div>

        <div style={styles.filterRight}>
          <div style={styles.filterGroup}>
            <span style={styles.filterLabel}>Confidence</span>
            <select style={styles.select} value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}>
              <option value={0}>All</option>
              <option value={0.70}>≥ 70%</option>
              <option value={0.85}>≥ 85%</option>
            </select>
          </div>

          <div style={styles.filterGroup}>
            <span style={styles.filterLabel}>Status</span>
            <select style={styles.select} value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="auto">Auto</option>
              <option value="confirmed">Confirmed</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </div>

          <div style={styles.filterGroup}>
            <span style={styles.filterLabel}>Sort</span>
            <select style={styles.select} value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'time' | 'confidence')}>
              <option value="time">By time</option>
              <option value="confidence">By confidence</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Selection toolbar ───────────────────────────────────────── */}
      {selected.size > 0 && (
        <div style={styles.selectionBar}>
          <span style={styles.selectionCount}>
            {selected.size} clip{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div style={styles.selectionActions}>
            <button style={styles.selBtnGhost} onClick={() => setSelected(new Set())}>Clear</button>
            <button
              style={styles.selBtn}
              onClick={() => navigate(`/projects/${id}/editor`, { state: { addClipIds: [...selected] } })}
            >
              Add to timeline →
            </button>
          </div>
        </div>
      )}

      {/* ── Clip grid ──────────────────────────────────────────────── */}
      {filteredClips.length === 0 ? (
        <div style={styles.empty}>
          {project.status === 'processing'
            ? 'Pipeline is running — clips will appear here when ready.'
            : clips.length === 0
              ? 'No clips yet. Upload a video to get started.'
              : 'No clips match the current filters.'}
        </div>
      ) : (
        <>
          <div style={styles.gridHeader}>
            <span style={styles.resultCount}>
              {filteredClips.length} result{filteredClips.length !== 1 ? 's' : ''}
              {filteredClips.length !== clips.length && ` (of ${clips.length})`}
            </span>
            <button style={styles.selectAllBtn}
              onClick={() => setSelected(new Set(filteredClips.map((c) => c.id)))}>
              Select all
            </button>
          </div>

          <div style={styles.grid}>
            {filteredClips.map((clip) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                selected={selected.has(clip.id)}
                onToggle={() => toggleClip(clip.id)}
                onConfirm={() => handleReviewStatus(clip.id, 'confirmed')}
                onDismiss={() => handleReviewStatus(clip.id, 'dismissed')}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Add search modal ────────────────────────────────────────── */}
      {showAddSearch && (
        <div style={styles.modalOverlay} onClick={(e) => e.target === e.currentTarget && setShowAddSearch(false)}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <span style={styles.modalTitle}>Add search</span>
              <button style={styles.modalClose} onClick={() => setShowAddSearch(false)}>✕</button>
            </div>
            <form onSubmit={handleAddSearch} style={styles.modalBody}>
              <label style={styles.fieldLabel}>
                Player jersey numbers or names
                <input
                  style={styles.fieldInput}
                  placeholder="e.g. 18, Maschmeyer"
                  value={searchPlayers}
                  onChange={(e) => setSearchPlayers(e.target.value)}
                />
              </label>
              <div style={styles.fieldLabel}>
                Scene types
                <div style={styles.sceneCheckGrid}>
                  {ALL_SCENES.map((s) => (
                    <label key={s} style={styles.sceneCheck}>
                      <input
                        type="checkbox"
                        checked={searchScenes.includes(s)}
                        onChange={(e) => setSearchScenes((prev) =>
                          e.target.checked ? [...prev, s] : prev.filter((x) => x !== s)
                        )}
                      />
                      {SCENE_LABEL[s]}
                    </label>
                  ))}
                </div>
              </div>
              <div style={styles.modalFooter}>
                <button type="button" style={styles.cancelBtn} onClick={() => setShowAddSearch(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ ...styles.submitBtn, opacity: searchSubmitting ? 0.6 : 1 }}
                  disabled={searchSubmitting}
                >
                  {searchSubmitting ? 'Starting…' : 'Run search'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function Pill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button style={{ ...pillStyles.base, ...(active ? pillStyles.active : {}) }} onClick={onClick}>
      {label}
    </button>
  )
}

const pillStyles: Record<string, React.CSSProperties> = {
  base: {
    background: 'none', border: '1px solid #1e1e30',
    color: '#7070a0', fontSize: 12, padding: '3px 10px',
    borderRadius: 4, cursor: 'pointer',
  },
  active: { background: '#6c63ff', borderColor: '#6c63ff', color: '#fff' },
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    maxWidth: 1100, width: '100%', margin: '0 auto',
    padding: '24px 24px 64px',
    display: 'flex', flexDirection: 'column', gap: 20,
  },
  center: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '80px 24px', gap: 16,
  },
  hint: { fontSize: 14, color: '#6060a0' },
  errorText: { fontSize: 14, color: '#f05060' },

  readyBanner: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#0a1f10', border: '1px solid #30a060',
    borderRadius: 8, padding: '12px 16px',
    fontSize: 14, fontWeight: 600, color: '#40d080',
  },
  readyClose: {
    background: 'none', border: 'none', color: '#40d080',
    fontSize: 16, cursor: 'pointer', padding: 0,
  },

  pageHeader: { display: 'flex', alignItems: 'flex-start', gap: 16 },
  backBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080a0',
    fontSize: 13, padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  projectMeta: { display: 'flex', flexDirection: 'column', gap: 6 },
  projectName: { fontSize: 22, fontWeight: 700, color: '#e0e0f0', margin: 0 },
  metaRow: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  statusBadge: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' },
  modeChip: {
    fontSize: 11, color: '#6060a0', background: '#0d0d1a',
    padding: '2px 8px', borderRadius: 4, border: '1px solid #1e1e30',
  },
  reviewChip: {
    fontSize: 11, color: '#f0a020', background: '#1a1000',
    padding: '2px 8px', borderRadius: 4, border: '1px solid #604010',
  },
  clipCountLabel: { fontSize: 12, color: '#505080' },
  editorBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 11, fontWeight: 700, padding: '3px 10px',
    borderRadius: 4, cursor: 'pointer',
  },

  quickBanner: {
    background: '#1a1200', border: '1px solid #604010',
    borderRadius: 8, padding: '12px 16px',
    display: 'flex', flexDirection: 'column', gap: 8,
  },
  bannerTop: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 },
  bannerIcon: { marginRight: 4, fontSize: 14 },
  bannerTitle: { fontSize: 13, color: '#f0c060' },
  bannerDetail: { fontSize: 13, color: '#c09040' },
  bannerNote: { fontSize: 12, color: '#806030', margin: 0 },
  bannerActions: { display: 'flex', gap: 8 },
  upgradeBtn: {
    background: '#f0a020', border: 'none', color: '#0d0d00',
    fontSize: 12, fontWeight: 700, padding: '5px 14px',
    borderRadius: 5, cursor: 'pointer',
  },
  addSearchBtn: {
    background: 'none', border: '1px solid #604010', color: '#c09040',
    fontSize: 12, padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
  },

  processingBanner: {
    background: '#0d1a0d', border: '1px solid #204020',
    borderRadius: 8, padding: '12px 16px',
    fontSize: 13, color: '#60c060',
    display: 'flex', alignItems: 'center', gap: 8,
  },
  spinner: { fontSize: 16 },

  presetsRow: {
    display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  },
  presetsLabel: { fontSize: 11, color: '#505080', fontWeight: 600 },
  presetBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#8080b0',
    fontSize: 11, padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
  },

  filterBar: {
    display: 'flex', flexWrap: 'wrap', gap: 16,
    background: '#111128', border: '1px solid #1e1e30',
    borderRadius: 8, padding: '14px 16px',
    alignItems: 'flex-start', justifyContent: 'space-between',
  },
  filterGroup: { display: 'flex', flexDirection: 'column', gap: 6 },
  filterLabel: {
    fontSize: 10, fontWeight: 700, color: '#505080',
    textTransform: 'uppercase', letterSpacing: '0.08em',
  },
  pills: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  filterRight: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' },
  select: {
    background: '#0d0d1a', border: '1px solid #1e1e30',
    color: '#c0c0e0', fontSize: 12, padding: '4px 8px',
    borderRadius: 4, cursor: 'pointer',
  },

  selectionBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#12082a', border: '1px solid #6c63ff',
    borderRadius: 8, padding: '10px 16px',
  },
  selectionCount: { fontSize: 13, color: '#b0a0ff', fontWeight: 600 },
  selectionActions: { display: 'flex', gap: 8 },
  selBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 12, fontWeight: 600, padding: '6px 14px',
    borderRadius: 6, cursor: 'pointer',
  },
  selBtnGhost: {
    background: 'none', border: '1px solid #6c63ff', color: '#b0a0ff',
    fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
  },

  gridHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  resultCount: { fontSize: 13, color: '#505080' },
  selectAllBtn: {
    background: 'none', border: '1px solid #1e1e30',
    color: '#7070a0', fontSize: 12, padding: '3px 10px',
    borderRadius: 4, cursor: 'pointer',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 12,
  },
  empty: {
    fontSize: 14, color: '#505080', textAlign: 'center',
    padding: '60px 24px', background: '#111128',
    borderRadius: 8, border: '1px solid #1e1e30',
  },

  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
  },
  modal: {
    background: '#0d0d1a', border: '1px solid #1e1e30',
    borderRadius: 12, width: '100%', maxWidth: 440,
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 20px 60px rgba(0,0,0,0.6)',
  },
  modalHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '14px 20px', borderBottom: '1px solid #1a1a2e',
  },
  modalTitle: { fontSize: 15, fontWeight: 700, color: '#e0e0f0' },
  modalClose: {
    background: 'none', border: 'none', color: '#6060a0',
    fontSize: 18, cursor: 'pointer', padding: 0,
  },
  modalBody: {
    padding: '20px', display: 'flex', flexDirection: 'column', gap: 16,
  },
  fieldLabel: {
    display: 'flex', flexDirection: 'column', gap: 6,
    fontSize: 12, color: '#8080a0',
  },
  fieldInput: {
    background: '#111128', border: '1px solid #1e1e30', color: '#e0e0f0',
    fontSize: 13, padding: '8px 10px', borderRadius: 6, outline: 'none',
  },
  sceneCheckGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
  },
  sceneCheck: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, color: '#a0a0c0', cursor: 'pointer',
  },
  modalFooter: {
    display: 'flex', justifyContent: 'flex-end', gap: 8,
    padding: '12px 20px', borderTop: '1px solid #1a1a2e',
  },
  cancelBtn: {
    background: 'none', border: '1px solid #1e1e30', color: '#6060a0',
    fontSize: 13, padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
  },
  submitBtn: {
    background: '#6c63ff', border: 'none', color: '#fff',
    fontSize: 13, fontWeight: 700, padding: '7px 18px',
    borderRadius: 6, cursor: 'pointer',
  },
}
