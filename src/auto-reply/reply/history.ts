import type { HistoryEntry, HistoryMediaEntry } from "./history.types.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

export const HISTORY_CONTEXT_MARKER = "[Chat messages since your last reply - for context]";
export const DEFAULT_GROUP_HISTORY_LIMIT = 50;

/** Maximum number of group history keys to retain (LRU eviction when exceeded). */
const MAX_HISTORY_KEYS = 1000;

/**
 * Evict oldest keys from a history map when it exceeds MAX_HISTORY_KEYS.
 * Uses Map's insertion order for LRU-like behavior.
 */
export function evictOldHistoryKeys<T>(
  historyMap: Map<string, T[]>,
  maxKeys: number = MAX_HISTORY_KEYS,
): void {
  if (historyMap.size <= maxKeys) {
    return;
  }
  const keysToDelete = historyMap.size - maxKeys;
  const iterator = historyMap.keys();
  for (let i = 0; i < keysToDelete; i++) {
    const key = iterator.next().value;
    if (key !== undefined) {
      historyMap.delete(key);
    }
  }
}

export type { HistoryEntry, HistoryMediaEntry } from "./history.types.js";

export function buildHistoryContext(params: {
  historyText: string;
  currentMessage: string;
  lineBreak?: string;
}): string {
  const { historyText, currentMessage } = params;
  const lineBreak = params.lineBreak ?? "\n";
  if (!historyText.trim()) {
    return currentMessage;
  }
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
  if (params.limit <= 0) {
    return [];
  }
  const history = historyMap.get(historyKey) ?? [];
  history.push(entry);
  const overflowCount = history.length - params.limit;
  if (overflowCount > 0) {
    history.splice(0, overflowCount);
  }
  if (historyMap.has(historyKey)) {
    // Refresh insertion order so eviction keeps recently used histories.
    historyMap.delete(historyKey);
  }
  historyMap.set(historyKey, history);
  // Evict oldest keys if map exceeds max size to prevent unbounded memory growth
  evictOldHistoryKeys(historyMap);
  return history;
}

/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export function recordPendingHistoryEntry<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry: T;
  limit: number;
}): T[] {
  return appendHistoryEntry(params);
}

/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).record(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export function recordPendingHistoryEntryIfEnabled<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  entry?: T | null;
  limit: number;
}): T[] {
  if (!params.entry) {
    return [];
  }
  if (params.limit <= 0) {
    return [];
  }
  return recordPendingHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry: params.entry,
    limit: params.limit,
  });
}

type MaybePromise<T> = T | Promise<T>;

const DEFAULT_HISTORY_MEDIA_LIMIT = 4;

