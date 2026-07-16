/** Session MCP runtime manager lifecycle: maps, idle sweep, dispose, advertised catalog. */
import { logWarn } from "../logger.js";
import {
  DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS,
  SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES,
  SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

type ManagerCreateInFlight = {
  promise: Promise<SessionMcpRuntime>;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
};

type AdvertisedScopedCatalogEntry = {
  servers: Map<string, McpServerCatalog>;
  toolsByServer: Map<string, McpCatalogTool[]>;
  signaturesByServer: Map<string, string>;
};

type SessionMcpRuntimeManagerStore = {
  runtimesBySessionId: Map<string, SessionMcpRuntime>;
  sessionIdBySessionKey: Map<string, string>;
  idleTtlMsBySessionId: Map<string, number>;
  deferredRetirementSessionIds: Set<string>;
  connectionMetaByRuntimeKey: Map<string, { connectionHash: string; resolvedAt: number }>;
  advertisedScopedCatalogBySessionId: Map<string, AdvertisedScopedCatalogEntry>;
  requesterWorkChains: Map<string, Promise<unknown>>;
  createInFlight: Map<string, ManagerCreateInFlight>;
  createRuntime: CreateSessionMcpRuntime;
  now: () => number;
  idleSweepIntervalMs: number;
  maxIdleRequesterRuntimes: number;
  enableIdleSweepTimer: boolean;
  idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  idleSweepInFlight: Promise<void> | undefined;
};

export type SessionMcpRuntimeManagerOpts = {
  createRuntime?: CreateSessionMcpRuntime;
  now?: () => number;
  enableIdleSweepTimer?: boolean;
  idleSweepIntervalMs?: number;
  maxIdleRequesterRuntimesPerSession?: number;
};

function parseRuntimeCacheSessionId(runtimeKey: string): string {
  if (!runtimeKey.startsWith("{")) {
    return runtimeKey;
  }
  try {
    const parsed = JSON.parse(runtimeKey) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" ? parsed.sessionId : runtimeKey;
  } catch {
    return runtimeKey;
  }
}

export function createSessionMcpRuntimeManagerStore(
  opts: SessionMcpRuntimeManagerOpts,
  createSessionMcpRuntime: CreateSessionMcpRuntime,
): SessionMcpRuntimeManagerStore {
  return {
    // Keys are bare sessionId for static runtimes, or requester composite JSON keys.
    runtimesBySessionId: new Map<string, SessionMcpRuntime>(),
    sessionIdBySessionKey: new Map<string, string>(),
    idleTtlMsBySessionId: new Map<string, number>(),
    deferredRetirementSessionIds: new Set<string>(),
    // Manager-side only: connection hash + resolve time. Never stores raw url/headers.
    connectionMetaByRuntimeKey: new Map(),
    /**
     * Session-stable advertised catalogs for requester-scoped servers.
     * Keyed by sessionId → serverName. Specs must not vary per sender or shared
     * Codex threads rotate (dynamicToolsFingerprint churn).
     */
    advertisedScopedCatalogBySessionId: new Map(),
    /**
     * Per-runtimeKey serialization for requester resolve+install and dispose.
     * Sections never overlap for one key, so a slow resolve cannot clobber a newer install.
     * Entries are removed when their chain drains.
     */
    requesterWorkChains: new Map(),
    createRuntime: opts.createRuntime ?? createSessionMcpRuntime,
    now: opts.now ?? Date.now,
    // Static bare-sessionId create dedup only. Requester keys use requesterWorkChains exclusively.
    createInFlight: new Map(),
    idleSweepIntervalMs: opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
    maxIdleRequesterRuntimes:
      opts.maxIdleRequesterRuntimesPerSession ?? SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES,
    enableIdleSweepTimer: opts.enableIdleSweepTimer !== false,
    idleSweepTimer: undefined,
    idleSweepInFlight: undefined,
  };
}

export type SessionMcpRuntimeManagerLifecycle = {
  store: SessionMcpRuntimeManagerStore;
  forgetSessionKeysForSessionId: (sessionId: string) => void;
  runtimeKeysForSessionId: (sessionId: string) => string[];
  totalActiveLeasesForSessionId: (sessionId: string) => number;
  runExclusiveOnRuntimeKey: <T>(runtimeKey: string, work: () => Promise<T>) => Promise<T>;
  sweepIdleRuntimes: () => Promise<number>;
  enforceRequesterRuntimeCap: (sessionId: string, keepRuntimeKey: string) => Promise<void>;
  ensureIdleSweepTimer: () => void;
  clearIdleSweepTimer: () => void;
  disposeRuntimeKeyNow: (runtimeKey: string) => Promise<void>;
  disposeManagedSession: (sessionId: string) => Promise<void>;
  rememberAdvertisedScopedCatalog: (sessionId: string, catalog: McpToolCatalog) => void;
  getAdvertisedScopedCatalog: (sessionId: string) => McpToolCatalog | null;
};

function scopedCatalogToolsSignature(tools: readonly McpCatalogTool[]): string {
  return JSON.stringify(
    tools.map((tool) => [
      tool.serverName,
      tool.safeServerName,
      tool.toolName,
      tool.title ?? "",
      tool.description ?? "",
      tool.fallbackDescription,
      tool.inputSchema,
      tool.uiResourceUri ?? "",
      tool.uiVisibility ?? null,
    ]),
  );
}

export function createSessionMcpRuntimeManagerLifecycle(
  store: SessionMcpRuntimeManagerStore,
): SessionMcpRuntimeManagerLifecycle {
  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of store.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        store.sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const runtimeKeysForSessionId = (sessionId: string): string[] => {
    const keys: string[] = [];
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      if (runtime.sessionId === sessionId) {
        keys.push(runtimeKey);
      }
    }
    return keys;
  };

  const totalActiveLeasesForSessionId = (sessionId: string): number => {
    let total = 0;
    for (const runtimeKey of runtimeKeysForSessionId(sessionId)) {
      total += store.runtimesBySessionId.get(runtimeKey)?.activeLeases ?? 0;
    }
    return total;
  };

  const runExclusiveOnRuntimeKey = <T>(runtimeKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = store.requesterWorkChains.get(runtimeKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => work());
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    store.requesterWorkChains.set(runtimeKey, settled);
    void settled.finally(() => {
      if (store.requesterWorkChains.get(runtimeKey) === settled) {
        store.requesterWorkChains.delete(runtimeKey);
      }
    });
    return run;
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = store.now();
    const expired: SessionMcpRuntime[] = [];
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      const idleTtlMs =
        store.idleTtlMsBySessionId.get(runtimeKey) ??
        store.idleTtlMsBySessionId.get(runtime.sessionId) ??
        DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
      if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      store.runtimesBySessionId.delete(runtimeKey);
      store.idleTtlMsBySessionId.delete(runtimeKey);
      store.connectionMetaByRuntimeKey.delete(runtimeKey);
      expired.push(runtime);
    }
    const touchedSessionIds = new Set(expired.map((runtime) => runtime.sessionId));
    for (const sessionId of touchedSessionIds) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        store.deferredRetirementSessionIds.delete(sessionId);
        forgetSessionKeysForSessionId(sessionId);
      }
    }
    await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
    return expired.length;
  };

  /**
   * A busy shared channel can otherwise accumulate one live scoped runtime per
   * sender until the idle TTL fires. Evict LRU zero-lease requester runtimes
   * beyond the cap; leased runtimes and the bare static runtime never evict.
   */
  const enforceRequesterRuntimeCap = async (
    sessionId: string,
    keepRuntimeKey: string,
  ): Promise<void> => {
    const requesterKeys = runtimeKeysForSessionId(sessionId).filter(
      (runtimeKey) => runtimeKey !== sessionId,
    );
    const overflow = requesterKeys.length - store.maxIdleRequesterRuntimes;
    if (overflow <= 0) {
      return;
    }
    const evictable = requesterKeys
      .filter((runtimeKey) => runtimeKey !== keepRuntimeKey)
      .map((runtimeKey) => ({
        runtimeKey,
        runtime: store.runtimesBySessionId.get(runtimeKey),
      }))
      .filter(
        (entry): entry is { runtimeKey: string; runtime: SessionMcpRuntime } =>
          entry.runtime !== undefined && (entry.runtime.activeLeases ?? 0) === 0,
      )
      .toSorted((a, b) => a.runtime.lastUsedAt - b.runtime.lastUsedAt)
      .slice(0, overflow);
    for (const { runtimeKey, runtime } of evictable) {
      // Serialize with in-flight work on that key so eviction cannot clobber a
      // concurrent reuse or install for the same requester.
      await runExclusiveOnRuntimeKey(runtimeKey, async () => {
        const current = store.runtimesBySessionId.get(runtimeKey);
        if (current !== runtime || (current.activeLeases ?? 0) > 0) {
          return;
        }
        store.runtimesBySessionId.delete(runtimeKey);
        store.idleTtlMsBySessionId.delete(runtimeKey);
        store.connectionMetaByRuntimeKey.delete(runtimeKey);
        await current.dispose();
      });
    }
  };

  const queueIdleSweep = () => {
    if (store.idleSweepInFlight) {
      return;
    }
    store.idleSweepInFlight = sweepIdleRuntimes()
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
      })
      .finally(() => {
        store.idleSweepInFlight = undefined;
      });
  };

  const ensureIdleSweepTimer = () => {
    if (!store.enableIdleSweepTimer || store.idleSweepIntervalMs <= 0 || store.idleSweepTimer) {
      return;
    }
    store.idleSweepTimer = setInterval(queueIdleSweep, store.idleSweepIntervalMs);
    store.idleSweepTimer.unref?.();
  };

  const clearIdleSweepTimer = () => {
    if (!store.idleSweepTimer) {
      return;
    }
    clearInterval(store.idleSweepTimer);
    store.idleSweepTimer = undefined;
  };

  const disposeRuntimeKeyNow = async (runtimeKey: string): Promise<void> => {
    const inFlight = store.createInFlight.get(runtimeKey);
    store.createInFlight.delete(runtimeKey);
    let runtime = store.runtimesBySessionId.get(runtimeKey);
    if (!runtime && inFlight) {
      runtime = await inFlight.promise.catch(() => undefined);
    }
    store.runtimesBySessionId.delete(runtimeKey);
    store.idleTtlMsBySessionId.delete(runtimeKey);
    store.connectionMetaByRuntimeKey.delete(runtimeKey);
    if (runtime) {
      await runtime.dispose();
    }
  };

  const disposeManagedSession = async (sessionId: string): Promise<void> => {
    store.deferredRetirementSessionIds.delete(sessionId);
    store.advertisedScopedCatalogBySessionId.delete(sessionId);
    const runtimeKeys = new Set(runtimeKeysForSessionId(sessionId));
    for (const runtimeKey of store.createInFlight.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    for (const runtimeKey of store.requesterWorkChains.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    // Serialize disposal with in-flight requester work for composite keys.
    await Promise.allSettled(
      [...runtimeKeys].map((runtimeKey) =>
        runtimeKey.startsWith("{")
          ? runExclusiveOnRuntimeKey(runtimeKey, () => disposeRuntimeKeyNow(runtimeKey))
          : disposeRuntimeKeyNow(runtimeKey),
      ),
    );
    forgetSessionKeysForSessionId(sessionId);
  };

  const rememberAdvertisedScopedCatalog = (sessionId: string, catalog: McpToolCatalog): void => {
    let entry = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry) {
      entry = {
        servers: new Map(),
        toolsByServer: new Map(),
        signaturesByServer: new Map(),
      };
      store.advertisedScopedCatalogBySessionId.set(sessionId, entry);
    }
    const toolsByServerName = new Map<string, McpCatalogTool[]>();
    for (const tool of catalog.tools) {
      const list = toolsByServerName.get(tool.serverName) ?? [];
      list.push(tool);
      toolsByServerName.set(tool.serverName, list);
    }
    for (const [serverName, server] of Object.entries(catalog.servers)) {
      const tools = (toolsByServerName.get(serverName) ?? []).toSorted((a, b) =>
        a.toolName.localeCompare(b.toolName),
      );
      const signature = scopedCatalogToolsSignature(tools);
      // Identity compare: overwrite only when the listed tool surface changes.
      if (entry.signaturesByServer.get(serverName) === signature) {
        continue;
      }
      entry.servers.set(serverName, server);
      entry.toolsByServer.set(serverName, tools);
      entry.signaturesByServer.set(serverName, signature);
    }
  };

  const getAdvertisedScopedCatalog = (sessionId: string): McpToolCatalog | null => {
    const entry = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry || entry.servers.size === 0) {
      return null;
    }
    const servers: Record<string, McpServerCatalog> = {};
    const tools: McpCatalogTool[] = [];
    for (const serverName of [...entry.servers.keys()].toSorted((a, b) => a.localeCompare(b))) {
      servers[serverName] = entry.servers.get(serverName)!;
      tools.push(...(entry.toolsByServer.get(serverName) ?? []));
    }
    tools.sort((a, b) => {
      const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
      if (serverOrder !== 0) {
        return serverOrder;
      }
      return a.toolName.localeCompare(b.toolName);
    });
    return {
      version: 1,
      generatedAt: store.now(),
      servers,
      tools,
    };
  };

  return {
    store,
    forgetSessionKeysForSessionId,
    runtimeKeysForSessionId,
    totalActiveLeasesForSessionId,
    runExclusiveOnRuntimeKey,
    sweepIdleRuntimes,
    enforceRequesterRuntimeCap,
    ensureIdleSweepTimer,
    clearIdleSweepTimer,
    disposeRuntimeKeyNow,
    disposeManagedSession,
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
  };
}
