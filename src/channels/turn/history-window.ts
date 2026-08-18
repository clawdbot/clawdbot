// Windowed channel history facade over caller-owned maps or host-owned SQLite state.
import {
  buildChannelInboundHistory,
  buildChannelPendingHistoryContext,
  buildHistoryContextFromEntries,
  buildInboundHistoryFromEntries,
  clearChannelHistoryIfEnabled,
  normalizeHistoryMediaEntries,
  recordChannelHistoryEntryIfEnabled,
  recordChannelHistoryEntryWithMedia,
} from "../../auto-reply/reply/history.js";
import type { HistoryEntry, HistoryMediaEntry } from "../../auto-reply/reply/history.types.js";
import { truncateUtf8Prefix } from "../../utils/utf8-truncate.js";

type MaybePromise<T> = T | Promise<T>;

const PERSISTED_HISTORY_SCHEMA_VERSION = 1;
const DEFAULT_PERSISTED_HISTORY_MAX_BYTES = 48 * 1024;
const DEFAULT_PERSISTED_HISTORY_TTL_MS = 24 * 60 * 60_000;

type PersistedHistoryItem<T extends HistoryEntry> = {
  sequence: number;
  entry: T;
};

/** JSON state stored by a channel plugin in the host-owned SQLite keyed store. */
export type PersistedChannelHistory<T extends HistoryEntry = HistoryEntry> = {
  schemaVersion: typeof PERSISTED_HISTORY_SCHEMA_VERSION;
  nextSequence: number;
  items: PersistedHistoryItem<T>[];
};

/** Minimal synchronous SQLite-backed store seam supplied by trusted channel runtimes. */
export type ChannelHistoryPersistence<T extends HistoryEntry = HistoryEntry> = {
  lookup: (key: string) => PersistedChannelHistory<T> | undefined;
  update: (
    key: string,
    updateValue: (
      current: PersistedChannelHistory<T> | undefined,
    ) => PersistedChannelHistory<T> | undefined,
    opts?: { ttlMs?: number },
  ) => boolean;
  delete: (key: string) => boolean;
};

/** Adapts a trusted plugin sync keyed store into the channel-history seam. */
export function createChannelHistoryPersistence<T extends HistoryEntry>(store: {
  lookup: (key: string) => PersistedChannelHistory<T> | undefined;
  update?: ChannelHistoryPersistence<T>["update"];
  delete: (key: string) => boolean;
}): ChannelHistoryPersistence<T> {
  if (typeof store.update !== "function") {
    throw new Error("channel history persistence requires atomic keyed-store update support");
  }
  return {
    lookup: (key) => store.lookup(key),
    update: (key, updateValue, opts) => store.update?.(key, updateValue, opts) ?? false,
    delete: (key) => store.delete(key),
  };
}

/** Immutable read watermark used to consume only context included in one agent turn. */
export type ChannelHistorySnapshot<T extends HistoryEntry = HistoryEntry> = {
  entries: T[];
  throughSequence?: number;
};

function emptyPersistedHistory<T extends HistoryEntry>(): PersistedChannelHistory<T> {
  return { schemaVersion: PERSISTED_HISTORY_SCHEMA_VERSION, nextSequence: 1, items: [] };
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isPersistedHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: the object check above narrows the unknown JSON value to a property bag.
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.sender !== "string" ||
    typeof entry.body !== "string" ||
    !isOptionalFiniteNumber(entry.timestamp) ||
    !isOptionalString(entry.messageId)
  ) {
    return false;
  }
  if (entry.media === undefined) {
    return true;
  }
  if (!Array.isArray(entry.media)) {
    return false;
  }
  return entry.media.every((mediaValue) => {
    if (!mediaValue || typeof mediaValue !== "object") {
      return false;
    }
    // SAFETY: the object check above narrows the unknown media JSON value to a property bag.
    const media = mediaValue as Record<string, unknown>;
    return (
      isOptionalString(media.contentType) &&
      isOptionalString(media.kind) &&
      isOptionalString(media.messageId) &&
      isOptionalString(media.path) &&
      isOptionalString(media.url) &&
      isOptionalFiniteNumber(media.durationMs) &&
      isOptionalFiniteNumber(media.height) &&
      isOptionalFiniteNumber(media.sizeBytes) &&
      isOptionalFiniteNumber(media.width)
    );
  });
}

