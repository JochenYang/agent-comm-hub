import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// tailwind.css already merges :root vars + @layer base overrides (merged into one file to avoid PostCSS cross-file layer errors).
// The earlier standalone theme.css is kept for archival only and is no longer imported.
import './styles/tailwind.css'
import { initI18n } from './i18n'

// Must init i18next before first render, otherwise useTranslation ready=false triggers a fallback warning.
initI18n()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)