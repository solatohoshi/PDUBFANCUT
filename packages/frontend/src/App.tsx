import { useState } from 'react'
import { useAuth } from '@clerk/clerk-react'
import { UploadZone } from './components/UploadZone'
import { UploadProgress } from './components/UploadProgress'
import { AnalysisModeSelector } from './components/AnalysisModeSelector'
import { ProjectList } from './components/ProjectList'
import { useUpload } from './hooks/useUpload'
import type { AnalysisParams } from './components/AnalysisModeSelector'

export function App() {
  const { getToken, isLoaded, isSignedIn, signOut } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [analysisParams, setAnalysisParams] = useState<AnalysisParams>({ analysisMode: 'full' })
  const [refreshSignal, setRefreshSignal] = useState(0)

  // Fetch token once on mount / sign-in
  useState(() => {
    if (!isLoaded || !isSignedIn) return
    getToken().then(setToken)
  })

  const { state, startUpload, reset } = useUpload(token ?? '')

  async function handleFile(file: File) {
    const t = await getToken()
    setToken(t)
    if (!t) return
    await startUpload(file, analysisParams)
    setRefreshSignal((n) => n + 1)
  }

  if (!isLoaded) return <div style={styles.center}>Loading…</div>

  if (!isSignedIn) {
    return (
      <div style={styles.center}>
        <div style={styles.loginCard}>
          <h1 style={styles.logoText}>PWHL Clip Studio</h1>
          <p style={styles.tagline}>Find, trim, and export hockey moments — faster.</p>
          <a href="/sign-in" style={styles.signInBtn}>Sign in to get started</a>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logoText}>PWHL Clip Studio</span>
        <button style={styles.signOutBtn} onClick={() => signOut()}>Sign out</button>
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
          <h2 style={styles.sectionTitle}>Your projects</h2>
          <ProjectList token={token!} refreshSignal={refreshSignal} />
        </section>
      </main>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  center: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  loginCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    padding: '48px', background: '#111128', borderRadius: 16, border: '1px solid #2a2a3e',
  },
  logoText: { fontSize: 28, fontWeight: 800, color: '#6c63ff', letterSpacing: '-0.02em' },
  tagline: { fontSize: 15, color: '#7070a0' },
  signInBtn: {
    padding: '12px 28px', background: '#6c63ff', borderRadius: 8,
    color: '#fff', textDecoration: 'none', fontSize: 15, fontWeight: 600,
  },
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '16px 32px', borderBottom: '1px solid #1a1a2e',
  },
  signOutBtn: {
    padding: '6px 14px', background: 'transparent', border: '1px solid #2a2a3e',
    borderRadius: 6, color: '#7070a0', cursor: 'pointer', fontSize: 13,
  },
  main: { maxWidth: 760, width: '100%', margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 48 },
  section: { display: 'flex', flexDirection: 'column', gap: 20 },
  sectionTitle: { fontSize: 20, fontWeight: 700, color: '#e0e0f0' },
}