function assertPersistedHistory<T extends HistoryEntry>(
  value: PersistedChannelHistory<T> | undefined,
): PersistedChannelHistory<T> {
  if (value === undefined) {
    return emptyPersistedHistory<T>();
  }
  if (
    value.schemaVersion !== PERSISTED_HISTORY_SCHEMA_VERSION ||
    !Number.isSafeInteger(value.nextSequence) ||
    value.nextSequence < 1 ||
    !Array.isArray(value.items)
  ) {
    throw new Error("persisted channel history has an unsupported or corrupt shape");
  }
  let previousSequence = 0;
  for (const item of value.items) {
    if (
      !item ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence <= previousSequence ||
      item.sequence >= value.nextSequence ||
      !isPersistedHistoryEntry(item.entry)
    ) {
      throw new Error("persisted channel history has an unsupported or corrupt shape");
    }
    previousSequence = item.sequence;
  }
  return value;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function prunePersistedHistory<T extends HistoryEntry>(params: {
  state: PersistedChannelHistory<T>;
  limit: number;
  maxBytes: number;
  now: number;
  ttlMs: number;
}): PersistedChannelHistory<T> {
  const cutoff = params.now - params.ttlMs;
  let items = params.state.items.filter((item) => (item.entry.timestamp ?? params.now) >= cutoff);
  if (items.length > params.limit) {
    items = items.slice(-params.limit);
  }
  const state: PersistedChannelHistory<T> = {
    schemaVersion: params.state.schemaVersion,
    nextSequence: params.state.nextSequence,
    items,
  };
  while (state.items.length > 1 && serializedBytes(state) > params.maxBytes) {
    state.items = state.items.slice(1);
  }
  if (state.items.length === 1 && serializedBytes(state) > params.maxBytes) {
    const only = state.items[0];
    if (!only) {
      return state;
    }
    let body = only.entry.body;
    while (body && serializedBytes(state) > params.maxBytes) {
      body = truncateUtf8Prefix(body, Math.max(0, Math.floor(Buffer.byteLength(body, "utf8") / 2)));
      state.items = [{ ...only, entry: { ...only.entry, body } }];
    }
    if (serializedBytes(state) > params.maxBytes) {
      throw new Error("persisted channel history entry exceeds the configured byte budget");
    }
  }
  return state;
}

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
    mediaMaxBytes?: number;
    messageId?: string;
    shouldRecord?: () => boolean;
  }) => Promise<T[]>;
  buildPendingContext: (params: {
    historyKey: string;
    limit: number;
    currentMessage: string;
    formatEntry: (entry: T) => string;
    lineBreak?: string;
    snapshot?: ChannelHistorySnapshot<T>;
  }) => string;
  buildInboundHistory: (params: {
    historyKey: string;
    limit: number;
    snapshot?: ChannelHistorySnapshot<T>;
  }) => HistoryEntry[] | undefined;
  snapshot: (params: { historyKey: string; limit: number }) => ChannelHistorySnapshot<T>;
  consume: (params: {
    historyKey: string;
    limit: number;
    snapshot: ChannelHistorySnapshot<T>;
  }) => void;
  clear: (params: { historyKey: string; limit: number }) => void;
};

