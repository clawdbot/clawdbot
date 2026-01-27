import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

export const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

/** Maximum number of group history keys to retain (LRU eviction when exceeded). */
export const MAX_HISTORY_KEYS = 1000;

/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
export function evictOldHistoryKeys<T>(
  historyMap: Map<string, T[]>,
  maxKeys: number = MAX_HISTORY_KEYS,
): void {
  if (historyMap.size <= maxKeys) return;
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== undefined) historyMap.delete(key);
  }
}

export type HistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

export function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string {
  const { historyText, currentMessage } = params;
  const lineBreak = params.lineBreak ?? "\n";
  if (!historyText.trim()) return currentMessage;
  return [HISTORY_CONTEXT_MARKER, historyText, "", CURRENT_MESSAGE_MARKER, currentMessage].join(
    lineBreak,
  );
}

export function appendHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
}): T[] {
  const { historyMap, historyKey, entry } = params;
  if (params.limit <= 0) return [];
  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  while (history.length > params.limit) history.shift();
  if (historyMap.has(historyKey)) {
    // Refresh insertion order so eviction keeps recently used histories.
    historyMap.delete(historyKey);
  }
  historyMap.set(historyKey, history);
  // Evict oldest keys if map exceeds max size to prevent unbounded memory growth
  evictOldHistoryKeys(historyMap);
  return history;
}

export function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
}): T[] {
  return appendHistoryEntry(params);
}

export function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
}): T[] {
  if (!params.entry) return [];
  if (params.limit <= 0) return [];
  return recordPendingHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.limit,
  });
}

export function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.limit <= 0) return params.currentMessage;
  const entries = params.historyMap.get(params.historyKey) ?? [];
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: false,
  });
}

export function buildHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  entry?: HistoryEntry;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  if (params.limit <= 0) return params.currentMessage;
  const entries = params.entry
    ? appendHistoryEntry({
        historyMap: params.historyMap,
        historyKey: params.historyKey,
        entry: params.entry,
        limit: params.limit,
      })
    : (params.historyMap.get(params.historyKey) ?? []);
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: params.excludeLast,
  });
}

export function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void {
  params.historyMap.set(params.historyKey, []);
}

export function clearHistoryEntriesIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) return;
  clearHistoryEntries({ historyMap: params.historyMap, historyKey: params.historyKey });
}

export function buildHistoryContextFromEntries(params: {
  entries: HistoryEntry[];
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
  excludeLast?: boolean;
}): string {
  const lineBreak = params.lineBreak ?? "\n";
  const entries = params.excludeLast === false ? params.entries : params.entries.slice(0, -1);
  if (entries.length === 0) return params.currentMessage;
  const historyText = entries.map(params.formatEntry).join(lineBreak);
  return buildHistoryContext({
    historyText,
    currentMessage: params.currentMessage,
    lineBreak,
  });
}
