/** Serialize any caught value into a readable string (avoiding [object Object]).
 * Tauri invoke errors are `{ ok: false, error: string }` serialized objects;
 * String(e) alone only yields "[object Object]" (historical pitfall: hubStore stop button).
 * All stores / views take it from here uniformly rather than duplicating it. */
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
