import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const el = document.getElementById('root')
if (el === null) throw new Error('#root missing')
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
