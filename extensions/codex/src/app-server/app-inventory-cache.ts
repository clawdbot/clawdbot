/**
 * Process-local cache for Codex app-server app inventories, keyed by runtime
 * identity and safe to refresh in the background.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isFutureDateTimestampMs,
  resolveDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
  v2,
} from "./protocol.js";

/** Default app inventory cache freshness window. */
const CODEX_APP_INVENTORY_CACHE_TTL_MS = 60 * 60 * 1_000;
// Codex app/read rejects metadata requests containing more than 100 app IDs.
const CODEX_APP_READ_BATCH_LIMIT = 100;
const MAX_SERIALIZED_ERROR_MESSAGE_LENGTH = 500;

/** App-server request function used to read installed apps and their metadata. */
export type CodexAppInventoryRequest = <Method extends "app/installed" | "app/read">(
  method: Method,
  params: CodexAppServerRequestParams<Method>,
) => Promise<CodexAppServerRequestResult<Method>>;

/** Runtime identity fields that affect visible Codex app inventory. */
export type CodexAppInventoryCacheKeyInput = {
  codexHome?: string;
  endpoint?: string;
  runtimeIdentity?: Record<string, string | undefined>;
  authProfileId?: string;
  accountId?: string;
  envApiKeyFingerprint?: string;
  appServerVersion?: string;
};

/** Last refresh diagnostic stored with a cache key or snapshot. */
type CodexAppInventoryCacheDiagnostic = {
  message: string;
  atMs: number;
};

/** Immutable app inventory snapshot returned from cache reads and refreshes. */
export type CodexAppInventorySnapshot = {
  key: string;
  apps: v2.AppInfo[];
  installedApps: readonly v2.InstalledApp[];
  /** Absent for complete inventory; present for plugin-targeted snapshots. */
  targetAppIds?: readonly string[];
  fetchedAtMs: number;
  expiresAtMs: number;
  revision: number;
  lastError?: CodexAppInventoryCacheDiagnostic;
};

/** Freshness state for a cache read. */
type CodexAppInventoryReadState = "fresh" | "stale" | "missing";

/** Cache read result plus refresh scheduling state. */
export type CodexAppInventoryCacheRead = {
  state: CodexAppInventoryReadState;
  key: string;
  revision: number;
  snapshot?: CodexAppInventorySnapshot;
  refreshScheduled: boolean;
  diagnostic?: CodexAppInventoryCacheDiagnostic;
};

type CacheEntry = CodexAppInventorySnapshot & {
  invalidated: boolean;
  /** Present while invalidated: the app ids the invalidation concerns. Absent = whole inventory. */
  invalidatedAppIds?: readonly string[];
};

type RefreshParams = {
  key: string;
  request: CodexAppInventoryRequest;
  nowMs?: number;
  forceRefetch?: boolean;
  suppressRefresh?: boolean;
  targetAppIds?: readonly string[];
};

type InFlightRefresh = {
  promise: Promise<CodexAppInventorySnapshot>;
  targetAppIds: ReadonlySet<string>;
};

