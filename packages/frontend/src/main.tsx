import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'

// Wipe stale tus fingerprints from IndexedDB so the upload hook never tries
// to resume from a dead server-side upload URL.
try { indexedDB.deleteDatabase('tus-uploads') } catch {}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
