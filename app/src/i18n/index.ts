// i18n: Chinese (zh-CN) default, English (en-US) fallback;
// persists the user's language choice via localStorage 'lang' (default zh-CN);
// backend error messages are always English (matching stderr), not routed through frontend i18n.
//
// Usage:
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
      interpolation: { escapeValue: false }, // React already escapes
      returnNull: false
    })
}

/**
 * Wraps react-i18next's useTranslation with lang / setLang helpers.
 * setLang in a component immediately writes localStorage + switches the i18next language → triggers re-render.
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
