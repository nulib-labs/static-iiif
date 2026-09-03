import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './theme.css'
import '@fontsource/google-sans/400.css'
import '@fontsource/google-sans/500.css'
import '@fontsource/google-sans/600.css'
import '@fontsource/google-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
import App from './App.jsx'
import AuthGate from './AuthGate.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme appearance="light" accentColor="iris" grayColor="mauve" scaling="110%">
      <BrowserRouter>
        <AuthGate>
          {({ signOut }) => (
            <Routes>
              <Route path="/works/:workId?" element={<App signOut={signOut} />} />
              <Route path="*" element={<Navigate to="/works" replace />} />
            </Routes>
          )}
        </AuthGate>
      </BrowserRouter>
    </Theme>
  </StrictMode>,
)