/** Creates a bounded channel history window over a map and optional persisted SQLite store. */
export function createChannelHistoryWindow<T extends HistoryEntry = HistoryEntry>(params: {
  historyMap: Map<string, T[]>;
  persistence?: {
    store: ChannelHistoryPersistence<T>;
    keyPrefix?: string;
    maxBytes?: number;
    ttlMs?: number;
    now?: () => number;
  };
}): ChannelHistoryWindow<T> {
  const { historyMap } = params;
  const persistence = params.persistence;
  const persistedKey = (historyKey: string) =>
    persistence?.keyPrefix ? persistence.keyPrefix + ":" + historyKey : historyKey;
  const snapshot = (historyParams: {
    historyKey: string;
    limit: number;
  }): ChannelHistorySnapshot<T> => {
    if (!persistence || historyParams.limit <= 0) {
      const entries =
        historyParams.limit > 0
          ? (historyMap.get(historyParams.historyKey)?.slice(-historyParams.limit) ?? [])
          : [];
      return { entries };
    }
    const state = prunePersistedHistory({
      state: assertPersistedHistory(
        persistence.store.lookup(persistedKey(historyParams.historyKey)),
      ),
      limit: historyParams.limit,
      maxBytes: persistence.maxBytes ?? DEFAULT_PERSISTED_HISTORY_MAX_BYTES,
      now: (persistence.now ?? Date.now)(),
      ttlMs: persistence.ttlMs ?? DEFAULT_PERSISTED_HISTORY_TTL_MS,
    });
    const throughSequence = state.items.at(-1)?.sequence;
    return {
      entries: state.items.map((item) => item.entry),
      ...(throughSequence === undefined ? {} : { throughSequence }),
    };
  };
  const recordPersisted = (recordParams: {
    historyKey: string;
    entry?: T | null;
    limit: number;
  }): T[] => {
    if (!persistence || !recordParams.entry || recordParams.limit <= 0) {
      return [];
    }
    const recordEntry = recordParams.entry;
    const now = (persistence.now ?? Date.now)();
    persistence.store.update(
      persistedKey(recordParams.historyKey),
      (current) => {
        const state = assertPersistedHistory(current);
        if (
          recordEntry.messageId &&
          state.items.some((item) => item.entry.messageId === recordEntry.messageId)
        ) {
          return state;
        }
        const entry = {
          ...recordEntry,
          timestamp: recordEntry.timestamp ?? now,
        } as T; // SAFETY: T extends HistoryEntry; adding an optional field preserves every T field.
        return prunePersistedHistory({
          state: {
            schemaVersion: PERSISTED_HISTORY_SCHEMA_VERSION,
            nextSequence: state.nextSequence + 1,
            items: [...state.items, { sequence: state.nextSequence, entry }],
          },
          limit: recordParams.limit,
          maxBytes: persistence.maxBytes ?? DEFAULT_PERSISTED_HISTORY_MAX_BYTES,
          now,
          ttlMs: persistence.ttlMs ?? DEFAULT_PERSISTED_HISTORY_TTL_MS,
        });
      },
      { ttlMs: persistence.ttlMs ?? DEFAULT_PERSISTED_HISTORY_TTL_MS },
    );
    return snapshot(recordParams).entries;
  };

  return {
    record: (recordParams) => {
      if (persistence) {
        return recordPersisted(recordParams);
      }
      return recordChannelHistoryEntryIfEnabled({
        historyMap,
        historyKey: recordParams.historyKey,
        limit: recordParams.limit,
        entry: recordParams.entry,
      });
    },
    recordWithMedia: async (recordParams) => {
      if (!persistence) {
        return await recordChannelHistoryEntryWithMedia({
          historyMap,
          historyKey: recordParams.historyKey,
          limit: recordParams.limit,
          entry: recordParams.entry,
          media: recordParams.media,
          mediaLimit: recordParams.mediaLimit,
          mediaMaxBytes: recordParams.mediaMaxBytes,
          messageId: recordParams.messageId,
          shouldRecord: recordParams.shouldRecord,
        });
      }
      if (
        !recordParams.entry ||
        recordParams.limit <= 0 ||
        recordParams.shouldRecord?.() === false
      ) {
        return [];
      }
      let resolvedMedia: readonly HistoryMediaEntry[] | null | undefined;
      try {
        resolvedMedia =
          typeof recordParams.media === "function"
            ? await recordParams.media()
            : recordParams.media;
      } catch (error) {
        recordPersisted(recordParams);
        throw error;
      }
      if (recordParams.shouldRecord?.() === false) {
        return [];
      }
      const media = normalizeHistoryMediaEntries({
        media: resolvedMedia,
        limit: recordParams.mediaLimit,
        maxBytes: recordParams.mediaMaxBytes,
        messageId: recordParams.messageId ?? recordParams.entry.messageId,
      });
      const entryWithMedia =
        media.length > 0
          ? // SAFETY: T extends HistoryEntry and media is an optional HistoryEntry field.
            ({ ...recordParams.entry, media } as T)
          : recordParams.entry;
      return recordPersisted({
        ...recordParams,
        entry: entryWithMedia,
      });
    },
    buildPendingContext: (contextParams) => {
      if (contextParams.snapshot || persistence) {
        const entries = contextParams.snapshot?.entries ?? snapshot(contextParams).entries;
        return buildHistoryContextFromEntries({
          entries,
          currentMessage: contextParams.currentMessage,
          formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string, // SAFETY: every stored entry is T, which extends HistoryEntry.
          lineBreak: contextParams.lineBreak,
          excludeLast: false,
        });
      }
      return buildChannelPendingHistoryContext({
        historyMap,
        historyKey: contextParams.historyKey,
        limit: contextParams.limit,
        currentMessage: contextParams.currentMessage,
        formatEntry: contextParams.formatEntry as (entry: HistoryEntry) => string, // SAFETY: every stored entry is T, which extends HistoryEntry.
        lineBreak: contextParams.lineBreak,
      });
    },
    buildInboundHistory: (historyParams) => {
      if (historyParams.snapshot || persistence) {
        return buildInboundHistoryFromEntries({
          entries: historyParams.snapshot?.entries ?? snapshot(historyParams).entries,
          limit: historyParams.limit,
        });
      }
      return buildChannelInboundHistory({
        historyMap,
        historyKey: historyParams.historyKey,
        limit: historyParams.limit,
      });
    },
    snapshot,
    consume: (consumeParams) => {
      const throughSequence = consumeParams.snapshot.throughSequence;
      if (persistence && throughSequence !== undefined) {
        persistence.store.update(
          persistedKey(consumeParams.historyKey),
          (current) => {
            const state = assertPersistedHistory(current);
            const items = state.items.filter((item) => item.sequence > throughSequence);
            // Plugin keyed-store update callbacks treat `undefined` as "leave the
            // current row unchanged", not delete. Persist an empty state so the
            // consumed snapshot cannot reappear after restart. A concurrent
            // record has a higher sequence and therefore survives this update.
            return { ...state, items };
          },
          { ttlMs: persistence.ttlMs ?? DEFAULT_PERSISTED_HISTORY_TTL_MS },
        );
        return;
      }
      clearChannelHistoryIfEnabled({
        historyMap,
        historyKey: consumeParams.historyKey,
        limit: consumeParams.limit,
      });
    },
    clear: (clearParams) => {
      if (persistence) {
        persistence.store.delete(persistedKey(clearParams.historyKey));
        return;
      }
      clearChannelHistoryIfEnabled({
        historyMap,
        historyKey: clearParams.historyKey,
        limit: clearParams.limit,
      });
    },
  };
}
