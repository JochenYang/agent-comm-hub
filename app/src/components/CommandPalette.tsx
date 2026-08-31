// Command palette: triggered by a `/` prefix in the input, or globally via Ctrl+K.
// Provides the /peers /broadcast /history /help /clear commands.
// Design style: mono / compact / devtool; locked 6px radius.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from '@/i18n'
import { tauri, type Peer } from '@/lib/tauri'

interface CommandPaletteProps {
  open: boolean
  initialQuery?: string
  peers: Peer[]
  onClose: () => void
  onExecute: (cmd: CommandResult) => void
}

export type CommandResult =
  | { kind: 'list_peers' }
  | { kind: 'broadcast'; text: string }
  | { kind: 'history'; limit?: number }
  | { kind: 'clear' }
  | { kind: 'help' }
  | { kind: 'noop' }

/**
 * Command palette renderer.
 * - open=false: renders no DOM (focus returns to the previous input)
 * - open=true: fullscreen fixed overlay + centered card + input + command suggestion list
 * - Esc closes, Enter executes the highlighted item or the current input
 */
export function CommandPalette({
  open,
  initialQuery,
  peers,
  onClose,
  onExecute
}: CommandPaletteProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [query, setQuery] = useState<string>(initialQuery ?? '')
  const [cursor, setCursor] = useState<number>(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // When open: focus + sync initialQuery
  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? '')
      setCursor(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open, initialQuery])

  const suggestions = useMemo<CommandSuggestion[]>(() => {
    const all: CommandSuggestion[] = [
      {
        cmd: 'peers',
        label: t('commands.help_peers'),
        build: () => ({ kind: 'list_peers' as const })
      },
      {
        cmd: 'broadcast',
        label: t('commands.help_broadcast'),
        build: (args) => ({
          kind: 'broadcast' as const,
          text: args.join(' ')
        })
      },
      {
        cmd: 'history',
        label: t('commands.help_history'),
        build: (args) => ({
          kind: 'history' as const,
          limit: args[0] !== undefined && args[0] !== '' ? Number(args[0]) : undefined
        })
      },
      {
        cmd: 'clear',
        label: t('commands.help_clear'),
        build: () => ({ kind: 'clear' as const })
      },
      {
        cmd: 'help',
        label: t('commands.help_help'),
        build: () => ({ kind: 'help' as const })
      }
    ]
    const q = query.trim().toLowerCase()
    if (q === '') return all
    // Supports both matching styles:
    //   "/peers codex" (autocomplete)     -> renders the list_peers suggestion
    //   "/broadcast hello"                -> renders the broadcast suggestion + treats "hello" as args
    if (q.startsWith('/')) {
      const stripped = q.slice(1)
      const spaceIdx = stripped.indexOf(' ')
      const cmdPart = spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx)
      const argsPart = spaceIdx === -1 ? '' : stripped.slice(spaceIdx + 1).trim()
      return all
        .filter((s) => s.cmd.startsWith(cmdPart))
        .map((s) => ({
          ...s,
          argsPreview: argsPart
        }))
    }
    return []
  }, [query, t])

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(0, suggestions.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      executeAt(cursor)
    }
  }

  const executeAt = (idx: number): void => {
    const sug = suggestions[idx]
    if (!sug) return
    let args: string[] = []
    if (sug.argsPreview !== undefined && sug.argsPreview !== '') {
      args = sug.argsPreview.split(/\s+/)
    }
    onExecute(sug.build(args))
    onClose()
  }

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/70 px-4 pt-[18vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-md border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {t('commands.palette_title')}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={handleKey}
          placeholder={t('commands.palette_placeholder')}
          className="w-full bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <ul className="max-h-64 overflow-auto border-t border-border px-1 py-1 font-mono text-xs">
          {suggestions.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">{t('commands.command_not_found')}</li>
          ) : (
            suggestions.map((s, i) => (
              <li key={s.cmd}>
                <button
                  type="button"
                  onClick={() => executeAt(i)}
                  onMouseEnter={() => setCursor(i)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors ${
                    cursor === i ? 'bg-primary/15 text-primary' : 'text-foreground/80 hover:bg-background/60'
                  }`}
                >
                  <span className="font-semibold">/{s.cmd}</span>
                  {s.argsPreview !== undefined && s.argsPreview !== '' && (
                    <span className="text-muted-foreground">{s.argsPreview}</span>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground">{s.label}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          ↑ ↓ navigate · ↵ run · esc close
        </div>
        {/* The peers list is not rendered directly in the panel (to avoid panel-content explosion), but props are exposed for future extension */}
        {peers.length === 0 ? null : <div data-peers-count={peers.length} hidden />}
      </div>
    </div>
  )
}

interface CommandSuggestion {
  cmd: string
  label: string
  argsPreview?: string
  build: (args: string[]) => CommandResult
}

/** Command help copy (embedded in README / About page) */
export const COMMAND_HELP_LINES = (t: (k: string) => string): string[] => [
  t('commands.help_intro'),
  t('commands.help_peers'),
  t('commands.help_broadcast'),
  t('commands.help_history'),
  t('commands.help_clear'),
  t('commands.help_help')
]

/**
 * Generic helper: parses a "/"-prefixed user input into a command; returns noop if it does not start with "/".
 * Lets MessagesView quickly decide before form submit.
 */
export async function tryExecuteServerSide(
  raw: string,
  onClear: () => void
): Promise<{ consumed: boolean }> {
  const q = raw.trim()
  if (!q.startsWith('/')) return { consumed: false }
  const stripped = q.slice(1)
  const spaceIdx = stripped.indexOf(' ')
  const cmd = (spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? '' : stripped.slice(spaceIdx + 1).trim()

  if (cmd === 'peers') {
    const result = await tauri.invoke.bridgePeers()
    console.info('[bridge_peers]', result?.peers ?? [])
  } else if (cmd === 'broadcast' && rest !== '') {
    // The backend has no broadcast bridge; the frontend loops calling bridge_chat to each online peer.
    const list = (await tauri.invoke.bridgePeers())?.peers ?? []
    const peers = list.filter((p) => p.connected)
    await Promise.all(
      peers.map((p) => tauri.invoke.bridgeChat(p.id, rest).catch(() => null))
    )
  } else if (cmd === 'history') {
    const limit = rest !== '' ? Number(rest) : undefined
    await tauri.invoke.bridgeHistory(undefined, limit ?? undefined)
  } else if (cmd === 'clear') {
    onClear()
  } else if (cmd === 'help') {
    console.info(COMMAND_HELP_LINES((k: string) => k).join('\n'))
  } else {
    return { consumed: false }
  }
  return { consumed: true }
}

// Re-export React.FormEvent for external form handling
export type { FormEvent }
