import type { UploadState } from '../hooks/useUpload'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function eta(remaining: number, speed: number) {
  if (speed <= 0) return '—'
  const secs = Math.round(remaining / speed)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  return `${mins}m ${s}s`
}

interface Props {
  state: UploadState
  onReset?: () => void
}

export function UploadProgress({ state, onReset }: Props) {
  const { phase, progress, bytesUploaded, bytesTotal, speedBytesPerSec, error } = state
  const remaining = bytesTotal - bytesUploaded

  if (phase === 'idle') return null

  return (
    <div style={styles.card}>
      {phase === 'creating' && <p style={styles.status}>Creating project…</p>}

      {phase === 'uploading' && (
        <>
          <div style={styles.header}>
            <span style={styles.status}>Uploading…</span>
            <span style={styles.pct}>{progress}%</span>
          </div>
          <div style={styles.track}>
            <div style={{ ...styles.fill, width: `${progress}%` }} />
          </div>
          <div style={styles.meta}>
            <span>{formatBytes(bytesUploaded)} / {formatBytes(bytesTotal)}</span>
            <span>{formatBytes(speedBytesPerSec)}/s · {eta(remaining, speedBytesPerSec)} left</span>
          </div>
        </>
      )}

      {phase === 'processing' && (
        <div style={styles.header}>
          <span style={styles.status}>⏳ Upload complete — AI pipeline running in the background</span>
        </div>
      )}

      {phase === 'done' && (
        <div style={styles.header}>
          <span style={{ ...styles.status, color: '#40d080' }}>✓ Clips are ready</span>
          {onReset && <button style={styles.btn} onClick={onReset}>New upload</button>}
        </div>
      )}

      {phase === 'error' && (
        <div style={styles.errorBox}>
          <span>Upload failed: {error}</span>
          {onReset && <button style={styles.btn} onClick={onReset}>Try again</button>}
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: '16px 20px', background: '#111128', borderRadius: 10,
    border: '1px solid #2a2a3e',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  status: { fontSize: 14, color: '#c0c0e0' },
  pct: { fontSize: 14, fontWeight: 700, color: '#6c63ff' },
  track: { height: 6, background: '#2a2a3e', borderRadius: 3, overflow: 'hidden' },
  fill: { height: '100%', background: '#6c63ff', borderRadius: 3, transition: 'width 0.3s' },
  meta: { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6060a0' },
  errorBox: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 14, color: '#f05060',
  },
  btn: {
    padding: '6px 14px', background: '#6c63ff', border: 'none', borderRadius: 6,
    color: '#fff', cursor: 'pointer', fontSize: 13,
  },
}
