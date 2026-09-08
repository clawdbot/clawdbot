/** Session MCP runtime manager: acquisition and requester-scoped install orchestration. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { createSessionMcpRuntimeManagerInstall } from "./agent-bundle-mcp-manager-install.js";
import {
  createSessionMcpRuntimeManagerLifecycle,
  createSessionMcpRuntimeManagerStore,
  type SessionMcpRuntimeManagerOpts,
  type SessionMcpConfigPublication,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import {
  resolveSessionMcpRuntimeIdleTtlMs,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { revokeMcpAppModelContext } from "./mcp-app-model-context.js";
import {
  buildMcpRequesterRuntimeCacheKey,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";

type RuntimeAcquisitionParams = Parameters<SessionMcpRuntimeManager["acquire"]>[0];
type PreparedAcquisitionParams = RuntimeAcquisitionParams & {
  requester?: { runtimeKey: string; senderId: string };
};

const sessionMcpRuntimeLoader = createLazyImportLoader(
  () => import("./agent-bundle-mcp-runtime.js"),
);

// Peeking and retiring sessions need the manager, not its transport implementation.
const createSessionMcpRuntimeLazy: CreateSessionMcpRuntime = async (params) => {
  const runtime = await sessionMcpRuntimeLoader.load();
  return runtime.createSessionMcpRuntime(params);
};

export function createSessionMcpRuntimeManager(
  opts: SessionMcpRuntimeManagerOpts = {},
): SessionMcpRuntimeManager {
  const store = createSessionMcpRuntimeManagerStore(opts, createSessionMcpRuntimeLazy);
  const lifecycle = createSessionMcpRuntimeManagerLifecycle(store);
  const install = createSessionMcpRuntimeManagerInstall(lifecycle);
  const leaseRuntime = (runtime: SessionMcpRuntime): SessionMcpRuntimeLease => ({
    runtime,
    releaseLease: runtime.acquireLease?.() ?? (() => {}),
  });
  const acquireCurrent = <T extends SessionMcpRuntimeLease | undefined>(
    scope: "full" | "requester",
    acquire: (params: PreparedAcquisitionParams) => Promise<T>,
  ) =>
    async function current(params: RuntimeAcquisitionParams): Promise<T> {
      const senderId = normalizeOptionalString(params.requesterSenderId);
      const requester = senderId
        ? {
            senderId,
            runtimeKey: buildMcpRequesterRuntimeCacheKey({
              ...params,
              requesterSenderId: senderId,
            }),
          }
        : undefined;
      const runtimeKeys = requester ? [requester.runtimeKey] : [];
      if (scope === "full" || !requester) {
        runtimeKeys.push(params.sessionId);
      }
      const priorDisposal = store.disposalInFlight;
      const priorSessionWork = store.runtimeWorkChains.get(params.sessionId);
      const input: PreparedAcquisitionParams = { ...params, requester };
      let publication = store.configReload;
      let acquired: T | undefined;
      try {
        // Reserve every possible partition before yielding, including requester
        // keys a crossed publication may add. Teardown drains this entire admission.
        return await lifecycle.runExclusiveOnRuntimeKeys(runtimeKeys, async () => {
          await Promise.all([priorDisposal, priorSessionWork].filter((work) => work !== undefined));
          for (;;) {
            const next = store.configReload;
            // A publication can cross queued admission before a producer starts.
            if (next && next !== publication) {
              Object.assign(input, { cfg: next.cfg, manifestRegistry: next.manifestRegistry });
            }
            publication = next;
            const previous = acquired;
            acquired = await acquire(input);
            // Keep one hidden lease until its successor owns unchanged transports.
            previous?.releaseLease();
            if (!store.configReload || store.configReload === publication) {
              return acquired;
            }
          }
        });
      } catch (error) {
        acquired?.releaseLease();
        acquired = undefined;
        throw error;
      } finally {
        // Retirement may wait for this queue; complete it only after leaving it.
        if (!acquired) {
          await manager.completeDeferredRetirement(params.sessionId);
        }
      }
    };
  const prepareAcquisition = (params: PreparedAcquisitionParams) => {
    const fullConfig = loadSessionMcpConfig({ ...params, logDiagnostics: false });
    const partition = partitionMcpServersByConnectionScope(fullConfig.loaded.mcpServers);
    // Full-set names stay stable when only some requester connections resolve.
    const safeServerNamesByServer = assignSafeServerNames(
      Object.keys(fullConfig.loaded.mcpServers),
    );
    const advertisedCatalogConfigFingerprint = loadSessionMcpConfig({
      ...params,
      loaded: fullConfig.loaded,
      logDiagnostics: false,
      redactConnectionServerNames: new Set(partition.requesterScopedServerNames),
      safeServerNamesByServer,
    }).fingerprint;
    lifecycle.reconcileAdvertisedScopedCatalogConfig(
      params.sessionId,
      advertisedCatalogConfigFingerprint,
      params.requester !== undefined && partition.requesterScopedServerNames.length > 0,
    );
    return {
      fullConfig,
      ...partition,
      safeServerNamesByServer,
      requester: params.requester,
      advertisedCatalogConfigFingerprint,
    };
  };
  const materializeRequesterScopedRuntime = async (
    params: RuntimeAcquisitionParams & {
      configReloadAtAdmission?: SessionMcpConfigPublication;
      mcpServers: Record<string, BundleMcpServerConfig>;
      oauthRequesterServerNames: readonly string[];
      resolverRequesterServerNames: readonly string[];
      scopedNameSet: ReadonlySet<string>;
      safeServerNamesByServer: ReadonlyMap<string, string>;
      requesterSenderId: string;
      runtimeKey: string;
    },
  ) => {
    const oauthRequesterNameSet = new Set(params.oauthRequesterServerNames);
    const resolverRequesterNameSet = new Set(params.resolverRequesterServerNames);
    const agentAccountId = normalizeOptionalString(params.agentAccountId);
    const messageChannel = normalizeOptionalString(params.messageChannel);
    const fullScopedFingerprint = loadSessionMcpConfig({
      ...params,
      logDiagnostics: false,
      includeServerNames: params.scopedNameSet,
      redactConnectionServerNames: resolverRequesterNameSet,
    }).fingerprint;
    const runtime = await install.resolveAndInstallRequesterRuntime({
      ...params,
      fullScopedFingerprint,
      oauthRequesterNameSet,
      agentAccountId,
      messageChannel,
      requesterScope: {
        requesterSenderId: params.requesterSenderId,
        ...(agentAccountId ? { agentAccountId } : {}),
        ...(messageChannel ? { messageChannel } : {}),
      },
    });
    return runtime ? leaseRuntime(runtime) : undefined;
  };

  const manager: SessionMcpRuntimeManager = {
    acquire: acquireCurrent("full", async (params) => {
      const configReloadAtAdmission = store.configReload;
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }

      const {
        fullConfig,
        staticServers,
        requesterScopedServerNames,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
        safeServerNamesByServer,
        requester,
      } = prepareAcquisition(params);

      const leases: SessionMcpRuntimeLease[] = [];
      try {
        const staticLease = leaseRuntime(
          await install.getOrCreateRuntimeEntry({
            ...params,
            runtimeKey: params.sessionId,
            configReloadAtAdmission,
            excludeServerNames: new Set(requesterScopedServerNames),
            safeServerNamesByServer,
          }),
        );
        leases.push(staticLease);
        if (requesterScopedServerNames.length === 0) {
          return staticLease;
        }
        const parts = Object.keys(staticServers).length > 0 ? [staticLease.runtime] : [];
        const scopedNameSet = new Set(requesterScopedServerNames);
        if (requester) {
          const lease = await materializeRequesterScopedRuntime({
            ...params,
            configReloadAtAdmission,
            mcpServers: fullConfig.loaded.mcpServers,
            oauthRequesterServerNames,
            resolverRequesterServerNames,
            scopedNameSet,
            safeServerNamesByServer,
            requesterSenderId: requester.senderId,
            runtimeKey: requester.runtimeKey,
          });
          if (lease) {
            leases.push(lease);
            parts.push(lease.runtime);
          }
        }
        return {
          runtime:
            parts.length === 0
              ? staticLease.runtime
              : createCombinedSessionMcpRuntime({
                  sessionId: params.sessionId,
                  sessionKey: params.sessionKey,
                  workspaceDir: params.workspaceDir,
                  agentDir: params.agentDir,
                  parts,
                }),
          releaseLease: () => leases.forEach((lease) => lease.releaseLease()),
        };
      } catch (error) {
        leases.forEach((lease) => lease.releaseLease());
        throw error;
      }
    }),
    acquireRequesterScoped: acquireCurrent("requester", async (params) => {
      const configReloadAtAdmission = store.configReload;
      // Anonymous turns own no requester runtime; reconcile first so a cached
      // catalog cannot survive a senderless harness turn.
      const {
        fullConfig,
        requesterScopedServerNames,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
        safeServerNamesByServer,
        requester,
        advertisedCatalogConfigFingerprint,
      } = prepareAcquisition(params);
      if (!requester) {
        return undefined;
      }
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const scopedNameSet = new Set(requesterScopedServerNames);
      const lease = await materializeRequesterScopedRuntime({
        ...params,
        configReloadAtAdmission,
        mcpServers: fullConfig.loaded.mcpServers,
        oauthRequesterServerNames,
        resolverRequesterServerNames,
        scopedNameSet,
        safeServerNamesByServer,
        requesterSenderId: requester.senderId,
        runtimeKey: requester.runtimeKey,
      });
      if (!lease) {
        return undefined;
      }
      return { ...lease, advertisedCatalogConfigFingerprint };
    }),
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
    disposeSession: lifecycle.disposeManagedRuntimes,
    deferRetirement(sessionId, retirementOpts) {
      if (retirementOpts?.retainAcrossReuse === true) {
        for (const runtimeKey of lifecycle.runtimeKeysForSessionId(sessionId)) {
          const runtime = store.runtimesBySessionId.get(runtimeKey);
          if (runtime) {
            revokeMcpAppModelContext(runtime);
          }
        }
        store.requiredRetirementSessionIds.add(sessionId);
      }
      if (
        lifecycle.runtimeKeysForSessionId(sessionId).length === 0 &&
        !store.requiredRetirementSessionIds.has(sessionId)
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
      const runtimeKeys = lifecycle.runtimeKeysForSessionId(sessionId);
      if (runtimeKeys.length === 0) {
        return false;
      }
      const pendingWork = runtimeKeys
        .map((runtimeKey) => store.runtimeWorkChains.get(runtimeKey))
        .filter((work) => work !== undefined);
      if (pendingWork.length > 0) {
        // Acquisition can clear ordinary intent or take a replacement lease.
        // Recheck after success or failure; neither may strand required retirement.
        await Promise.allSettled(pendingWork);
        return await manager.completeDeferredRetirement(sessionId, runtime);
      }
      // Retirement belongs to the session. Reuse clears ordinary intent; required
      // intent survives replacement and completes when its last transferred lease releases.
      await lifecycle.disposeManagedRuntimes(sessionId, {
        preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
      });
      return true;
    },
    async reloadConfig(reload) {
      store.configReload = {
        ...reload,
        pluginGeneration:
          (store.configReload?.pluginGeneration ?? 0) + (reload.reloadPlugins ? 1 : 0),
      };
      store.advertisedScopedCatalogBySessionId.clear();
      for (const runtime of store.runtimesBySessionId.values()) {
        const slot = store.runtimeSlots.get(runtime);
        if (slot) {
          slot.idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(reload.cfg);
        }
      }
      lifecycle.ensureIdleSweepTimer();
      // In-flight creation checks this publication before it can expose its runtime.
      await Promise.all(
        [...store.runtimesBySessionId].map(async ([runtimeKey, runtime]) => {
          const owner = sessionMcpRuntimeOwners.get(runtime);
          await owner?.reload(reload);
          if (owner?.hasServers() === false) {
            await lifecycle.releaseEmptyRuntimeSlot(runtimeKey, runtime);
          }
        }),
      );
    },
    disposeAll: () => lifecycle.disposeManagedRuntimes(),
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
      runtimeWorkChains: store.runtimeWorkChains.size,
      sessionKeys: store.sessionIdBySessionKey.size,
      deferredRetirement: store.deferredRetirementSessionIds.size,
      advertisedScopedCatalogs: store.advertisedScopedCatalogBySessionId.size,
    }),
  });
  return manager;
}
