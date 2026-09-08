import { expectDefined } from "@openclaw/normalization-core";
import type { SessionEntry } from "../config/sessions.js";
import {
  listSessionEntriesCore as listAccessorSessionEntries,
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadExactSessionEntryCandidates,
  loadExactSessionEntryCandidatesReadOnlyBatch,
  type SessionEntryListScope,
} from "../config/sessions/session-accessor.js";

/**
 * Request-scoped store reuse.
 *
 * Sharing resolution runs once per listed row, and each run materialized every
 * entry of a candidate store, making `sessions.list` quadratic in entries. A
 * caller that resolves many keys against the same stores passes one cache so
 * each store is materialized once. Entries are shared across rows within that
 * request, so cached stores are read-only to their holder; the cache is never
 * process-global, so it cannot serve a later request stale rows.
 */
export type GatewaySessionStoreCache = Map<string, Record<string, SessionEntry>>;

export type GatewaySessionStoreRead = {
  storePath: string;
  clone?: boolean;
  agentId?: string;
  options: NonNullable<Parameters<typeof loadGatewaySessionLookupStore>[3]>;
  store?: Record<string, SessionEntry>;
};

/** Single-target resolution keeps its original lazy read and failure order. */
export function readGatewaySessionStore(
  read: GatewaySessionStoreRead,
): Record<string, SessionEntry> {
  return (read.store ??= loadGatewaySessionLookupStore(
    read.storePath,
    read.clone,
    read.agentId,
    read.options,
  ));
}

/** Populate exact logical lookups without materializing unrelated store entries. */
export function loadGatewaySessionStoreReads(reads: readonly GatewaySessionStoreRead[]): void {
  const pending = reads.filter((read) => read.store === undefined);
  const results = loadExactSessionEntryCandidatesReadOnlyBatch(
    pending.map((read) => ({
      agentId: read.agentId,
      storePath: read.storePath,
      projection: read.options.projection,
      clone: false,
      sessionKeys: expectDefined(read.options.exactKeys, "exact batch lookup keys"),
    })),
  );
  for (const [index, read] of pending.entries()) {
    const result = expectDefined(results[index], "exact batch lookup result");
    // Preserve the existing per-logical-target unreadable-store behavior.
    read.store = result.ok
      ? Object.fromEntries(result.value.map(({ sessionKey, entry }) => [sessionKey, entry]))
      : {};
  }
}

function loadGatewaySessionLookupStore(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    readOnly?: boolean;
    cache?: GatewaySessionStoreCache;
    exactKeys?: readonly string[];
    projection?: SessionEntryListScope["projection"];
  } = {},
): Record<string, SessionEntry> {
  const cache = options.cache;
  const cacheKey = cache
    ? `${storePath}\u0000${agentId ?? ""}\u0000${clone === false ? "0" : "1"}\u0000${options.readOnly}\u0000${options.projection ?? "full"}\u0000${options.exactKeys?.join("\u0001") ?? ""}`
    : "";
  if (cache) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const loaded = loadGatewaySessionLookupStoreUncached(storePath, clone, agentId, options);
  cache?.set(cacheKey, loaded);
  return loaded;
}

function loadGatewaySessionLookupStoreUncached(
  storePath: string,
  clone: boolean | undefined,
  agentId?: string,
  options: {
    exactKeys?: readonly string[];
    readOnly?: boolean;
    projection?: SessionEntryListScope["projection"];
  } = {},
): Record<string, SessionEntry> {
  try {
    if (options.exactKeys) {
      // Borrowed listing views and probes never create stores; ordinary owned reads may.
      return Object.fromEntries(
        loadExactSessionEntryCandidates({
          ...(agentId ? { agentId } : {}),
          clone: false,
          projection: options.projection,
          sessionKeys: options.exactKeys,
          readOnly: options.readOnly !== false || clone === false,
          storePath,
        }).map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
    }
    const listEntries = options.readOnly
      ? listAccessorSessionEntriesReadOnly
      : listAccessorSessionEntries;
    return Object.fromEntries(
      listEntries({
        ...(agentId ? { agentId } : {}),
        ...(clone === false ? { clone: false } : {}),
        ...(options.projection ? { projection: options.projection } : {}),
        storePath,
      }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  } catch {
    return {};
  }
}
