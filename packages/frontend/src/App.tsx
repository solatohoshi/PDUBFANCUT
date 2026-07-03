import { useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { SignedIn, SignedOut, RedirectToSignIn, UserButton, useAuth } from '@clerk/clerk-react'
import { HomePage } from './pages/HomePage'
import { ProjectPage } from './pages/ProjectPage'
import { EditorPage } from './pages/EditorPage'
import { setAuthToken } from './lib/api'

function TokenSync() {
  const { getToken, isSignedIn } = useAuth()
  useEffect(() => {
    if (!isSignedIn) { setAuthToken(null); return }
    const refresh = async () => setAuthToken(await getToken())
    refresh()
    const id = setInterval(refresh, 55_000)
    return () => clearInterval(id)
  }, [isSignedIn, getToken])
  return null
}

export function App() {
  const navigate = useNavigate()

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <span style={styles.logo} onClick={() => navigate('/')}>
          PWHL Clip Studio
        </span>
        <div style={styles.headerRight}>
          <UserButton afterSignOutUrl="/" />
        </div>
      </header>

      <SignedIn>
        <TokenSync />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:id/editor" element={<EditorPage />} />
        </Routes>
      </SignedIn>

      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
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
  headerRight: { display: 'flex', alignItems: 'center' },
}