function isLocalHistoryMediaPath(path: string): boolean {
  if (/^[a-z]:[\\/]/i.test(path)) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

function isImageHistoryMediaEntry(entry: HistoryMediaEntry): boolean {
  const contentType = entry.contentType?.split(";")[0]?.trim().toLowerCase();
  return entry.kind === "image" || contentType?.startsWith("image/") === true;
}

export function normalizeHistoryMediaEntries(params: {
  media?: readonly HistoryMediaEntry[] | null;
  limit?: number;
  messageId?: string;
}): HistoryMediaEntry[] {
  const limit = Math.max(0, params.limit ?? DEFAULT_HISTORY_MEDIA_LIMIT);
  if (limit <= 0 || !params.media?.length) {
    return [];
  }
  const out: HistoryMediaEntry[] = [];
  const seen = new Set<string>();
  for (const entry of params.media) {
    if (!isImageHistoryMediaEntry(entry)) {
      continue;
    }
    const path = entry.path?.trim();
    if (!path || !isLocalHistoryMediaPath(path)) {
      continue;
    }
    const dedupeKey = `${entry.messageId ?? params.messageId ?? ""}\0${path}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    out.push({
      path,
      contentType: entry.contentType,
      kind: "image",
      messageId: entry.messageId ?? params.messageId,
    });
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).recordWithMedia(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
export async function recordPendingHistoryEntryWithMedia<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
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
}): Promise<T[]> {
  if (!params.entry || params.limit <= 0) {
    return [];
  }
  if (params.shouldRecord && !params.shouldRecord()) {
    return [];
  }
  if (typeof params.media === "function") {
    const recordedEntry = params.entry;
    const history = recordPendingHistoryEntry({
      historyMap: params.historyMap,
      historyKey: params.historyKey,
      entry: recordedEntry,
      limit: params.limit,
    });
    const resolvedMedia = await params.media();
    if (params.shouldRecord && !params.shouldRecord()) {
      return history;
    }
    const media = normalizeHistoryMediaEntries({
      media: resolvedMedia,
      limit: params.mediaLimit,
      messageId: params.messageId ?? params.entry.messageId,
    });
    if (media.length === 0) {
      return history;
    }
    const currentHistory = params.historyMap.get(params.historyKey);
    const entryIndex = currentHistory?.indexOf(recordedEntry) ?? -1;
    if (currentHistory && entryIndex >= 0) {
      currentHistory[entryIndex] = { ...recordedEntry, media } as T;
    }
    return history;
  }
  const resolvedMedia = params.media ?? undefined;
  if (params.shouldRecord && !params.shouldRecord()) {
    return [];
  }
  const media = normalizeHistoryMediaEntries({
    media: resolvedMedia,
    limit: params.mediaLimit,
    messageId: params.messageId ?? params.entry.messageId,
  });
  const entry = media.length > 0 ? ({ ...params.entry, media } as T) : params.entry;
  return recordPendingHistoryEntry({
    historyMap: params.historyMap,
    historyKey: params.historyKey,
    entry,
    limit: params.limit,
  });
}

/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).buildPendingContext(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
export function buildPendingHistoryContextFromMap(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
  currentMessage: string;
  formatEntry: (entry: HistoryEntry) => string;
  lineBreak?: string;
}): string {
  if (params.limit <= 0) {
    return params.currentMessage;
  }
  const entries = params.historyMap.get(params.historyKey) ?? [];
  return buildHistoryContextFromEntries({
    entries,
    currentMessage: params.currentMessage,
    formatEntry: params.formatEntry,
    lineBreak: params.lineBreak,
    excludeLast: false,
  });
}

/**
 * @deprecated Plugin message-turn code should use
 * `createChannelHistoryWindow(...).buildInboundHistory(...)`. This helper remains
 * for core internals and older plugin compatibility.
 */
export function buildInboundHistoryFromMap<T extends HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  historyKey: string;
  limit: number;
}): HistoryEntry[] | undefined {
  return buildInboundHistoryFromEntries({
    entries: params.historyMap.get(params.historyKey) ?? [],
    limit: params.limit,
  });
}

export function buildInboundHistoryFromEntries(params: {
  entries: readonly HistoryEntry[];
  limit: number;
}): HistoryEntry[] | undefined {
  if (params.limit <= 0) {
    return undefined;
  }
  if (params.entries.length === 0) {
    return [];
  }
  return params.entries.slice(-params.limit).map((entry) => {
    const historyEntry: HistoryEntry = {
      sender: entry.sender,
      body: entry.body,
      timestamp: entry.timestamp,
    };
    if (entry.messageId) {
      historyEntry.messageId = entry.messageId;
    }
    if (entry.media && entry.media.length > 0) {
      historyEntry.media = entry.media;
    }
    return historyEntry;
  });
}

/**
 * @deprecated Prefer `buildHistoryContextFromEntries(...)` for existing entry
 * arrays, or `createChannelHistoryWindow(...)` when working from a history map.
 * This helper remains for older plugin compatibility.
 */
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
  if (params.limit <= 0) {
    return params.currentMessage;
  }
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

/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export function clearHistoryEntries(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
}): void {
  params.historyMap.set(params.historyKey, []);
}

/**
 * @deprecated Plugin message-turn code should use `createChannelHistoryWindow(...).clear(...)`.
 * This helper remains for core internals and older plugin compatibility.
 */
export function clearHistoryEntriesIfEnabled(params: {
  historyMap: Map<string, HistoryEntry[]>;
  historyKey: string;
  limit: number;
}): void {
  if (params.limit <= 0) {
    return;
  }
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
  if (entries.length === 0) {
    return params.currentMessage;
  }
  const historyText = entries.map(params.formatEntry).join(lineBreak);
  return buildHistoryContext({
    historyText,
    currentMessage: params.currentMessage,
    lineBreak,
  });
}
