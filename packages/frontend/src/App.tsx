import { Routes, Route, useNavigate } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { ProjectPage } from './pages/ProjectPage'
import { EditorPage } from './pages/EditorPage'
import { ErrorBoundary } from './components/ErrorBoundary'

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
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:id/editor" element={<EditorPage />} />
        </Routes>
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
}
