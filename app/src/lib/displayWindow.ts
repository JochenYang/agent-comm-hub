/**
 * Display window: how much of the message pool a view actually shows.
 *
 * Why this exists: the pool is deliberately unfiltered (see messagesStore — the
 * "switch conversations and the message is gone" bug), so every view renders
 * whatever the hub's history ring holds. On a busy hub that is a wall of
 * yesterday's traffic. These settings cut it down at the PROJECTION layer, which
 * is the only place it can be done without losing messages that a later view
 * change would need.
 *
 * Kept pure and dependency-free so the arithmetic can be tested on its own: the
 * interesting bugs here are off-by-one on the cap and a time window that is
 * exclusive when it should be inclusive, not React wiring.
 */

/** The user's choice. Both `0` values mean "no limit" — the defaults, so an
 *  install that never opens the settings panel behaves exactly as before. */
export interface DisplayWindow {
  /** Show only messages newer than this many hours. 0 = no time limit. */
  hours: number
  /** Show at most this many of the newest messages. 0 = no cap. */
  maxMessages: number
}

export const DEFAULT_DISPLAY_WINDOW: DisplayWindow = { hours: 0, maxMessages: 0 }

/** Clamp anything that came from settings storage into a usable window. Values
 *  arrive as strings from the config table and can be negative, NaN or absent;
 *  a broken value must fall back to "no limit", never to "hide everything". */
export function normalizeDisplayWindow(hours: unknown, maxMessages: unknown): DisplayWindow {
  const parse = (raw: unknown): number => {
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return { hours: parse(hours), maxMessages: parse(maxMessages) }
}

/**
 * Apply the window to a list of timestamped messages, returning the newest
 * slice. The input is not mutated and its order is preserved.
 *
 * - the time cut is INCLUSIVE at the boundary (`ts === now - hours` is kept):
 *   a message exactly N hours old is "within the last N hours".
 * - the cap keeps the NEWEST `maxMessages`, so the result is the tail of the
 *   window in the order it arrived.
 */
export function applyDisplayWindow<T extends { ts: number }>(
  messages: readonly T[],
  window: DisplayWindow,
  now: number,
): T[] {
  let out = messages as readonly T[]
  if (window.hours > 0) {
    const cutoff = now - window.hours * 3_600_000
    out = out.filter((m) => m.ts >= cutoff)
  }
  if (window.maxMessages > 0 && out.length > window.maxMessages) {
    out = out.slice(out.length - window.maxMessages)
  }
  return out as T[]
}

/** Whether a single message is inside the window — the same rule as
 *  {@link applyDisplayWindow}, for callers that count rather than slice (the
 *  unread badge must use this, or it badges messages the view does not show). */
export function withinDisplayWindow(ts: number, window: DisplayWindow, now: number): boolean {
  if (window.hours <= 0) return true
  return ts >= now - window.hours * 3_600_000
}
