import type { v2 } from "./protocol.js";

export const CODEX_APP_INVENTORY_CACHE_TTL_MS = 60 * 60 * 1_000;

export type CodexAppInventoryRequest = (
  method: "app/list",
  params: v2.AppsListParams,
) => Promise<v2.AppsListResponse>;

export type CodexAppInventoryCacheKeyInput = {
  codexHome?: string;
  endpoint?: string;
  authProfileId?: string;
  accountId?: string;
  envApiKeyFingerprint?: string;
  appServerVersion?: string;
};

export type CodexAppInventoryCacheDiagnostic = {
  message: string;
  atMs: number;
};

export type CodexAppInventorySnapshot = {
  key: string;
  apps: v2.AppInfo[];
  fetchedAtMs: number;
  expiresAtMs: number;
  revision: number;
  lastError?: CodexAppInventoryCacheDiagnostic;
};

export type CodexAppInventoryReadState = "fresh" | "stale" | "missing";

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
};

export class CodexAppInventoryCache {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CodexAppInventorySnapshot>>();
  private readonly refreshTokens = new Map<string, number>();
  private readonly diagnostics = new Map<string, CodexAppInventoryCacheDiagnostic>();
  private revision = 0;

  constructor(options: { ttlMs?: number } = {}) {
    this.ttlMs = options.ttlMs ?? CODEX_APP_INVENTORY_CACHE_TTL_MS;
  }

  read(params: RefreshParams): CodexAppInventoryCacheRead {
    const nowMs = params.nowMs ?? Date.now();
    const entry = this.entries.get(params.key);
    if (!entry) {
      const refreshScheduled = this.scheduleRefresh(params);
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
      entry.invalidated || entry.expiresAtMs <= nowMs ? "stale" : "fresh";
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

  refreshNow(params: RefreshParams): Promise<CodexAppInventorySnapshot> {
    return this.refresh(params);
  }

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

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.refreshTokens.clear();
    this.diagnostics.clear();
    this.revision = 0;
  }

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
    const nowMs = params.nowMs ?? Date.now();
    try {
      const apps = await listAllApps(params.request, params.forceRefetch ?? false);
      this.revision += 1;
      const snapshot: CodexAppInventorySnapshot = {
        key: params.key,
        apps,
        fetchedAtMs: nowMs,
        expiresAtMs: nowMs + this.ttlMs,
        revision: this.revision,
      };
      if (this.refreshTokens.get(params.key) === refreshToken) {
        this.entries.set(params.key, { ...snapshot, invalidated: false });
        this.diagnostics.delete(params.key);
      }
      return snapshot;
    } catch (error) {
      const diagnostic = {
        message: error instanceof Error ? error.message : String(error),
        atMs: nowMs,
      };
      this.diagnostics.set(params.key, diagnostic);
      const entry = this.entries.get(params.key);
      if (entry) {
        entry.lastError = diagnostic;
      }
      throw error;
    }
  }
}

export const defaultCodexAppInventoryCache = new CodexAppInventoryCache();

export function buildCodexAppInventoryCacheKey(input: CodexAppInventoryCacheKeyInput): string {
  return JSON.stringify({
    codexHome: input.codexHome ?? null,
    endpoint: input.endpoint ?? null,
    authProfileId: input.authProfileId ?? null,
    accountId: input.accountId ?? null,
    envApiKeyFingerprint: input.envApiKeyFingerprint ?? null,
    appServerVersion: input.appServerVersion ?? null,
  });
}

async function listAllApps(
  request: CodexAppInventoryRequest,
  forceRefetch: boolean,
): Promise<v2.AppInfo[]> {
  const apps: v2.AppInfo[] = [];
  let cursor: string | null | undefined;
  do {
    const response = await request("app/list", {
      cursor,
      limit: 100,
      forceRefetch,
    });
    apps.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);
  return apps;
}

function stripEntryState(entry: CacheEntry): CodexAppInventorySnapshot {
  const { invalidated: _invalidated, ...snapshot } = entry;
  return snapshot;
}
