import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Authenticator } from '@aws-amplify/ui-react'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Authenticator hideSignUp>
      {({ signOut }) => <App signOut={signOut} />}
    </Authenticator>
  </StrictMode>,
)
