import { X } from 'lucide-react'
import { useToastStore, type ToastKind } from '@/stores/toastStore'

/** Toast stacked viewport at bottom-right: mount once at the App root (content comes from toastStore). */
const KIND_TONE: Record<ToastKind, string> = {
  info: 'border-info/40 bg-info/10 text-info',
  success: 'border-success/40 bg-success/10 text-success',
  error: 'border-destructive/40 bg-destructive/10 text-destructive'
}

export function ToastViewport(): React.JSX.Element {
  const { toasts, dismiss } = useToastStore()
  if (toasts.length === 0) return <div />
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-72 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-xs shadow-lg backdrop-blur ${KIND_TONE[t.kind]}`}
        >
          <span className="flex-1 break-words leading-5">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="dismiss"
            className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}
