/**
 * Synchronous keyed plugin-state store factory.
 *
 * Separate from `plugin-state-runtime`, which stays type-only plus light
 * helpers because hot channel entrypoints import it at module load; opening a
 * store pulls the state-database graph, so only callers that actually read or
 * write state take that cost.
 */

export { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
