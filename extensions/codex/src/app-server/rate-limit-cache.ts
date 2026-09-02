/** Client-owned Codex app-server rate-limit snapshots. */
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

const DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS = 10 * 60_000;
const SPARSE_ACCOUNT_METADATA_KEYS = ["credits", "individualLimit", "planType"] as const;

type CodexRateLimitCacheState = {
  value: JsonValue;
  updatedAtMs: number;
  revisionsByLimitId: Record<string, number>;
};

const rateLimitsByClient = new WeakMap<CodexAppServerClient, CodexRateLimitCacheState>();

/** Replaces one physical client's cache with an authoritative rate-limit read response. */
export function rememberCodexRateLimitsRead(
  client: CodexAppServerClient,
  value: JsonValue | undefined,
  nowMs = Date.now(),
): void {
  if (value !== undefined) {
    const currentState = rateLimitsByClient.get(client);
    const revisionsByLimitId = { ...currentState?.revisionsByLimitId };
    for (const limitId of readRateLimitIds(value)) {
      revisionsByLimitId[limitId] = (revisionsByLimitId[limitId] ?? 0) + 1;
    }
    rateLimitsByClient.set(client, {
      value,
      updatedAtMs: nowMs,
      revisionsByLimitId,
    });
  }
}

/** Merges a sparse rolling notification into one physical client's latest read response. */
export function mergeCodexRateLimitsUpdate(
  client: CodexAppServerClient,
  value: JsonValue | undefined,
  nowMs = Date.now(),
): void {
  const update =
    isJsonObject(value) && isJsonObject(value.rateLimits) ? value.rateLimits : undefined;
  if (!update) {
    return;
  }
  const currentState = rateLimitsByClient.get(client);
  const current = currentState?.value;
  const limitId = readLimitId(update);
  rateLimitsByClient.set(client, {
    value: mergeRateLimitUpdate(current, update),
    updatedAtMs: nowMs,
    revisionsByLimitId: {
      ...currentState?.revisionsByLimitId,
      [limitId]: (currentState?.revisionsByLimitId[limitId] ?? 0) + 1,
    },
  });
}

/** Per-limit marker used to trust only primary Codex updates from one turn startup. */
export function readCodexRateLimitsRevision(
  client: CodexAppServerClient,
  limitId = "codex",
): number {
  return rateLimitsByClient.get(client)?.revisionsByLimitId[limitId] ?? 0;
}

/** Reads one physical client's cached rate-limit payload within the max-age window. */
export function readRecentCodexRateLimits(
  client: CodexAppServerClient,
  options?: {
    nowMs?: number;
    maxAgeMs?: number;
  },
): JsonValue | undefined {
  const state = rateLimitsByClient.get(client);
  if (!state) {
    return undefined;
  }
  const nowMs = options?.nowMs ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS;
  return maxAgeMs >= 0 && nowMs - state.updatedAtMs > maxAgeMs ? undefined : state.value;
}

function mergeRateLimitUpdate(current: JsonValue | undefined, update: JsonObject): JsonObject {
  const currentEnvelope = isJsonObject(current) ? current : undefined;
  const currentPrimary =
    currentEnvelope && isJsonObject(currentEnvelope.rateLimits)
      ? currentEnvelope.rateLimits
      : undefined;
  const currentByLimitId =
    currentEnvelope && isJsonObject(currentEnvelope.rateLimitsByLimitId)
      ? currentEnvelope.rateLimitsByLimitId
      : undefined;
  const limitId = readLimitId(update);
  const currentPrimaryLimitId = currentPrimary ? readLimitId(currentPrimary) : undefined;
  const currentForLimit =
    (currentByLimitId && isJsonObject(currentByLimitId[limitId])
      ? currentByLimitId[limitId]
      : undefined) ?? (currentPrimaryLimitId === limitId ? currentPrimary : undefined);
  const merged = mergeSparseSnapshot(
    isJsonObject(currentForLimit) ? currentForLimit : undefined,
    currentPrimary,
    update,
    limitId,
  );
  const nextPrimary =
    !currentPrimary || currentPrimaryLimitId === limitId ? merged : currentPrimary;
  let nextByLimitId: JsonObject | undefined;
  if (currentByLimitId) {
    nextByLimitId = { ...currentByLimitId, [limitId]: merged };
  } else if (currentPrimary && currentPrimaryLimitId && currentPrimaryLimitId !== limitId) {
    nextByLimitId = {
      [currentPrimaryLimitId]: currentPrimary,
      [limitId]: merged,
    };
  }
  return {
    ...currentEnvelope,
    rateLimits: nextPrimary,
    ...(nextByLimitId ? { rateLimitsByLimitId: nextByLimitId } : {}),
  };
}

function readRateLimitIds(value: JsonValue): string[] {
  if (!isJsonObject(value)) {
    return [];
  }
  const ids = new Set<string>();
  if (isJsonObject(value.rateLimits)) {
    ids.add(readLimitId(value.rateLimits));
  }
  if (isJsonObject(value.rateLimitsByLimitId)) {
    for (const [key, snapshot] of Object.entries(value.rateLimitsByLimitId)) {
      const snapshotLimitId =
        isJsonObject(snapshot) && typeof snapshot.limitId === "string"
          ? snapshot.limitId.trim()
          : "";
      ids.add(snapshotLimitId || key);
    }
  }
  return [...ids];
}

function mergeSparseSnapshot(
  current: JsonObject | undefined,
  accountFallback: JsonObject | undefined,
  update: JsonObject,
  limitId: string,
): JsonObject {
  const merged: JsonObject = { ...update, limitId };
  // Rolling updates serialize unavailable account metadata as null. Preserve
  // only those sparse fields; window and reached-state nulls remain authoritative.
  for (const key of SPARSE_ACCOUNT_METADATA_KEYS) {
    const previous = current?.[key] ?? accountFallback?.[key];
    if (merged[key] == null && previous != null) {
      merged[key] = previous;
    }
  }
  return merged;
}

function readLimitId(snapshot: JsonObject): string {
  const value = snapshot.limitId;
  return typeof value === "string" && value.trim() ? value.trim() : "codex";
}
