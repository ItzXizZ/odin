import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { captureReferralFromUrl } from './lib/referral'
import 'katex/dist/katex.min.css'
import './index.css'

// Capture ?ref= before React mounts so it survives OAuth redirects.
captureReferralFromUrl()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
