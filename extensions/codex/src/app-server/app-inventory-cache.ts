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
import { CodexAppServerRpcError } from "./client.js";
import type {
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
  v2,
} from "./protocol.js";

/** Default app inventory cache freshness window. */
const CODEX_APP_INVENTORY_CACHE_TTL_MS = 60 * 60 * 1_000;
// Codex 0.145.0 AppsReadParams rejects requests with more than 100 app IDs.
const CODEX_APP_READ_BATCH_LIMIT = 100;
const CODEX_TARGETED_LEGACY_APP_INVENTORY_LIMIT = 1_000;
const MAX_SERIALIZED_ERROR_MESSAGE_LENGTH = 500;

/** App-server request function used to read installed apps and their metadata. */
export type CodexAppInventoryRequest = <Method extends "app/installed" | "app/list" | "app/read">(
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
  source: "installed" | "legacy";
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
};

type RefreshParams = {
  key: string;
  request: CodexAppInventoryRequest;
  nowMs?: number;
  forceRefetch?: boolean;
  suppressRefresh?: boolean;
  targetAppIds?: readonly string[];
};

/** In-memory app inventory cache with coalesced refreshes per key. */
export class CodexAppInventoryCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CodexAppInventorySnapshot>>();
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

  /** Marks a key stale and records the reason as a diagnostic. */
  invalidate(key: string, reason: string, nowMs = Date.now()): number {
    this.revision += 1;
    const diagnostic = { message: reason, atMs: nowMs };
    const entry = this.entries.get(key);
    if (entry) {
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
    if (this.inFlight.has(params.key) && !params.forceRefetch) {
      return true;
    }
    const promise = this.refresh(params);
    this.inFlight.set(params.key, promise);
    promise.catch(() => undefined);
    return true;
  }

  private async refresh(params: RefreshParams): Promise<CodexAppInventorySnapshot> {
    const existing = this.inFlight.get(params.key);
    if (existing && !params.forceRefetch) {
      return existing;
    }

    const refreshToken = (this.refreshTokens.get(params.key) ?? 0) + 1;
    this.refreshTokens.set(params.key, refreshToken);
    const promise = this.refreshUncoalesced(params, refreshToken);
    this.inFlight.set(params.key, promise);
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(params.key) === promise) {
        this.inFlight.delete(params.key);
      }
    }
  }

  private async refreshUncoalesced(
    params: RefreshParams,
    refreshToken: number,
  ): Promise<CodexAppInventorySnapshot> {
    const nowMs = resolveDateTimestampMs(params.nowMs);
    try {
      const inventory = await readInstalledApps(
        params.request,
        params.forceRefetch ?? false,
        params.targetAppIds,
      );
      this.revision += 1;
      const expiresAtMs = resolveExpiresAtMsFromDurationMs(this.ttlMs, { nowMs }) ?? 0;
      const snapshot: CodexAppInventorySnapshot = {
        key: params.key,
        apps: inventory.apps,
        source: inventory.source,
        fetchedAtMs: nowMs,
        expiresAtMs,
        revision: this.revision,
      };
      // Only publish this snapshot if no newer refresh started for the same key
      // while this request was in flight.
      if (this.refreshTokens.get(params.key) === refreshToken) {
        this.entries.set(params.key, { ...snapshot, invalidated: false });
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
  forceRefetch: boolean,
  targetAppIds: readonly string[] = [],
): Promise<{ apps: v2.AppInfo[]; source: CodexAppInventorySnapshot["source"] }> {
  let installed: v2.AppsInstalledResponse;
  try {
    // A non-forced installed read returns the prior committed runtime snapshot;
    // refreshing OpenClaw's cache must refresh the upstream snapshot as well.
    installed = await request("app/installed", { forceRefresh: true });
  } catch (error) {
    // OpenClaw still supports Codex 0.143.0 and 0.144.x, which do not
    // implement the 0.145.0 installed-app lifecycle methods.
    if (
      !(error instanceof CodexAppServerRpcError) ||
      error.code !== -32601 ||
      error.method !== "app/installed"
    ) {
      throw error;
    }
    return {
      apps: await readLegacyInstalledApps(request, forceRefetch, targetAppIds),
      source: "legacy",
    };
  }
  const targetIds = new Set(targetAppIds.filter(Boolean));
  const apps =
    targetIds.size === 0 ? installed.apps : installed.apps.filter((app) => targetIds.has(app.id));
  if (apps.length === 0) {
    return { apps: [], source: "installed" };
  }

  const metadataResponses = await Promise.all(
    Array.from({ length: Math.ceil(apps.length / CODEX_APP_READ_BATCH_LIMIT) }, (_, index) =>
      request("app/read", {
        appIds: apps
          .slice(index * CODEX_APP_READ_BATCH_LIMIT, (index + 1) * CODEX_APP_READ_BATCH_LIMIT)
          .map((app) => app.id),
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
          isAccessible: installedApp.callable,
          isEnabled: installedApp.enabled,
          pluginDisplayNames: metadata.pluginDisplayNames,
        },
      ];
    }),
    source: "installed",
  };
}

async function readLegacyInstalledApps(
  request: CodexAppInventoryRequest,
  forceRefetch: boolean,
  targetAppIds: readonly string[],
): Promise<v2.AppInfo[]> {
  const apps: v2.AppInfo[] = [];
  const remainingTargetIds = new Set(targetAppIds.filter(Boolean));
  const seenCursors = new Set<string>();
  let cursor: string | null | undefined;

  do {
    const response = await request("app/list", {
      cursor,
      limit: remainingTargetIds.size > 0 ? CODEX_TARGETED_LEGACY_APP_INVENTORY_LIMIT : 100,
      forceRefetch,
    });
    for (const app of response.data) {
      // Legacy accessibility predates installed callability; disabled apps
      // must obey the same fail-closed runtime contract as modern snapshots.
      apps.push(app.isEnabled ? app : { ...app, isAccessible: false });
      remainingTargetIds.delete(app.id);
    }
    if (targetAppIds.length > 0 && remainingTargetIds.size === 0) {
      break;
    }
    cursor = response.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`app/list returned repeated cursor ${cursor}`);
    }
    if (cursor) {
      seenCursors.add(cursor);
    }
  } while (cursor);

  return apps;
}

function stripEntryState(entry: CacheEntry): CodexAppInventorySnapshot {
  const { invalidated: _invalidated, ...snapshot } = entry;
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
