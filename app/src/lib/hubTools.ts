/**
 * The hub tools this app calls, in one place.
 *
 * Why this file exists: the tool names used to be string literals scattered
 * through `lib/tauri.ts`, and the app mirrors the hub's protocol by hand (it must
 * not import from the main repo — workspace isolation). That combination has
 * already produced real drift in this codebase: the status enums fell behind
 * `input-required` / `canceled`, and two tools the hub grew had no desktop
 * plumbing at all. A typo or a rename on either side shows up as a runtime
 * "unknown tool" on the one code path that needed it, and nowhere else.
 *
 * So the names live here, and `missingTools` turns a drift into something the app
 * can say out loud at startup instead of discovering it mid-conversation.
 */

/** Names as the hub spells them. */
export const HUB_TOOLS = {
  register: 'bridge_register',
  unregister: 'bridge_unregister',
  rename: 'bridge_rename',
  chat: 'bridge_chat',
  status: 'bridge_status',
  peers: 'bridge_peers',
  wait: 'bridge_wait',
  history: 'bridge_history',
  task: 'bridge_task',
  ack: 'bridge_ack',
  tasks: 'bridge_tasks',
  taskStatus: 'bridge_task_status',
  taskCancel: 'bridge_task_cancel',
  taskInput: 'bridge_task_input'
} as const

/**
 * Every hub tool this app calls. Kept as an explicit list (rather than derived
 * from HUB_TOOLS) so that adding a constant without wiring it, or wiring a name
 * that no longer exists, is visible here rather than implicit.
 */
export const REQUIRED_HUB_TOOLS: readonly string[] = [
  HUB_TOOLS.register,
  HUB_TOOLS.unregister,
  HUB_TOOLS.rename,
  HUB_TOOLS.chat,
  HUB_TOOLS.status,
  HUB_TOOLS.peers,
  HUB_TOOLS.wait,
  HUB_TOOLS.history,
  HUB_TOOLS.task,
  HUB_TOOLS.ack,
  HUB_TOOLS.tasks,
  HUB_TOOLS.taskStatus,
  HUB_TOOLS.taskCancel,
  HUB_TOOLS.taskInput
]

/**
 * Names in `expected` that `advertised` does not contain.
 *
 * Pure and order-independent, so the comparison can be exercised without a hub.
 * An empty result means the app and the hub agree on every tool it uses.
 */
export function missingTools(advertised: readonly string[], expected: readonly string[] = REQUIRED_HUB_TOOLS): string[] {
  const have = new Set(advertised)
  return expected.filter((name) => !have.has(name))
}

/**
 * Tools the hub advertises that this app does not call. Informational: the app
 * not using a tool is not a fault, but the list is what tells a maintainer that
 * the hub grew something worth wiring.
 */
export function unusedTools(advertised: readonly string[], expected: readonly string[] = REQUIRED_HUB_TOOLS): string[] {
  const known = new Set(expected)
  return advertised.filter((name) => !known.has(name))
}
