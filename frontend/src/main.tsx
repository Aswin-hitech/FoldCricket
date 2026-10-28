import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'
import { initSessionCleaner } from './utils/sessionCleaner'

// Enforce 1-hour session TTL & clean residual activity on load
initSessionCleaner()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
