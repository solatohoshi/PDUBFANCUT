import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import type { Project } from '../lib/api'

const STATUS_COLOR: Record<Project['status'], string> = {
  uploading:  '#a0a0b0',
  processing: '#f0a020',
  ready:      '#40d080',
  failed:     '#f05060',
}

interface Props {
  refreshSignal?: number
}

export function ProjectList({ refreshSignal }: Props) {
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  function fetchProjects() {
    return api.listProjects().then(setProjects).catch(console.error)
  }

  useEffect(() => {
    setLoading(true)
    fetchProjects().finally(() => setLoading(false))
  }, [refreshSignal])

  // Auto-poll every 3 s while any project is still uploading or processing.
  // Keyed on the derived boolean so each fetch (new array identity) doesn't
  // tear down and recreate the interval.
  const hasActive = projects.some(
    (p) => p.status === 'uploading' || p.status === 'processing',
  )
  useEffect(() => {
    if (!hasActive) return
    const timer = setInterval(fetchProjects, 3000)
    return () => clearInterval(timer)
  }, [hasActive])

  if (loading) return <p style={styles.hint}>Loading…</p>
  if (!projects.length) return <p style={styles.hint}>No projects yet — upload a file to get started.</p>

  return (
    <div style={styles.list}>
      {projects.map((p) => (
        <div
          key={p.id}
          style={{
            ...styles.row,
            cursor: p.status === 'ready' ? 'pointer' : 'default',
          }}
          onClick={() => p.status === 'ready' && navigate(`/projects/${p.id}`)}
        >
          <div style={styles.info}>
            <span style={styles.name}>{p.name}</span>
            <span style={styles.meta}>
              {p.analysis_mode === 'full' ? 'Full analysis' : 'Quick search'} ·{' '}
              {new Date(p.created_at).toLocaleDateString()}
            </span>
          </div>
          <div style={styles.right}>
            <span style={{ ...styles.badge, color: STATUS_COLOR[p.status] }}>
              {p.status}
            </span>
            {p.status === 'ready' && <span style={styles.arrow}>→</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 16px', background: '#111128', borderRadius: 8,
    border: '1px solid #1e1e30',
  },
  info: { display: 'flex', flexDirection: 'column', gap: 2 },
  name: { fontSize: 14, fontWeight: 600, color: '#e0e0f0' },
  meta: { fontSize: 12, color: '#6060a0' },
  right: { display: 'flex', alignItems: 'center', gap: 12 },
  badge: { fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' },
  arrow: { fontSize: 16, color: '#6c63ff' },
  hint: { fontSize: 14, color: '#5050a0', textAlign: 'center', padding: '24px 0' },
}
