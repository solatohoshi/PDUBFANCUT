import { lazy, Suspense } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ErrorBoundary } from './components/ErrorBoundary'

// Code-split the heavier routes so the landing page loads without the
// clip-review and editor bundles
const ProjectPage = lazy(() =>
  import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage })))
const EditorPage = lazy(() =>
  import('./pages/EditorPage').then((m) => ({ default: m.EditorPage })))

function RouteFallback() {
  return <div style={styles.fallback}>Loading…</div>
}

export function App() {
  const navigate = useNavigate()

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logo} onClick={() => navigate('/')}>
          PWHL Clip Studio
        </span>
      </header>

      <ErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/editor" element={<EditorPage />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { display: 'flex', flexDirection: 'column', minHeight: '100vh' },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '16px 32px', borderBottom: '1px solid #1a1a2e',
  },
  logo: {
    fontSize: 20, fontWeight: 800, color: '#6c63ff',
    letterSpacing: '-0.02em', cursor: 'pointer',
  },
  fallback: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '80px 24px', fontSize: 14, color: '#6060a0',
  },
}
