import { useState } from 'react'

const SCENE_OPTIONS = ['goal', 'save', 'shot_on_goal', 'hit', 'scrum', 'celebration', 'penalty', 'faceoff']

export interface AnalysisParams {
  analysisMode: 'full' | 'quick'
  quickSearchParams?: { players: string[]; scenes: string[] }
}

interface Props {
  onChange: (params: AnalysisParams) => void
}

export function AnalysisModeSelector({ onChange }: Props) {
  const [mode, setMode] = useState<'full' | 'quick'>('full')
  const [playerInput, setPlayerInput] = useState('')
  const [players, setPlayers] = useState<string[]>([])
  const [scenes, setScenes] = useState<string[]>([])

  function selectMode(m: 'full' | 'quick') {
    setMode(m)
    if (m === 'full') {
      onChange({ analysisMode: 'full' })
    } else {
      onChange({ analysisMode: 'quick', quickSearchParams: { players, scenes } })
    }
  }

  function addPlayer() {
    const val = playerInput.trim()
    if (!val || players.includes(val)) return
    const next = [...players, val]
    setPlayers(next)
    setPlayerInput('')
    onChange({ analysisMode: 'quick', quickSearchParams: { players: next, scenes } })
  }

  function removePlayer(p: string) {
    const next = players.filter((x) => x !== p)
    setPlayers(next)
    onChange({ analysisMode: 'quick', quickSearchParams: { players: next, scenes } })
  }

  function toggleScene(s: string) {
    const next = scenes.includes(s) ? scenes.filter((x) => x !== s) : [...scenes, s]
    setScenes(next)
    onChange({ analysisMode: 'quick', quickSearchParams: { players, scenes: next } })
  }

  return (
    <div style={styles.container}>
      <p style={styles.label}>Analysis mode</p>

      <div style={styles.modeRow}>
        <button
          style={{ ...styles.modeBtn, ...(mode === 'full' ? styles.modeBtnActive : {}) }}
          onClick={() => selectMode('full')}
        >
          <strong>Full analysis</strong>
          <span style={styles.modeDesc}>Tag every moment in the entire file</span>
        </button>

        <button
          style={{ ...styles.modeBtn, ...(mode === 'quick' ? styles.modeBtnActive : {}) }}
          onClick={() => selectMode('quick')}
        >
          <strong>Quick search</strong>
          <span style={styles.modeDesc}>Only process what you specify</span>
        </button>
      </div>

      {mode === 'quick' && (
        <div style={styles.quickPanel}>
          <p style={styles.warning}>
            You can run additional searches later, but each one requires extra processing time.
          </p>

          <div style={styles.field}>
            <label style={styles.fieldLabel}>Players (jersey # or name)</label>
            <div style={styles.inputRow}>
              <input
                style={styles.input}
                placeholder="e.g. #18 or Poulin"
                value={playerInput}
                onChange={(e) => setPlayerInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addPlayer()}
              />
              <button style={styles.addBtn} onClick={addPlayer}>Add</button>
            </div>
            <div style={styles.tagRow}>
              {players.map((p) => (
                <span key={p} style={styles.tag}>
                  {p} <button style={styles.tagX} onClick={() => removePlayer(p)}>×</button>
                </span>
              ))}
            </div>
          </div>

          <div style={styles.field}>
            <label style={styles.fieldLabel}>Scene types</label>
            <div style={styles.tagRow}>
              {SCENE_OPTIONS.map((s) => (
                <button
                  key={s}
                  style={{ ...styles.sceneBtn, ...(scenes.includes(s) ? styles.sceneBtnActive : {}) }}
                  onClick={() => toggleScene(s)}
                >
                  {s.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', gap: 16 },
  label: { fontWeight: 600, fontSize: 14, color: '#a0a0b0' },
  modeRow: { display: 'flex', gap: 12 },
  modeBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px',
    background: '#1a1a2e', border: '2px solid #2a2a3e', borderRadius: 10,
    color: '#f0f0f5', cursor: 'pointer', textAlign: 'left',
  },
  modeBtnActive: { borderColor: '#6c63ff', background: '#1e1b3a' },
  modeDesc: { fontSize: 12, color: '#7070a0', fontWeight: 400 },
  quickPanel: { display: 'flex', flexDirection: 'column', gap: 16, padding: '16px', background: '#111128', borderRadius: 10 },
  warning: { fontSize: 12, color: '#f0a020', background: '#2a1e00', padding: '8px 12px', borderRadius: 6 },
  field: { display: 'flex', flexDirection: 'column', gap: 8 },
  fieldLabel: { fontSize: 13, color: '#a0a0b0', fontWeight: 500 },
  inputRow: { display: 'flex', gap: 8 },
  input: {
    flex: 1, padding: '8px 12px', background: '#1a1a2e', border: '1px solid #2a2a3e',
    borderRadius: 6, color: '#f0f0f5', fontSize: 14,
  },
  addBtn: {
    padding: '8px 16px', background: '#6c63ff', border: 'none', borderRadius: 6,
    color: '#fff', cursor: 'pointer', fontSize: 14,
  },
  tagRow: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  tag: {
    display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
    background: '#2a2a3e', borderRadius: 20, fontSize: 13, color: '#d0d0e8',
  },
  tagX: { background: 'none', border: 'none', color: '#7070a0', cursor: 'pointer', padding: 0, fontSize: 14 },
  sceneBtn: {
    padding: '6px 12px', background: '#1a1a2e', border: '1px solid #2a2a3e',
    borderRadius: 20, color: '#a0a0b0', cursor: 'pointer', fontSize: 13,
  },
  sceneBtnActive: { background: '#2a2060', borderColor: '#6c63ff', color: '#c0b8ff' },
}
