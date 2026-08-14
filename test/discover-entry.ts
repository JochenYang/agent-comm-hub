/**
 * Standalone test entry: re-exports the discovery engine for the discover test.
 */
export {
  loadRegistry,
  validateRegistry,
  discover,
  runDiscover,
  expandHome,
  expandConfigFile,
  registryFile,
  type Registry,
  type RegistryEntry,
  type DiscoveredAgent,
  type DiscoverOptions,
} from '../src/discover.js'
