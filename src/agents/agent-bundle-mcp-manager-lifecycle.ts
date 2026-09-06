/** Session MCP runtime manager lifecycle: maps, idle sweep, dispose, advertised catalog. */
import { AsyncLocalStorage } from "node:async_hooks";
import { logWarn } from "../logger.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
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
  RequesterScopedMcpRuntimeHandle,
  SessionMcpConfigReload,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

// Gateway shutdown preparation and CLI command imports load this before turns.
// The process-owned sweep must not retain its first requesting turn.
const runInMcpManagerContext = AsyncLocalStorage.snapshot();

export type SessionMcpConfigPublication = SessionMcpConfigReload & { pluginGeneration: number };

type AdvertisedScopedCatalogEntry = {
  configFingerprint: string;
  servers: Map<string, McpServerCatalog>;
  toolsByServer: Map<string, McpCatalogTool[]>;
  signaturesByServer: Map<string, string>;
};

type SessionMcpRuntimeManagerStore = {
  configReload?: SessionMcpConfigPublication;
  runtimesBySessionId: Map<string, SessionMcpRuntime>;
  sessionIdBySessionKey: Map<string, string>;
  deferredRetirementSessionIds: Set<string>;
  // Reset/delete retirement survives late creation or reuse by the stopping run.
  requiredRetirementSessionIds: Set<string>;
  connectionMetaByRuntimeKey: Map<string, { connectionHash: string; resolvedAt: number }>;
  advertisedScopedCatalogBySessionId: Map<string, AdvertisedScopedCatalogEntry>;
  runtimeWorkChains: Map<string, Promise<unknown>>;
  disposalInFlight?: Promise<void>;
  pendingDisposals: Map<string, Set<Promise<void>>>;
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
    deferredRetirementSessionIds: new Set<string>(),
    requiredRetirementSessionIds: new Set<string>(),
    // Manager-side only: connection hash + resolve time. Never stores raw url/headers.
    connectionMetaByRuntimeKey: new Map(),
    /**
     * Session-stable advertised catalogs for requester-scoped servers.
     * Keyed by sessionId → serverName. Specs must not vary per sender or shared
     * Codex threads rotate (dynamicToolsFingerprint churn).
     */
    advertisedScopedCatalogBySessionId: new Map(),
    /**
     * Per-runtimeKey serialization for acquisition and dispose.
     * Sections never overlap for one key, so a slow resolve cannot clobber a newer install.
     * Entries are removed when their chain drains.
     */
    runtimeWorkChains: new Map(),
    pendingDisposals: new Map(),
    createRuntime: opts.createRuntime ?? createSessionMcpRuntime,
    now: opts.now ?? Date.now,
    idleSweepIntervalMs: opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
    maxIdleRequesterRuntimes:
      opts.maxIdleRequesterRuntimesPerSession ?? SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES,
    enableIdleSweepTimer: opts.enableIdleSweepTimer !== false,
    idleSweepTimer: undefined,
    idleSweepInFlight: undefined,
  };
}

export type SessionMcpRuntimeManagerLifecycle = ReturnType<
  typeof createSessionMcpRuntimeManagerLifecycle
>;

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

