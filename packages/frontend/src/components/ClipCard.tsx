import type { Clip } from '../lib/api'

const SCENE_COLOR: Record<string, string> = {
  goal:         '#f0c020',
  save:         '#40d080',
  shot_on_goal: '#6c63ff',
  hit:          '#f08020',
  faceoff:      '#60c0f0',
  scrum:        '#c060d0',
  penalty:      '#f05060',
  celebration:  '#f0d040',
}

const SCENE_LABEL: Record<string, string> = {
  goal:         'GOAL',
  save:         'SAVE',
  shot_on_goal: 'SHOT',
  hit:          'HIT',
  faceoff:      'FACEOFF',
  scrum:        'SCRUM',
  penalty:      'PENALTY',
  celebration:  'CELEB',
}

function formatTimecode(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function confidenceColor(c: number): string {
  if (c >= 0.85) return '#40d080'
  if (c >= 0.70) return '#f0a020'
  return '#f05060'
}

interface Props {
  clip: Clip
  selected: boolean
  onToggle: () => void
  onConfirm?: () => void
  onDismiss?: () => void
}

export function ClipCard({ clip, selected, onToggle, onConfirm, onDismiss }: Props) {
  const tcIn  = parseFloat(clip.timecode_in)
  const tcOut = parseFloat(clip.timecode_out)
  const dur   = Math.round(tcOut - tcIn)
  const conf  = parseFloat(clip.confidence)

  const primaryTag   = clip.scene_tags[0]
  const primaryColor = primaryTag ? (SCENE_COLOR[primaryTag.tag] ?? '#6c63ff') : '#6c63ff'

  return (
    <div
      style={{
        ...styles.card,
        borderColor: selected ? '#6c63ff' : '#1e1e30',
        borderTopColor: primaryColor,
      }}
      onClick={onToggle}
    >
      {/* Scene type badges */}
      <div style={styles.tags}>
        {clip.scene_tags.map((st) => (
          <span
            key={st.tag}
            style={{
              ...styles.sceneTag,
              color: SCENE_COLOR[st.tag] ?? '#e0e0f0',
              borderColor: SCENE_COLOR[st.tag] ?? '#1e1e30',
            }}
          >
            {SCENE_LABEL[st.tag] ?? st.tag.toUpperCase()}
          </span>
        ))}
      </div>

      {/* Timecode range */}
      <div style={styles.timecode}>
        <span>{formatTimecode(tcIn)}</span>
        <span style={styles.tcArrow}>→</span>
        <span>{formatTimecode(tcOut)}</span>
        <span style={styles.dur}>{dur}s</span>
      </div>

      {/* Confidence bar */}
      <div style={styles.confRow}>
        <div style={styles.confBar}>
          <div
            style={{
              ...styles.confFill,
              width: `${Math.round(conf * 100)}%`,
              background: confidenceColor(conf),
            }}
          />
        </div>
        <span style={{ ...styles.confLabel, color: confidenceColor(conf) }}>
          {Math.round(conf * 100)}%
        </span>
      </div>

      {/* Players */}
      {clip.players.length > 0 && (
        <div style={styles.players}>
          {clip.players.map((p, i) => (
            <span key={i} style={styles.playerTag}>#{p.jersey} {p.name}</span>
          ))}
        </div>
      )}

      {/* Footer */}
      <div style={styles.footer}>
        <span style={{
          ...styles.status,
          color: clip.review_status === 'confirmed' ? '#40d080'
               : clip.review_status === 'dismissed' ? '#f05060'
               : conf < 0.85 ? '#f0a020' : '#505080',
        }}>
          ● {clip.review_status === 'auto' && conf < 0.85 ? 'review' : clip.review_status}
        </span>
        {selected && <span style={styles.checkmark}>✓</span>}
      </div>

      {/* Review actions — shown for low-confidence unreviewed clips */}
      {clip.review_status === 'auto' && conf < 0.85 && (onConfirm || onDismiss) && (
        <div style={styles.reviewActions}>
          {onConfirm && (
            <button
              style={styles.confirmBtn}
              onClick={(e) => { e.stopPropagation(); onConfirm() }}
            >
              ✓ Confirm
            </button>
          )}
          {onDismiss && (
            <button
              style={styles.dismissBtn}
              onClick={(e) => { e.stopPropagation(); onDismiss() }}
            >
              ✕ Dismiss
            </button>
          )}
        </div>
      )}

      {/* Re-open dismissed clips */}
      {clip.review_status === 'dismissed' && onConfirm && (
        <button
          style={{ ...styles.confirmBtn, marginTop: 4 }}
          onClick={(e) => { e.stopPropagation(); onConfirm() }}
        >
          ↩ Restore
        </button>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#111128',
    border: '1px solid #1e1e30',
    borderTop: '3px solid #6c63ff',
    borderRadius: 8,
    padding: '14px 16px',
    cursor: 'pointer',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    userSelect: 'none',
  },
  tags: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  sceneTag: {
    fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
    padding: '2px 6px', border: '1px solid',
    borderRadius: 4,
  },
  timecode: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 13, fontWeight: 600, color: '#e0e0f0', fontFamily: 'monospace',
  },
  tcArrow: { color: '#404060', fontSize: 11 },
  dur: { marginLeft: 'auto', fontSize: 11, color: '#505080', fontWeight: 400 },
  confRow: { display: 'flex', alignItems: 'center', gap: 8 },
  confBar: {
    flex: 1, height: 4, background: '#1a1a30', borderRadius: 2, overflow: 'hidden',
  },
  confFill: { height: '100%', borderRadius: 2 },
  confLabel: { fontSize: 12, fontWeight: 700, width: 34, textAlign: 'right' },
  players: { display: 'flex', gap: 5, flexWrap: 'wrap' },
  playerTag: {
    fontSize: 11, color: '#9090b0',
    background: '#0d0d1a', padding: '2px 7px', borderRadius: 4,
    border: '1px solid #1e1e30',
  },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  status: { fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' },
  checkmark: { fontSize: 11, color: '#6c63ff', fontWeight: 700 },
  reviewActions: { display: 'flex', gap: 6 },
  confirmBtn: {
    flex: 1, background: 'rgba(64,208,128,0.12)', border: '1px solid #40d080',
    color: '#40d080', fontSize: 11, fontWeight: 700, padding: '4px 0',
    borderRadius: 5, cursor: 'pointer',
  },
  dismissBtn: {
    flex: 1, background: 'rgba(240,80,96,0.1)', border: '1px solid #f05060',
    color: '#f05060', fontSize: 11, fontWeight: 700, padding: '4px 0',
    borderRadius: 5, cursor: 'pointer',
  },
}