/** In-memory app inventory cache with coalesced refreshes per key. */
export class CodexAppInventoryCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightRefresh>();
  // Per-key refresh generation. Each refresh attempt claims the next token so
  // an older request that finishes late cannot overwrite a newer snapshot.
  private readonly refreshTokens = new Map<string, number>();
  private readonly diagnostics = new Map<string, CodexAppInventoryCacheDiagnostic>();
  private revision = 0;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? CODEX_APP_INVENTORY_CACHE_TTL_MS;
  }

  /** Reads a snapshot and schedules refresh when missing, stale, or forced. */
  read(params: RefreshParams): CodexAppInventoryCacheRead {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    const entry = this.entries.get(params.key);
    if (!entry) {
      const refreshScheduled = params.suppressRefresh ? false : this.scheduleRefresh(params);
      return {
        state: "missing",
        key: params.key,
        revision: this.revision,
        refreshScheduled,
        ...(this.diagnostics.get(params.key)
          ? { diagnostic: this.diagnostics.get(params.key) }
          : {}),
      };
    }

    const state: CodexAppInventoryReadState =
      entry.invalidated || !isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })
        ? "stale"
        : "fresh";
    const refreshScheduled =
      state === "fresh" && !params.forceRefetch ? false : this.scheduleRefresh(params);
    return {
      state,
      key: params.key,
      revision: entry.revision,
      snapshot: stripEntryState(entry),
      refreshScheduled,
      ...(entry.lastError ? { diagnostic: entry.lastError } : {}),
    };
  }

  /** Forces or joins an immediate refresh for a cache key. */
  refreshNow(params: RefreshParams): Promise<CodexAppInventorySnapshot> {
    return this.refresh(params);
  }

  /**
   * Marks a key stale and records the reason as a diagnostic. A scope names
   * the app ids the invalidation concerns so a covering targeted refresh can
   * clear it; without one, only a complete refresh revalidates the entry.
   */
  invalidate(
    key: string,
    reason: string,
    nowMs = Date.now(),
    invalidatedAppIds?: readonly string[],
  ): number {
    this.revision += 1;
    // Invalidation outranks in-flight refreshes: retire their publish token so
    // pre-invalidation reads cannot republish as fresh, and drop the shared
    // in-flight slot so the next read starts a post-invalidation refresh.
    this.refreshTokens.set(key, (this.refreshTokens.get(key) ?? 0) + 1);
    this.inFlight.delete(key);
    const diagnostic = { message: reason, atMs: nowMs };
    const entry = this.entries.get(key);
    if (entry) {
      const scope = invalidatedAppIds?.filter(Boolean) ?? [];
      if (!entry.invalidated) {
        entry.invalidatedAppIds = scope.length ? [...scope].toSorted() : undefined;
      } else if (entry.invalidatedAppIds && scope.length) {
        // Stacked scoped invalidations widen; an unscoped one stays whole-inventory.
        entry.invalidatedAppIds = Array.from(
          new Set([...entry.invalidatedAppIds, ...scope]),
        ).toSorted();
      } else {
        entry.invalidatedAppIds = undefined;
      }
      entry.invalidated = true;
      entry.lastError = diagnostic;
      entry.revision = this.revision;
    } else {
      this.diagnostics.set(key, diagnostic);
    }
    return this.revision;
  }

  /** Clears all cached snapshots, diagnostics, in-flight requests, and revision state. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.refreshTokens.clear();
    this.diagnostics.clear();
    this.revision = 0;
  }

  /** Returns the monotonically increasing cache revision. */
  getRevision(): number {
    return this.revision;
  }

  private scheduleRefresh(params: RefreshParams): boolean {
    const existing = this.inFlight.get(params.key);
    if (existing && !params.forceRefetch && doesInFlightRefreshCover(existing, params)) {
      return true;
    }
    const promise = this.refresh(params);
    promise.catch(() => undefined);
    return true;
  }

  private async refresh(params: RefreshParams): Promise<CodexAppInventorySnapshot> {
    const existing = this.inFlight.get(params.key);
    if (existing && !params.forceRefetch && doesInFlightRefreshCover(existing, params)) {
      return existing.promise;
    }

    const refreshToken = (this.refreshTokens.get(params.key) ?? 0) + 1;
    this.refreshTokens.set(params.key, refreshToken);
    const previousRefresh = params.forceRefetch ? undefined : existing?.promise;
    const promise = this.refreshUncoalesced(params, refreshToken, previousRefresh);
    const currentRefresh = {
      promise,
      targetAppIds: new Set(params.targetAppIds?.filter(Boolean) ?? []),
    };
    this.inFlight.set(params.key, currentRefresh);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(params.key) === currentRefresh) {
        this.inFlight.delete(params.key);
      }
    }
  }

  private async refreshUncoalesced(
    params: RefreshParams,
    refreshToken: number,
    previousRefresh?: Promise<CodexAppInventorySnapshot>,
  ): Promise<CodexAppInventorySnapshot> {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    try {
      let previousRefreshSucceeded = false;
      if (previousRefresh) {
        try {
          await previousRefresh;
          previousRefreshSucceeded = true;
        } catch {
          // A failed narrow read does not seed Codex; let the broader read
          // retry independently and perform the cold refresh when required.
        }
      }
      const inventory = await readInstalledApps(params.request, {
        // A cold upstream connector cache is empty until it is deliberately
        // seeded. Later reads reuse its committed snapshot unless requested.
        forceRefresh:
          params.forceRefetch === true ||
          (!this.entries.has(params.key) && !previousRefreshSucceeded),
        targetAppIds: params.targetAppIds,
      });
      this.revision += 1;
      const expiresAtMs = resolveExpiresAtMsFromDurationMs(this.ttlMs, { nowMs }) ?? 0;
      const snapshot: CodexAppInventorySnapshot = {
        key: params.key,
        apps: inventory.apps,
        installedApps: inventory.installedApps,
        ...(params.targetAppIds?.some(Boolean)
          ? { targetAppIds: Array.from(new Set(params.targetAppIds.filter(Boolean))).toSorted() }
          : {}),
        fetchedAtMs: nowMs,
        expiresAtMs,
        revision: this.revision,
      };
      // Only publish this snapshot if no newer refresh started for the same key
      // while this request was in flight.
      if (this.refreshTokens.get(params.key) === refreshToken) {
        const existingEntry = this.entries.get(params.key);
        const published = resolvePublishedInventorySnapshot(existingEntry, snapshot, nowMs);
        // An uncovered invalidation keeps its remaining scope and diagnostic
        // until covering or complete refreshes prove the entry current again.
        const remaining = resolveRemainingInvalidationScope(existingEntry, snapshot);
        this.entries.set(params.key, {
          ...published,
          ...remaining,
          ...(remaining.invalidated && existingEntry?.lastError
            ? { lastError: existingEntry.lastError }
            : {}),
        });
        this.diagnostics.delete(params.key);
      }
      return snapshot;
    } catch (error) {
      const diagnostic = {
        message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
        atMs: nowMs,
      };
      this.diagnostics.set(params.key, diagnostic);
      const entry = this.entries.get(params.key);
      if (entry) {
        entry.lastError = diagnostic;
      }
      embeddedAgentLog.warn("codex app inventory refresh failed", {
        forceRefetch: params.forceRefetch === true,
        keyFingerprint: fingerprintInventoryCacheKey(params.key),
        error: serializeCodexAppInventoryError(error),
      });
      throw error;
    }
  }
}