export function createSessionMcpRuntimeManagerLifecycle(store: SessionMcpRuntimeManagerStore) {
  const disposeRuntime = async (runtime: SessionMcpRuntime) => {
    try {
      await runtime.dispose();
      if (!runtime.joinCleanup) {
        throw new Error("MCP runtime does not expose cleanup ownership");
      }
      await runtime.joinCleanup();
    } catch (error) {
      recordAgentCleanupFailure();
      throw error;
    }
  };
  const trackDisposal = (runtimeKeys: string[], close: () => Promise<void>): Promise<void> => {
    const disposal = Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        recordAgentCleanupFailure();
        throw error;
      })
      .finally(() => {
        for (const runtimeKey of runtimeKeys) {
          const pending = store.pendingDisposals.get(runtimeKey);
          pending?.delete(disposal);
          if (pending?.size === 0) {
            store.pendingDisposals.delete(runtimeKey);
          }
        }
      });
    for (const runtimeKey of runtimeKeys) {
      const pending = store.pendingDisposals.get(runtimeKey) ?? new Set<Promise<void>>();
      store.pendingDisposals.set(runtimeKey, pending);
      pending.add(disposal);
    }
    return disposal;
  };
  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of store.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        store.sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const runtimeKeysForSessionId = (sessionId: string): string[] => {
    const keys = new Set<string>();
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      if (runtime.sessionId === sessionId) {
        keys.add(runtimeKey);
      }
    }
    for (const runtimeKey of store.runtimeWorkChains.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        keys.add(runtimeKey);
      }
    }
    return [...keys];
  };

  const totalActiveLeasesForSessionId = (sessionId: string): number => {
    let total = 0;
    for (const runtimeKey of runtimeKeysForSessionId(sessionId)) {
      total += store.runtimesBySessionId.get(runtimeKey)?.activeLeases ?? 0;
    }
    return total;
  };

  const runExclusiveOnRuntimeKeys = <T>(
    runtimeKeys: string[],
    work: () => Promise<T>,
  ): Promise<T> => {
    const previous = runtimeKeys
      .map((key) => store.runtimeWorkChains.get(key))
      .filter((pending) => pending !== undefined);
    const run = Promise.allSettled(previous).then(work);
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    for (const key of runtimeKeys) {
      store.runtimeWorkChains.set(key, settled);
    }
    void settled.finally(() => {
      for (const key of runtimeKeys) {
        if (store.runtimeWorkChains.get(key) === settled) {
          store.runtimeWorkChains.delete(key);
        }
      }
    });
    return run;
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = store.now();
    const expired: Array<{ runtimeKey: string; runtime: SessionMcpRuntime }> = [];
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      if ((runtime.activeLeases ?? 0) > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS) {
        continue;
      }
      // Acquisition runs outside the runtime lease. Keep its current
      // transport until the chain records the refreshed runtime.
      if (store.runtimeWorkChains.has(runtimeKey)) {
        continue;
      }
      store.runtimesBySessionId.delete(runtimeKey);
      store.connectionMetaByRuntimeKey.delete(runtimeKey);
      expired.push({ runtimeKey, runtime });
    }
    const touchedSessionIds = new Set(expired.map(({ runtime }) => runtime.sessionId));
    for (const sessionId of touchedSessionIds) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        store.deferredRetirementSessionIds.delete(sessionId);
        forgetSessionKeysForSessionId(sessionId);
      }
    }
    await Promise.allSettled(
      expired.map(({ runtimeKey, runtime }) =>
        trackDisposal([runtimeKey], () => disposeRuntime(runtime)),
      ),
    );
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
      // Do not queue opportunistic eviction behind active requester work: that
      // would dispose the runtime the work just refreshed.
      if (store.runtimeWorkChains.has(runtimeKey)) {
        continue;
      }
      // Claim the idle key before yielding so later requester work follows disposal.
      await runExclusiveOnRuntimeKeys([runtimeKey], async () => {
        const current = store.runtimesBySessionId.get(runtimeKey);
        if (current !== runtime || (current.activeLeases ?? 0) > 0) {
          return;
        }
        store.runtimesBySessionId.delete(runtimeKey);
        store.connectionMetaByRuntimeKey.delete(runtimeKey);
        await Promise.allSettled([trackDisposal([runtimeKey], () => disposeRuntime(current))]);
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
    store.idleSweepTimer = runInMcpManagerContext(() =>
      setInterval(queueIdleSweep, store.idleSweepIntervalMs),
    );
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
    const runtime = store.runtimesBySessionId.get(runtimeKey);
    store.runtimesBySessionId.delete(runtimeKey);
    store.connectionMetaByRuntimeKey.delete(runtimeKey);
    if (runtime) {
      await disposeRuntime(runtime);
    }
  };

  const disposeManagedRuntimes = (
    sessionId?: string,
    opts?: { preserveRequiredRetirement?: boolean },
  ): Promise<void> => {
    const runtimeKeys = [
      ...new Set(
        sessionId === undefined
          ? [
              ...store.runtimesBySessionId.keys(),
              ...store.runtimeWorkChains.keys(),
              ...store.pendingDisposals.keys(),
            ]
          : [
              sessionId,
              ...runtimeKeysForSessionId(sessionId),
              ...[...store.pendingDisposals.keys()].filter(
                (key) => parseRuntimeCacheSessionId(key) === sessionId,
              ),
            ],
      ),
    ];
    // Capture before queuing: the previous owner may unpublish and settle before
    // this caller enters the runtime-key chain, but its receipt still belongs here.
    const previousDisposals = new Set(
      runtimeKeys.flatMap((key) => [...(store.pendingDisposals.get(key) ?? [])]),
    );
    const priorDisposal = store.disposalInFlight;
    const queued = runExclusiveOnRuntimeKeys(runtimeKeys, async () => {
      await priorDisposal;
      // Clear bookkeeping after admitted acquisitions finish, before successors run.
      if (sessionId === undefined) {
        clearIdleSweepTimer();
        store.configReload = undefined;
        store.sessionIdBySessionKey.clear();
        store.deferredRetirementSessionIds.clear();
        store.requiredRetirementSessionIds.clear();
        store.advertisedScopedCatalogBySessionId.clear();
      } else {
        store.deferredRetirementSessionIds.delete(sessionId);
        if (opts?.preserveRequiredRetirement !== true) {
          store.requiredRetirementSessionIds.delete(sessionId);
        }
        store.advertisedScopedCatalogBySessionId.delete(sessionId);
        forgetSessionKeysForSessionId(sessionId);
      }
      const outcomes = await Promise.allSettled([
        ...previousDisposals,
        ...runtimeKeys.map(disposeRuntimeKeyNow),
      ]);
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    });
    const disposal = trackDisposal(runtimeKeys, () => queued).catch(() => undefined);
    if (sessionId === undefined) {
      // New session keys also wait for a global teardown already in progress.
      store.disposalInFlight = disposal;
    }
    return disposal.finally(() => {
      if (store.disposalInFlight === disposal) {
        store.disposalInFlight = undefined;
      }
    });
  };

  const rememberAdvertisedScopedCatalog = (
    handle: RequesterScopedMcpRuntimeHandle,
    catalog: McpToolCatalog,
  ): void => {
    const { runtime, advertisedCatalogConfigFingerprint } = handle;
    // An older requester may finish after reconciliation; reject its catalog
    // instead of allowing stale tools to repopulate the session cache.
    const entry = store.advertisedScopedCatalogBySessionId.get(runtime.sessionId);
    if (
      entry?.configFingerprint !== advertisedCatalogConfigFingerprint ||
      sessionMcpRuntimeOwners.get(runtime)?.isCurrent() === false ||
      ![...store.runtimesBySessionId.values()].includes(runtime)
    ) {
      return;
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

  const reconcileAdvertisedScopedCatalogConfig = (
    sessionId: string,
    fingerprint: string,
    preparePublication: boolean,
  ): void => {
    const current = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (current?.configFingerprint === fingerprint || (!current && !preparePublication)) {
      return;
    }
    store.advertisedScopedCatalogBySessionId.set(sessionId, {
      configFingerprint: fingerprint,
      servers: new Map(),
      toolsByServer: new Map(),
      signaturesByServer: new Map(),
    });
  };

  return {
    store,
    runtimeKeysForSessionId,
    totalActiveLeasesForSessionId,
    runExclusiveOnRuntimeKeys,
    sweepIdleRuntimes,
    enforceRequesterRuntimeCap,
    ensureIdleSweepTimer,
    disposeRuntimeKeyNow,
    disposeManagedRuntimes,
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
    reconcileAdvertisedScopedCatalogConfig,
  };
}
