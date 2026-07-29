/**
 * Runtime seams used by subagent registry code for plugin/context-engine initialization.
 */
export { ensureContextEnginesInitialized } from "../context-engine/init.js";
export { resolveContextEngine } from "../context-engine/registry.js";
export { ensureRuntimePluginsLoaded } from "./runtime-plugins.js";
