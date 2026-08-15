/** 把任意 catch 到的值序列化成可读字符串（避免 [object Object]）。
 * Tauri invoke 的错误是 `{ ok: false, error: string }` 序列化对象；
 * 直接 String(e) 只会得到 "[object Object]"（历史踩坑：hubStore 停止按钮）。
 * 各 store / 视图统一从这里取，不再各自复制。 */
export function serializeError(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (typeof e === 'object' && e !== null) {
    const obj = e as Record<string, unknown>
    if (typeof obj.error === 'string') return obj.error
    if (typeof obj.message === 'string') return obj.message
    try {
      return JSON.stringify(e)
    } catch (_err) {
      return String(e)
    }
  }
  return String(e)
}
