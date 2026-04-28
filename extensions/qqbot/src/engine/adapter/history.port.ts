/**
 * History port — abstracts the group history cache operations.
 *
 * The engine defines this interface; the bridge layer provides an
 * implementation backed by SDK `reply-history` functions. The engine's
 * built-in implementation in `group/history.ts` is used as the default
 * when no adapter is injected (standalone build).
 */

/** Minimal history entry shape expected by the port. */
export interface HistoryEntryLike {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
}

export interface HistoryPort {
  /**
   * Record a non-@ message into the pending history buffer.
   * No-op when `limit <= 0` or `entry` is missing.
   */
  recordPendingHistoryEntry<T extends HistoryEntryLike>(params: {
    historyMap: Map<string, T[]>;
    historyKey: string;
    entry?: T | null;
    limit: number;
  }): T[];

  /**
   * Build the full user-message string prefixed with buffered history.
   * Returns `currentMessage` unchanged when no history exists.
   */
  buildPendingHistoryContext(params: {
    historyMap: Map<string, HistoryEntryLike[]>;
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: HistoryEntryLike) => string;
    lineBreak?: string;
  }): string;

  /**
   * Clear a group's pending history buffer.
   * No-op when `limit <= 0`.
   */
  clearPendingHistory(params: {
    historyMap: Map<string, HistoryEntryLike[]>;
    historyKey: string;
    limit: number;
  }): void;
}
