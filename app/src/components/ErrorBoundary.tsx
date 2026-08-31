import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** Explanation text for the fallback UI (default "view crashed"). */
  label?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * View-level error boundary: when a single view crashes, show a fallback instead of letting
 * React unmount the whole component tree (previously a `peers.length` crash in PeersView
 * would blank the entire app). Retrying anywhere after a crash remounts the subtree.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-destructive">
          {this.props.label ?? 'view crashed'}
        </div>
        <div className="max-w-full truncate font-mono text-[11px] text-muted-foreground">
          {this.state.error.message}
        </div>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:border-foreground/40"
        >
          retry
        </button>
      </div>
    )
  }
}
