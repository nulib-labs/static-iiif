import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Authenticator } from '@aws-amplify/ui-react'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme appearance="light" accentColor="iris" grayColor="mauve">
      <BrowserRouter>
        <Authenticator hideSignUp>
          {({ signOut }) => (
            <Routes>
              <Route path="/" element={<Navigate to="/works" replace />} />
              <Route path="/:tab/:workId?" element={<App signOut={signOut} />} />
            </Routes>
          )}
        </Authenticator>
      </BrowserRouter>
    </Theme>
  </StrictMode>,
)
