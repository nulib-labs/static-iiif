import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Authenticator } from '@aws-amplify/ui-react'
import './index.css'
import App from './App.jsx'

const isAws = import.meta.env.VITE_BACKEND === 'aws'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isAws ? (
      <Authenticator hideSignUp>
        {({ signOut }) => <App signOut={signOut} />}
      </Authenticator>
    ) : (
      <App />
    )}
  </StrictMode>,
)
