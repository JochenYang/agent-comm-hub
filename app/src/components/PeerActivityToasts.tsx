import { useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n'
import { usePeersStore } from '@/stores/peersStore'
import { pushToast } from '@/stores/toastStore'
import { ToastViewport } from '@/components/ui/toast'

/**
 * Online/offline toast bridge: subscribes to the peersStore activity transition sequence → toast (auto-dismiss).
 * seq is monotonic, so a re-render / remount only consumes new events without replaying old notices.
 */
export function PeerActivityToasts(): React.JSX.Element {
  const { t } = useTranslation()
  const lastSeq = useRef(0)

  useEffect(() => {
    // t changes with language switches, so read it live in the subscription callback; zustand subscribe returns an unsubscribe function.
    const unsub = usePeersStore.subscribe((s) => {
      for (const ev of s.activity) {
        if (ev.seq <= lastSeq.current) continue
        lastSeq.current = ev.seq
        const name = s.peers.find((p) => p.id === ev.peerId)?.alias ?? ev.peerId
        pushToast(
          ev.online ? 'success' : 'info',
          ev.online ? t('peers.joined_toast', { name }) : t('peers.left_toast', { name })
        )
      }
    })
    return unsub
  }, [t])

  return <ToastViewport />
}
