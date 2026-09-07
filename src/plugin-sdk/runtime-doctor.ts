/**
 * @deprecated Package-only compatibility for pre-split official plugin doctor artifacts.
 * Current source must import `runtime-doctor-migrations` directly.
 */
export * from "./runtime-doctor-migrations.js";
/**
 * @deprecated Load-only bridge: published pre-split doctor artifacts
 * (voice-call/matrix 2026.7.2-beta.7 and earlier) import these repair names
 * from this subpath; without them the contract module fails to load and the
 * plugin's doctor migrations silently never run. Remove once managed releases
 * have replaced the old npm latest/extended-stable packages and their upgrade
 * window has closed. Current source imports `doctor-repair-runtime` (heavy)
 * and `plugin-state-store-runtime` directly.
 */
export * from "./doctor-repair-runtime.js";
export { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
