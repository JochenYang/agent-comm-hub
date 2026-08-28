import { useEffect, useRef } from 'react'
import { useTranslation } from '@/i18n'
import { usePeersStore } from '@/stores/peersStore'
import { pushToast } from '@/stores/toastStore'
import { ToastViewport } from '@/components/ui/toast'

/**
 * 上下线提示桥：订阅 peersStore 的 activity 迁移序列 → toast（自动消失）。
 * seq 单调递增，重渲染/重挂载只消费新事件，不重复弹旧提示。
 */
export function PeerActivityToasts(): React.JSX.Element {
  const { t } = useTranslation()
  const lastSeq = useRef(0)

  useEffect(() => {
    // t 随语言切换变化，订阅回调里实时取；zustand subscribe 返回退订函数。
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
