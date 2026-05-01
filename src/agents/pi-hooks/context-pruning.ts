/**
 * Opt-in context pruning (“microcompact”-style) for Pi sessions.
 *
 * This only affects the in-memory context for the current request; it does not rewrite session
 * history persisted on disk.
 */

export { default } from "./context-pruning/extension.js";

export { pruneContextMessages } from "./context-pruning/pruner.js";
export {
  computeEffectiveSettings,
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
} from "./context-pruning/settings.js";
