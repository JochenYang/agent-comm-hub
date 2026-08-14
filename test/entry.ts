/**
 * Standalone test entry: re-exports the hub core so the smoke test can drive
 * the real wiring (startHub → server + registry + tools) without any
 * external dependencies.
 */
export { startHub, AgentHub, McpStreamableHttpServer, SessionRegistry, hubTools } from '../src/index.js'
