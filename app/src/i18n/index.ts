// i18n: 中文 (zh-CN) 默认, 英文 (en-US) 备选;
// 通过 localStorage 'lang' 持久化用户的语言选择 (默认 zh-CN);
// 后端错误信息一律给 en (跟 stderr 一致), 不走前端 i18n。
//
// 用法:
//   import { useTranslation } from '@/i18n'
//   const { t, lang, setLang } = useTranslation()
//   <span>{t('common.peers')}</span>

import { useCallback, useEffect, useState } from 'react'
import i18next, { type Resource } from 'i18next'
import { initReactI18next, useTranslation as useI18nextTranslation } from 'react-i18next'
import zhCN from './zh-CN.json' with { type: 'json' }
import enUS from './en-US.json' with { type: 'json' }

export const SUPPORTED_LANGS = ['zh-CN', 'en-US'] as const
export type Lang = (typeof SUPPORTED_LANGS)[number]
export const DEFAULT_LANG: Lang = 'zh-CN'

const STORAGE_KEY = 'ach-app-lang'

function isLang(s: string | null): s is Lang {
  return s !== null && (SUPPORTED_LANGS as readonly string[]).includes(s)
}

function detectInitialLang(): Lang {
  if (typeof window === 'undefined') return DEFAULT_LANG
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isLang(stored)) return stored
  const navLang = window.navigator.language
  if (navLang.toLowerCase().startsWith('en')) return 'en-US'
  return DEFAULT_LANG
}

const resources: Resource = {
  'zh-CN': { translation: zhCN },
  'en-US': { translation: enUS }
}

let initialized = false

export function initI18n(): void {
  if (initialized) return
  initialized = true
  void i18next
    .use(initReactI18next)
    .init({
      resources,
      lng: detectInitialLang(),
      fallbackLng: DEFAULT_LANG,
      interpolation: { escapeValue: false }, // React 已经 escape
      returnNull: false
    })
}

/**
 * 包装 react-i18next 的 useTranslation,附带 lang / setLang 助手。
 * 组件里 setLang 会立刻写 localStorage + 切 i18next 语言 → 触发重渲染。
 */
export function useTranslation(): {
  t: (key: string, options?: Record<string, unknown>) => string
  lang: Lang
  setLang: (next: Lang) => void
  ready: boolean
} {
  const inner = useI18nextTranslation()
  const [lang, setLangState] = useState<Lang>(inner.i18n.language as Lang)

  useEffect(() => {
    const onLangChange = (next: string): void => {
      if (isLang(next)) setLangState(next)
    }
    inner.i18n.on('languageChanged', onLangChange)
    return () => {
      inner.i18n.off('languageChanged', onLangChange)
    }
  }, [inner.i18n])

  const setLang = useCallback((next: Lang): void => {
    void inner.i18n.changeLanguage(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [inner.i18n])

  return { t: inner.t, lang, setLang, ready: inner.ready }
}
