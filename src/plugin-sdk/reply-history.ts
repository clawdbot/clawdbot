/**
 * Shared reply-history helpers for plugins that keep short per-thread context windows.
 *
 * Prefer `createChannelHistoryWindow` for message-turn code. The lower-level map helpers are
 * deprecated plugin compatibility exports; core internals still use them behind the facade.
 */
export type { HistoryEntry, HistoryMediaEntry } from "../auto-reply/reply/history.types.js";
export {
  createChannelHistoryWindow,
  type ChannelHistoryWindow,
} from "../channels/turn/history-window.js";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  HISTORY_CONTEXT_MARKER,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  buildHistoryContextFromMap,
  buildInboundHistoryFromEntries,
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
  clearHistoryEntriesIfEnabled,
  evictOldHistoryKeys,
  normalizeHistoryMediaEntries,
  recordPendingHistoryEntry,
  recordPendingHistoryEntryWithMedia,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