/**
 * Publish policy for refreshed snapshots. A complete refresh replaces the
 * entry, but a targeted refresh only rewrites its own target rows in place —
 * replacing the whole entry with a narrow snapshot makes agents that share
 * the runtime identity see each other's plugin apps vanish and force a hosted
 * connector refresh per turn. The refreshed snapshot stays authoritative for
 * its target set, so target rows it no longer returns are deleted.
 */
function resolvePublishedInventorySnapshot(
  existing: CodexAppInventorySnapshot | undefined,
  snapshot: CodexAppInventorySnapshot,
  nowMs: number,
): CodexAppInventorySnapshot {
  if (!snapshot.targetAppIds?.length || !existing) {
    return snapshot;
  }
  // Merging preserves rows the refresh never re-read, which is only safe while
  // the existing entry is within TTL. An expired entry is replaced outright so
  // freshness restarts from this refresh; keeping expired rows would pin the
  // entry stale no matter how many targeted refreshes cover it.
  if (!isFutureDateTimestampMs(existing.expiresAtMs, { nowMs })) {
    return snapshot;
  }
  const refreshedTargetIds = new Set(snapshot.targetAppIds);
  const { targetAppIds: snapshotTargetAppIds, ...snapshotBase } = snapshot;
  return {
    ...snapshotBase,
    // Freshness belongs to the still-valid prior fetch: the merge must not
    // renew rows it never re-read.
    fetchedAtMs: existing.fetchedAtMs,
    expiresAtMs: existing.expiresAtMs,
    apps: mergeRefreshedRows(existing.apps, snapshot.apps, refreshedTargetIds),
    installedApps: mergeRefreshedRows(
      existing.installedApps,
      snapshot.installedApps,
      refreshedTargetIds,
    ),
    // A merge into a complete entry keeps the entry complete (no targetAppIds).
    ...(existing.targetAppIds?.length
      ? {
          targetAppIds: Array.from(
            new Set([...existing.targetAppIds, ...snapshotTargetAppIds]),
          ).toSorted(),
        }
      : {}),
  };
}

