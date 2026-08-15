import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// tailwind.css 已合并 :root vars + @layer base overrides（合并到同一文件避免 PostCSS 跨文件 layer 报错）。
// 早期独立的 theme.css 保留作归档，不再 import。
import './styles/tailwind.css'
import { initI18n } from './i18n'

// M3 T-3.6: 必须在首次 render 前初始化 i18next,否则 useTranslation ready=false 会出 fallback warning。
initI18n()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)