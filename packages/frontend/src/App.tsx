import { useState } from 'react'
import { UploadZone } from './components/UploadZone'
import { UploadProgress } from './components/UploadProgress'
import { AnalysisModeSelector } from './components/AnalysisModeSelector'
import { ProjectList } from './components/ProjectList'
import { useUpload } from './hooks/useUpload'
import type { AnalysisParams } from './components/AnalysisModeSelector'

export function App() {
  const [analysisParams, setAnalysisParams] = useState<AnalysisParams>({ analysisMode: 'full' })
  const [refreshSignal, setRefreshSignal] = useState(0)
  const { state, startUpload, reset } = useUpload()

  async function handleFile(file: File) {
    await startUpload(file, analysisParams)
    setRefreshSignal((n) => n + 1)
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logo}>PWHL Clip Studio</span>
      </header>

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
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  header: {
    display: 'flex', alignItems: 'center',
    padding: '16px 32px', borderBottom: '1px solid #1a1a2e',
  },
  logo: { fontSize: 20, fontWeight: 800, color: '#6c63ff', letterSpacing: '-0.02em' },
  main: {
    maxWidth: 760, width: '100%', margin: '0 auto',
    padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 48,
  },
  section: { display: 'flex', flexDirection: 'column', gap: 20 },
  sectionTitle: { fontSize: 20, fontWeight: 700, color: '#e0e0f0' },
}