/** Replaces refreshed target rows in place, deletes vanished ones, appends new ones. */
function mergeRefreshedRows<Row extends { id: string }>(
  existingRows: readonly Row[],
  refreshedRows: readonly Row[],
  refreshedTargetIds: ReadonlySet<string>,
): Row[] {
  const refreshedById = new Map(refreshedRows.map((row) => [row.id, row]));
  const existingIds = new Set(existingRows.map((row) => row.id));
  return [
    ...existingRows.flatMap((row) => {
      if (!refreshedTargetIds.has(row.id)) {
        return [row];
      }
      const refreshed = refreshedById.get(row.id);
      return refreshed ? [refreshed] : [];
    }),
    ...refreshedRows.filter((row) => !existingIds.has(row.id)),
  ];
}

/**
 * A refresh retires exactly the invalidation scope it re-read: a complete
 * refresh clears everything; a targeted one subtracts its target ids so
 * separate covering refreshes accumulate until no scope remains. Unscoped
 * invalidations require a complete refresh.
 */
function resolveRemainingInvalidationScope(
  existing: CacheEntry | undefined,
  snapshot: CodexAppInventorySnapshot,
): { invalidated: false } | { invalidated: true; invalidatedAppIds?: readonly string[] } {
  if (!existing?.invalidated || !snapshot.targetAppIds?.length) {
    return { invalidated: false };
  }
  if (!existing.invalidatedAppIds) {
    return { invalidated: true };
  }
  const refreshedTargetIds = new Set(snapshot.targetAppIds);
  const remaining = existing.invalidatedAppIds.filter((appId) => !refreshedTargetIds.has(appId));
  return remaining.length > 0
    ? { invalidated: true, invalidatedAppIds: remaining }
    : { invalidated: false };
}

function doesInFlightRefreshCover(existing: InFlightRefresh, params: RefreshParams): boolean {
  if (existing.targetAppIds.size === 0) {
    return true;
  }
  const requestedAppIds = new Set(params.targetAppIds?.filter(Boolean) ?? []);
  return (
    requestedAppIds.size > 0 &&
    Array.from(requestedAppIds).every((appId) => existing.targetAppIds.has(appId))
  );
}

