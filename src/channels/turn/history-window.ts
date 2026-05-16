import {
  buildInboundHistoryFromMap,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  recordPendingHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";

type MaybePromise<T> = T | Promise<T>;

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

export function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
}): ChannelHistoryWindow<T> {
  const { historyMap } = params;
  return {
    record: (recordParams) =>
      recordPendingHistoryEntryIfEnabled({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
      }),
    recordWithMedia: (recordParams) =>
      recordPendingHistoryEntryWithMedia({
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
      buildPendingHistoryContextFromMap({
        historyMap,
        historyKey: contextParams.historyKey,
        limit: contextParams.limit,
        currentMessage: contextParams.currentMessage,
        formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string,
        lineBreak: contextParams.lineBreak,
      }),
    buildInboundHistory: (historyParams) =>
      buildInboundHistoryFromMap({
        historyMap,
        historyKey: historyParams.historyKey,
        limit: historyParams.limit,
      }),
    clear: (clearParams) =>
      clearHistoryEntriesIfEnabled({
        historyMap,
        historyKey: clearParams.historyKey,
        limit: clearParams.limit,
      }),
  };
}
