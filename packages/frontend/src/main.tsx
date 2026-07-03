import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ClerkProvider } from '@clerk/clerk-react'
import { App } from './App'

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

const root = createRoot(document.getElementById('root')!)

if (!publishableKey) {
  root.render(
    <div style={{ padding: 48, fontFamily: 'monospace', color: '#f05060', background: '#0a0a18', minHeight: '100vh' }}>
      <h2 style={{ color: '#6c63ff' }}>Auth not configured</h2>
      <p>Add your Clerk publishable key to <code>packages/frontend/.env</code>:</p>
      <pre style={{ background: '#111128', padding: 16, borderRadius: 8, color: '#c0c0e0' }}>
        VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
      </pre>
      <p>Get your key at <strong>clerk.com</strong> → Your Application → API Keys</p>
    </div>
  )
} else {
  root.render(
    <StrictMode>
      <ClerkProvider publishableKey={publishableKey}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ClerkProvider>
    </StrictMode>
  )
}
