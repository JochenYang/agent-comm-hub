/**
 * Test entry for the herdr control layer: re-exports the hub core so
 * herdr.mjs can drive the real wiring (startHub → server + registry +
 * tools + herdr adapter) against the fake herdr CLI fixture.
 */
export { startHub, hubTools, HerdrCtl } from '../src/index.js'