/** Serializes a refresh failure without leaking large or sensitive error data. */
export function serializeCodexAppInventoryError(error: unknown): Record<string, unknown> {
  const record = isRecord(error) ? error : undefined;
  const data = record && "data" in record ? redactErrorData(record.data) : undefined;
  return {
    name:
      error instanceof Error
        ? error.name
        : typeof record?.name === "string"
          ? record.name
          : undefined,
    message: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    ...(typeof record?.code === "number" ? { code: record.code } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

/** Shared app inventory cache used by Codex app-server runtime paths. */
export const defaultCodexAppInventoryCache = new CodexAppInventoryCache();

/** Builds a stable cache key from build versions and runtime identity fields. */
export function buildCodexAppInventoryCacheKey(
  input: CodexAppInventoryCacheKeyInput,
  openClawVersion: string,
  codexPluginVersion: string,
): string {
  return JSON.stringify({
    openClawVersion,
    codexPluginVersion,
    codexHome: input.codexHome ?? null,
    endpoint: input.endpoint ?? null,
    runtimeIdentity: normalizeRuntimeIdentityForCacheKey(input.runtimeIdentity),
    authProfileId: input.authProfileId ?? null,
    accountId: input.accountId ?? null,
    envApiKeyFingerprint: input.envApiKeyFingerprint ?? null,
    appServerVersion: input.appServerVersion ?? null,
  });
}

function normalizeRuntimeIdentityForCacheKey(
  value: Record<string, string | undefined> | undefined,
): Record<string, string> | null {
  if (!value) {
    return null;
  }
  const entries = Object.entries(value)
    .flatMap(([key, rawValue]) => {
      const normalized = rawValue?.trim();
      return normalized ? ([[key, normalized]] as const) : [];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

async function readInstalledApps(
  request: CodexAppInventoryRequest,
  options: {
    forceRefresh: boolean;
    targetAppIds?: readonly string[];
  },
): Promise<{ apps: v2.AppInfo[]; installedApps: v2.InstalledApp[] }> {
  const installed = await request("app/installed", { forceRefresh: options.forceRefresh });
  const targetIds = new Set((options.targetAppIds ?? []).filter(Boolean));
  const apps =
    targetIds.size === 0 ? installed.apps : installed.apps.filter((app) => targetIds.has(app.id));
  if (apps.length === 0) {
    return { apps: [], installedApps: [] };
  }

  const metadataResponses = await Promise.all(
    Array.from({ length: Math.ceil(apps.length / CODEX_APP_READ_BATCH_LIMIT) }, (_, index) =>
      request("app/read", {
        appIds: apps
          .slice(index * CODEX_APP_READ_BATCH_LIMIT, (index + 1) * CODEX_APP_READ_BATCH_LIMIT)
          .map((app) => app.id),
        includeTools: true,
      }),
    ),
  );
  const metadataById = new Map(
    metadataResponses
      .flatMap((response) => response.apps)
      .map((metadata) => [metadata.id, metadata]),
  );

  return {
    apps: apps.flatMap((installedApp): v2.AppInfo[] => {
      const metadata = metadataById.get(installedApp.id);
      if (!metadata) {
        return [];
      }

      return [
        {
          id: installedApp.id,
          name: metadata.name,
          description: metadata.description ?? null,
          logoUrl: metadata.iconUrl ?? null,
          logoUrlDark: metadata.iconUrlDark ?? null,
          distributionChannel: metadata.distributionChannel ?? null,
          branding: null,
          appMetadata: null,
          labels: null,
          installUrl: metadata.installUrl ?? null,
          // app/read proves account authorization, while runtime callability
          // remains separately visible in installedApps for thread admission.
          isAccessible: true,
          isEnabled: installedApp.enabled,
          pluginDisplayNames: metadata.pluginDisplayNames,
          ...(metadata.toolSummaries ? { toolSummaries: metadata.toolSummaries } : {}),
        },
      ];
    }),
    installedApps: apps,
  };
}

function stripEntryState(entry: CacheEntry): CodexAppInventorySnapshot {
  const { invalidated: _invalidated, invalidatedAppIds: _invalidatedAppIds, ...snapshot } = entry;
  return snapshot;
}

function fingerprintInventoryCacheKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function truncateSerializedErrorText(value: string): string {
  return value.length > MAX_SERIALIZED_ERROR_MESSAGE_LENGTH
    ? `${truncateUtf16Safe(value, MAX_SERIALIZED_ERROR_MESSAGE_LENGTH)}...`
    : value;
}

function redactErrorData(value: unknown, depth = 0): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (depth > 6) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactErrorData(entry, depth + 1) ?? null);
  }
  if (isRecord(value)) {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = isSensitiveErrorDataKey(key)
        ? "<redacted>"
        : (redactErrorData(entry, depth + 1) ?? null);
    }
    return redacted;
  }
  if (typeof value === "string") {
    return truncateSerializedErrorText(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") {
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  }
  if (typeof value === "function") {
    return value.name ? `[function ${value.name}]` : "[function]";
  }
  return "[unserializable]";
}

function sanitizeErrorMessage(message: string): string {
  const htmlStart = message.search(/<html[\s>]/i);
  const withoutHtml =
    htmlStart >= 0
      ? `${message.slice(0, htmlStart).trimEnd()} [HTML response body omitted]`
      : message;
  const redacted = withoutHtml.replace(
    /([?&][^=\s"'<>]*(?:api[_-]?key|authorization|cookie|credential|password|secret|token|tk)[^=\s"'<>]*=)[^&\s"'<>]+/gi,
    "$1<redacted>",
  );
  return truncateSerializedErrorText(redacted);
}

function isSensitiveErrorDataKey(key: string): boolean {
  return /api[_-]?key|authorization|cookie|credential|password|secret|token/i.test(key);
}
