import { useState, useEffect } from 'react'
import { UploadZone } from '../components/UploadZone'
import { UploadProgress } from '../components/UploadProgress'
import { AnalysisModeSelector } from '../components/AnalysisModeSelector'
import { ProjectList } from '../components/ProjectList'
import { useUpload } from '../hooks/useUpload'
import type { AnalysisParams } from '../components/AnalysisModeSelector'

export function HomePage() {
  const [analysisParams, setAnalysisParams] = useState<AnalysisParams>({ analysisMode: 'full' })
  const [refreshSignal, setRefreshSignal] = useState(0)
  const { state, startUpload, reset } = useUpload()

  async function handleFile(file: File) {
    await startUpload(file, analysisParams)
    setRefreshSignal((n) => n + 1)
  }

  // Refresh project list when upload finishes (success or failure).
  // On error the hook deletes the orphaned project server-side, so we need
  // a second refresh to remove it from the list.
  useEffect(() => {
    if (state.phase === 'error' || state.phase === 'processing') {
      setRefreshSignal((n) => n + 1)
    }
  }, [state.phase])

  return (
    <main style={styles.main}>
      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Upload a game file</h2>
        <AnalysisModeSelector onChange={setAnalysisParams} />
        <UploadZone
          onFile={handleFile}
          disabled={state.phase !== 'idle' && state.phase !== 'error'}
        />
        <UploadProgress state={state} onReset={reset} />
      </section>

      <section style={styles.section}>
        <h2 style={styles.sectionTitle}>Projects</h2>
        <ProjectList refreshSignal={refreshSignal} />
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    maxWidth: 760, width: '100%', margin: '0 auto',
    padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 48,
  },
  section: { display: 'flex', flexDirection: 'column', gap: 20 },
  sectionTitle: { fontSize: 20, fontWeight: 700, color: '#e0e0f0' },
}
