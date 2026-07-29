// Windowed channel history facade over caller-owned pending-history maps.
import {
  buildChannelInboundHistory,
  buildChannelPendingHistoryContext,
  clearChannelHistoryIfEnabled,
  recordChannelHistoryEntryIfEnabled,
  recordChannelHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";

type MaybePromise<T> = T | Promise<T>;

/** Windowed channel history facade used by turn adapters to record and render recent context. */
export type ChannelHistoryWindow<T extends HistoryEntry = HistoryEntry> = {
  record: (params: { historyKey: string; entry?: T | null; limit: number }) => T[];
  recordWithMedia: (params: {
    historyKey: string;
    entry?: T | null;
    limit: number;
    media?:
      | readonly HistoryMediaEntry[]
      | null
      | (() => MaybePromise<readonly HistoryMediaEntry[] | null | undefined>);
    mediaLimit?: number;
    messageId?: string;
    shouldRecord?: () => boolean;
  }) => Promise<T[]>;
  buildPendingContext: (params: {
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: T) => string;
    lineBreak?: string;
  }) => string;
  buildInboundHistory: (params: {
    historyKey: string;
    limit: number;
  }) => HistoryEntry[] | undefined;
  clear: (params: { historyKey: string; limit: number }) => void;
};

/** Creates a bounded channel history window over a caller-owned history map. */
export function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
}): ChannelHistoryWindow<T> {
  const { historyMap } = params;
  return {
    record: (recordParams) =>
      recordChannelHistoryEntryIfEnabled({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
      }),
    recordWithMedia: (recordParams) =>
      recordChannelHistoryEntryWithMedia({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
        media: recordParams.media,
        mediaLimit: recordParams.mediaLimit,
        messageId: recordParams.messageId,
        shouldRecord: recordParams.shouldRecord,
      }),
    buildPendingContext: (contextParams) =>
      buildChannelPendingHistoryContext({
        historyMap,
        historyKey: contextParams.historyKey,
        limit: contextParams.limit,
        currentMessage: contextParams.currentMessage,
        formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string,
        lineBreak: contextParams.lineBreak,
      }),
    buildInboundHistory: (historyParams) =>
      buildChannelInboundHistory({
        historyMap,
        historyKey: historyParams.historyKey,
        limit: historyParams.limit,
      }),
    clear: (clearParams) =>
      clearChannelHistoryIfEnabled({
        historyMap,
        historyKey: clearParams.historyKey,
        limit: clearParams.limit,
      }),
  };
}
