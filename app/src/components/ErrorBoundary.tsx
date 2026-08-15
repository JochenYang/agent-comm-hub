import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** 降级 UI 的说明文案（默认 "view crashed"）。 */
  label?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 视图级错误边界：单个 view 崩溃时降级显示，而不是让 React 卸载整棵
 * 组件树（此前 PeersView 的 `peers.length` 崩溃会白屏整个应用）。
 * 崩溃后按任意处重试会重新挂载子树。
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
