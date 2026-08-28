/** Session MCP runtime manager: get-or-create and requester-scoped install orchestration. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import {
  createCombinedSessionMcpRuntime,
  isCombinedSessionMcpRuntime,
} from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntimeManagerInstall } from "./agent-bundle-mcp-manager-install.js";
import {
  createSessionMcpRuntimeManagerLifecycle,
  createSessionMcpRuntimeManagerStore,
  type SessionMcpRuntimeManagerOpts,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime, SessionMcpRuntimeManager } from "./agent-bundle-mcp-types.js";
import { revokeMcpAppModelContext } from "./mcp-app-model-context.js";
import {
  buildMcpRequesterRuntimeCacheKey,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";

/** Bound from agent-bundle-mcp-runtime.ts to avoid an import cycle with the facade. */
let defaultCreateSessionMcpRuntime: CreateSessionMcpRuntime | undefined;

export function setDefaultCreateSessionMcpRuntime(fn: CreateSessionMcpRuntime): void {
  defaultCreateSessionMcpRuntime = fn;
}

function resolveCreateSessionMcpRuntime(
  createRuntime?: CreateSessionMcpRuntime,
): CreateSessionMcpRuntime {
  const resolved = createRuntime ?? defaultCreateSessionMcpRuntime;
  if (!resolved) {
    throw new Error("Session MCP runtime factory is not bound");
  }
  return resolved;
}

