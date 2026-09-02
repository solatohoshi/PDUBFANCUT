import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider, SignIn, UserButton, useAuth } from '@clerk/clerk-react'
import { App } from './App'
import { setAuthTokenProvider } from './lib/api'

// Wipe stale tus fingerprints from IndexedDB so the upload hook never tries
// to resume from a dead server-side upload URL.
try { indexedDB.deleteDatabase('tus-uploads') } catch {}

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
const devBypass = import.meta.env.VITE_DEV_BYPASS_AUTH === 'true'

function AuthenticatedRoot() {
  const { isLoaded, userId, getToken } = useAuth()
  const [apiReady, setApiReady] = useState(false)

  useEffect(() => {
    if (!isLoaded || !userId) {
      setAuthTokenProvider(null)
      setApiReady(false)
      return
    }
    setAuthTokenProvider(() => getToken())
    setApiReady(true)
    return () => setAuthTokenProvider(null)
  }, [isLoaded, userId, getToken])

  if (!isLoaded) return <GateMessage>Loading session…</GateMessage>
  if (!userId) {
    return (
      <div style={gateStyles.page}>
        <div style={gateStyles.brand}>PWHL Clip Studio</div>
        <SignIn routing="hash" />
      </div>
    )
  }
  if (!apiReady) return <GateMessage>Preparing your workspace…</GateMessage>

  return <App accountControl={<UserButton afterSignOutUrl="/" />} />
}

function GateMessage({ children }: { children: string }) {
  return <div style={gateStyles.page}><div style={gateStyles.message}>{children}</div></div>
}

const gateStyles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 24,
    alignItems: 'center', justifyContent: 'center', background: '#090916', color: '#d8d8f0',
  },
  brand: { color: '#8a83ff', fontSize: 24, fontWeight: 800 },
  message: { color: '#9090b0', fontSize: 14 },
}

const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <BrowserRouter>
      {devBypass ? (
        <App />
      ) : clerkKey ? (
        <ClerkProvider publishableKey={clerkKey}>
          <AuthenticatedRoot />
        </ClerkProvider>
      ) : (
        <GateMessage>VITE_CLERK_PUBLISHABLE_KEY is not configured.</GateMessage>
      )}
    </BrowserRouter>
  </StrictMode>,
)
