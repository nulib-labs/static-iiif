import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Authenticator } from '@aws-amplify/ui-react'
import { Theme } from '@radix-ui/themes'
import '@radix-ui/themes/styles.css'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme appearance="light" accentColor="iris" grayColor="mauve">
      <Authenticator hideSignUp>
        {({ signOut }) => <App signOut={signOut} />}
      </Authenticator>
    </Theme>
  </StrictMode>,
)