export function createSessionMcpRuntimeManager(
  opts: SessionMcpRuntimeManagerOpts = {},
): SessionMcpRuntimeManager {
  const store = createSessionMcpRuntimeManagerStore(
    opts,
    resolveCreateSessionMcpRuntime(opts.createRuntime),
  );
  const lifecycle = createSessionMcpRuntimeManagerLifecycle(store);
  const install = createSessionMcpRuntimeManagerInstall(lifecycle);
  const materializeRequesterScopedRuntime = async (
    params: Parameters<SessionMcpRuntimeManager["getOrCreate"]>[0] & {
      mcpServers: Record<string, BundleMcpServerConfig>;
      oauthRequesterServerNames: readonly string[];
      resolverRequesterServerNames: readonly string[];
      scopedNameSet: ReadonlySet<string>;
      safeServerNamesByServer: ReadonlyMap<string, string>;
      requesterSenderId: string;
    },
  ) => {
    const oauthRequesterNameSet = new Set(params.oauthRequesterServerNames);
    const resolverRequesterNameSet = new Set(params.resolverRequesterServerNames);
    const agentAccountId = normalizeOptionalString(params.agentAccountId);
    const messageChannel = normalizeOptionalString(params.messageChannel);
    const runtimeKey = buildMcpRequesterRuntimeCacheKey({
      sessionId: params.sessionId,
      messageChannel,
      agentAccountId,
      requesterSenderId: params.requesterSenderId,
    });
    const fullScopedFingerprint = loadSessionMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      logDiagnostics: false,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: params.scopedNameSet,
      redactConnectionServerNames: resolverRequesterNameSet,
      safeServerNamesByServer: params.safeServerNamesByServer,
      toolOverrides: params.toolOverrides,
    }).fingerprint;
    const runtime = await lifecycle.runExclusiveOnRuntimeKey(runtimeKey, () =>
      install.resolveAndInstallRequesterRuntime({
        ...params,
        runtimeKey,
        fullScopedFingerprint,
        oauthRequesterNameSet,
        agentAccountId,
        messageChannel,
        requesterScope: {
          requesterSenderId: params.requesterSenderId,
          ...(agentAccountId ? { agentAccountId } : {}),
          ...(messageChannel ? { messageChannel } : {}),
        },
      }),
    );
    return { runtimeKey, runtime };
  };

  const manager: SessionMcpRuntimeManager = {
    async getOrCreate(params) {
      await lifecycle.sweepIdleRuntimes();
      lifecycle.ensureIdleSweepTimer();
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }

      const configParams = {
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        toolOverrides: params.toolOverrides,
      };
      const fullConfig = loadSessionMcpConfig(configParams);
      // Safe names from the FULL declared set so partial resolution never changes tool names.
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const {
        staticServers,
        requesterScopedServerNames,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
      } = partitionMcpServersByConnectionScope(fullConfig.loaded.mcpServers);
      const hasRequesterScoped = requesterScopedServerNames.length > 0;
      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      lifecycle.reconcileAdvertisedScopedCatalogConfig(
        params.sessionId,
        loadSessionMcpConfig({
          ...configParams,
          loaded: fullConfig.loaded,
          redactConnectionServerNames: new Set(requesterScopedServerNames),
          safeServerNamesByServer,
        }).fingerprint,
        hasRequesterScoped && requesterSenderId !== undefined,
      );

      if (!hasRequesterScoped) {
        return await install.getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          safeServerNamesByServer,
          toolOverrides: params.toolOverrides,
        });
      }

      const parts: SessionMcpRuntime[] = [];
      const scopedNameSet = new Set(requesterScopedServerNames);
      let emptyStaticRuntime: SessionMcpRuntime | undefined;
      if (Object.keys(staticServers).length > 0) {
        parts.push(
          await install.getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            excludeServerNames: scopedNameSet,
            safeServerNamesByServer,
            toolOverrides: params.toolOverrides,
          }),
        );
      } else {
        // Reconcile bare key when every server is requester-scoped.
        emptyStaticRuntime = await install.getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          includeServerNames: new Set(),
          safeServerNamesByServer,
          toolOverrides: params.toolOverrides,
        });
      }

      if (requesterSenderId) {
        const { runtimeKey, runtime: scopedRuntime } = await materializeRequesterScopedRuntime({
          ...params,
          mcpServers: fullConfig.loaded.mcpServers,
          oauthRequesterServerNames,
          resolverRequesterServerNames,
          scopedNameSet,
          safeServerNamesByServer,
          requesterSenderId,
        });
        if (scopedRuntime) {
          parts.push(scopedRuntime);
        }
        await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
      }

      if (parts.length === 0) {
        return (
          emptyStaticRuntime ??
          (await install.getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            includeServerNames: new Set(),
            safeServerNamesByServer,
            toolOverrides: params.toolOverrides,
          }))
        );
      }

      return createCombinedSessionMcpRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        parts,
      });
    },
    async getOrCreateRequesterScoped(params) {
      // Anonymous turns own no requester runtime; reconcile first so a cached
      // catalog cannot survive a senderless harness turn.
      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      const configParams = {
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        toolOverrides: params.toolOverrides,
      };
      const fullConfig = loadSessionMcpConfig(configParams);
      const {
        requesterScopedServerNames,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
      } = partitionMcpServersByConnectionScope(fullConfig.loaded.mcpServers);
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const advertisedCatalogConfigFingerprint = loadSessionMcpConfig({
        ...configParams,
        loaded: fullConfig.loaded,
        redactConnectionServerNames: new Set(requesterScopedServerNames),
        safeServerNamesByServer,
      }).fingerprint;
      lifecycle.reconcileAdvertisedScopedCatalogConfig(
        params.sessionId,
        advertisedCatalogConfigFingerprint,
        requesterSenderId !== undefined && requesterScopedServerNames.length > 0,
      );
      if (!requesterSenderId) {
        return undefined;
      }
      await lifecycle.sweepIdleRuntimes();
      lifecycle.ensureIdleSweepTimer();
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const scopedNameSet = new Set(requesterScopedServerNames);
      const { runtimeKey, runtime } = await materializeRequesterScopedRuntime({
        ...params,
        mcpServers: fullConfig.loaded.mcpServers,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
        scopedNameSet,
        safeServerNamesByServer,
        requesterSenderId,
      });
      if (!runtime) {
        return undefined;
      }
      await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
      return { runtime, advertisedCatalogConfigFingerprint };
    },
    rememberAdvertisedScopedCatalog: lifecycle.rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog: lifecycle.getAdvertisedScopedCatalog,
    bindSessionKey(sessionKey, sessionId) {
      store.sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return store.sessionIdBySessionKey.get(sessionKey);
    },
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? store.sessionIdBySessionKey.get(params.sessionKey) : undefined);
      return sessionId ? store.runtimesBySessionId.get(sessionId) : undefined;
    },
    async disposeSession(sessionId) {
      await lifecycle.disposeManagedSession(sessionId);
    },
    deferRetirement(sessionId, retirementOpts) {
      if (retirementOpts?.retainAcrossReuse === true) {
        for (const runtimeKey of lifecycle.runtimeKeysForSessionId(sessionId)) {
          const runtime = store.runtimesBySessionId.get(runtimeKey);
          if (runtime) {
            revokeMcpAppModelContext(runtime);
          }
        }
      }
      if (retirementOpts?.retainAcrossReuse === true) {
        store.requiredRetirementSessionIds.add(sessionId);
      } else {
        store.requiredRetirementSessionIds.delete(sessionId);
      }
      if (
        lifecycle.runtimeKeysForSessionId(sessionId).length === 0 &&
        retirementOpts?.retainAcrossReuse !== true
      ) {
        return false;
      }
      store.deferredRetirementSessionIds.add(sessionId);
      return true;
    },
    async completeDeferredRetirement(sessionId, runtime) {
      if (
        !store.deferredRetirementSessionIds.has(sessionId) ||
        (runtime !== undefined && runtime.sessionId !== sessionId)
      ) {
        return false;
      }
      if (
        lifecycle.totalActiveLeasesForSessionId(sessionId) > 0 ||
        (runtime?.activeLeases ?? 0) > 0
      ) {
        return false;
      }
      const managed = lifecycle
        .runtimeKeysForSessionId(sessionId)
        .map((runtimeKey) => store.runtimesBySessionId.get(runtimeKey))
        .filter((entry): entry is SessionMcpRuntime => Boolean(entry));
      if (managed.length === 0) {
        return false;
      }
      const managedSet = new Set(managed);
      if (runtime !== undefined) {
        if (isCombinedSessionMcpRuntime(runtime)) {
          if (!runtime.managedParts.every((part) => managedSet.has(part))) {
            return false;
          }
        } else if (!managedSet.has(runtime)) {
          return false;
        }
      }
      await lifecycle.disposeManagedSession(sessionId, {
        preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
      });
      return true;
    },
    async disposeAll() {
      lifecycle.clearIdleSweepTimer();
      // Drain all requester chains before clearing maps.
      const chains = Array.from(store.requesterWorkChains.values());
      store.requesterWorkChains.clear();
      await Promise.allSettled(chains);
      const inFlightRuntimes = Array.from(store.createInFlight.values());
      store.createInFlight.clear();
      const runtimes = Array.from(store.runtimesBySessionId.values());
      store.runtimesBySessionId.clear();
      store.sessionIdBySessionKey.clear();
      store.deferredRetirementSessionIds.clear();
      store.requiredRetirementSessionIds.clear();
      store.connectionMetaByRuntimeKey.clear();
      store.advertisedScopedCatalogBySessionId.clear();
      const lateRuntimes = await Promise.all(
        inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionMcpRuntime>(runtimes);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
    },
    sweepIdleRuntimes: lifecycle.sweepIdleRuntimes,
    listSessionIds() {
      return [
        ...new Set(Array.from(store.runtimesBySessionId.values(), (runtime) => runtime.sessionId)),
      ].toSorted((a, b) => a.localeCompare(b));
    },
    listRuntimeKeys() {
      return Array.from(store.runtimesBySessionId.keys()).toSorted((a, b) => a.localeCompare(b));
    },
    totalActiveLeasesForSession(sessionId) {
      return lifecycle.totalActiveLeasesForSessionId(sessionId);
    },
  };
  // Test-only bookkeeping snapshot for drain assertions.
  Object.assign(manager, {
    bookkeepingSizesForTest: () => ({
      runtimes: store.runtimesBySessionId.size,
      connectionMeta: store.connectionMetaByRuntimeKey.size,
      createInFlight: store.createInFlight.size,
      requesterWorkChains: store.requesterWorkChains.size,
      sessionKeys: store.sessionIdBySessionKey.size,
      deferredRetirement: store.deferredRetirementSessionIds.size,
      advertisedScopedCatalogs: store.advertisedScopedCatalogBySessionId.size,
    }),
  });
  return manager;
}
