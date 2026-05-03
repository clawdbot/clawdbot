/**
 * @deprecated Compatibility facade for older third-party channel packages that
 * imported the previous Mattermost-shaped helper bundle. New plugins should
 * import the generic SDK subpaths directly.
 */
export { resolveControlCommandGate } from "./command-auth.js";
export { formatPairingApproveHint } from "./channel-plugin-common.js";
export type { HistoryEntry } from "./reply-history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "./reply-history.js";
