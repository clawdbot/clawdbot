import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/run-state.js";
import { clearSessionSuspensionTimers } from "../agents/session-suspension.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  onEffectiveOperatorDevicePaired,
  type EffectiveOperatorDeviceIdentity,
} from "../infra/device-pairing.js";
import { upsertPresence } from "../infra/system-presence.js";
import { stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime-state.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  removeRemoteNodeInfoForConnection,
} from "../skills/runtime/remote.js";
import type { RestartRecoveryCandidate } from "./chat-abort.js";
import { disposeNodeConnectionNotifications } from "./node-connection-notifications.js";
import { clearNodeWakeState } from "./node-wake-state.js";
import { createLazyGatewayCronState } from "./server-cron-lazy.js";
import { createGatewayCronReconciliation } from "./server-cron-reconciled.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState } from "./server-live-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  type GatewayCloseOptions,
  shouldRetainControlUiDeviceAuthMigrationSession,
} from "./server-public.js";
import type { prepareGatewayRuntimeState } from "./server-runtime-state-prepare.js";
import {
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";

type GatewayRuntimePreparation = Awaited<ReturnType<typeof prepareGatewayRuntimeState>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

export async function prepareGatewayLifecycle(params: {
  runtime: GatewayRuntimePreparation;
  port: number;
  log: GatewayLogger;
  logCron: GatewayLogger;
  diagnosticsEnabled: boolean;
  loadGatewayCloseModule: () => Promise<typeof import("./server-close.runtime.js")>;
  closeMcpLoopbackServerOnDemand: () => Promise<void>;
  stopTaskRegistryMaintenanceOnDemand: () => Promise<void>;
}) {
  const {
    runtime,
    port,
    log,
    logCron,
    diagnosticsEnabled,
    loadGatewayCloseModule,
    closeMcpLoopbackServerOnDemand,
    stopTaskRegistryMaintenanceOnDemand,
  } = params;
  const {
    controlUiDeviceAuthMigration,
    completeControlUiDeviceAuthMigration,
    workerGatewayEndpoint,
    getWorkerIngressEndpoint,
    sessionMessageSubscribers,
    clients,
    broadcast,
    cfgAtStart,
    pluginRuntime,
    authRateLimiter,
    nodeReapprovalCoordinator,
    channelManager,
    deps,
    initialHooksConfig,
    initialHookClientIpConfig,
    runtimeStateRef,
    gatewayInstanceRuntimeRef,
    startupState,
    readinessEventLoopHealth,
    releasePluginRouteRegistry,
    browserAuthRateLimiter,
    wss,
    httpServer,
    httpServers,
    chatRunState,
    chatAbortControllers,
    chatQueuedTurns,
    removeChatRun,
    agentRunSeq,
    listActiveGatewayMethods,
    broadcastToConnIds,
    getBufferedAmount,
    sessionEventSubscribers,
    watchNodeRequestHandler,
    defaultWorkspaceDir,
  } = runtime;
  const completeControlUiDeviceAuthMigrationForEffectiveOperator = (
    device: EffectiveOperatorDeviceIdentity,
  ) => {
    if (
      !controlUiDeviceAuthMigration.pending ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: ["operator.pairing"],
        allowedScopes: device.scopes,
      })
    ) {
      return;
    }
    const normalizedDeviceId = device.deviceId.trim();
    // Close the process-local grace immediately after approval. The durable
    // receipt prevents stale legacy config from reopening it.
    controlUiDeviceAuthMigration.pending = false;
    for (const client of clients) {
      if (!client.isControlUiDeviceAuthMigrationSession) {
        continue;
      }
      if (
        client.isControlUiDeviceAuthMigration &&
        shouldRetainControlUiDeviceAuthMigrationSession({
          sessionDevice: client.connect.device,
          approvedDevice: device,
        })
      ) {
        // Retention is bound to the approved key as well as its derived id.
        // Keep only that identity long enough to receive the approval response.
        continue;
      }
      client.invalidated = true;
      client.invalidatedReason = "device-auth-migration-completed";
      client.socket.close(4001, "device auth migration completed");
    }
    try {
      completeControlUiDeviceAuthMigration(normalizedDeviceId, { env: process.env });
    } catch (error) {
      log.warn(`failed to persist Control UI device-auth migration completion: ${String(error)}`);
    }
  };
  const unsubscribeEffectiveOperatorPairing = onEffectiveOperatorDevicePaired(
    completeControlUiDeviceAuthMigrationForEffectiveOperator,
  );
  workerGatewayEndpoint.resolve = getWorkerIngressEndpoint;
  const presenceWatchedSessions = (connId: string): string[] => {
    // Presence snapshots stay small even if a long-lived client accumulates
    // subscriptions. Keep only the 32 most recently subscribed session keys.
    return [...sessionMessageSubscribers.getForConnection(connId)].slice(-32).toSorted();
  };
  const updateWatchedSessionsPresence = (connId: string, previous: readonly string[]) => {
    const watchedSessions = presenceWatchedSessions(connId);
    if (
      watchedSessions.length === previous.length &&
      watchedSessions.every((key, index) => key === previous[index])
    ) {
      return;
    }
    const client = [...clients].find((candidate) => candidate.connId === connId);
    if (!client?.presenceKey) {
      return;
    }
    upsertPresence(client.presenceKey, {
      watchedSessions: watchedSessions.length > 0 ? watchedSessions : undefined,
    });
    broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
  };
  const subscribeSessionMessageEvents: GatewayRequestContext["subscribeSessionMessageEvents"] = (
    connId,
    sessionKey,
    options,
  ) => {
    const previous = presenceWatchedSessions(connId);
    const rollback = sessionMessageSubscribers.subscribe(connId, sessionKey, options);
    updateWatchedSessionsPresence(connId, previous);
    if (!rollback) {
      return undefined;
    }
    const rollbackPresence = (() => {
      const rollbackPrevious = presenceWatchedSessions(connId);
      rollback();
      updateWatchedSessionsPresence(connId, rollbackPrevious);
    }) as NonNullable<ReturnType<GatewayRequestContext["subscribeSessionMessageEvents"]>>;
    rollbackPresence.commit = () => rollback.commit();
    return rollbackPresence;
  };
  const unsubscribeSessionMessageEvents: GatewayRequestContext["unsubscribeSessionMessageEvents"] =
    (connId, sessionKey) => {
      const previous = presenceWatchedSessions(connId);
      sessionMessageSubscribers.unsubscribe(connId, sessionKey);
      updateWatchedSessionsPresence(connId, previous);
    };
  const restartRecoveryCandidates = new Map<string, RestartRecoveryCandidate>();
  const { createGatewayNodeSessionRuntime } = await import("./server-node-session-runtime.js");
  const {
    nodeRegistry,
    nodePresenceTimers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    hasTalkNodeConnected,
  } = createGatewayNodeSessionRuntime({
    broadcast,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    listRegisteredNodePluginToolCommands: () => pluginRuntime.registry.nodeHostCommands,
    nodePluginToolsEnabled: cfgAtStart.gateway?.nodes?.pluginTools?.enabled !== false,
    nodeSkillsEnabled: cfgAtStart.gateway?.nodes?.allowSkills !== false,
    onPairingInvalidated: ({ nodeId, connId }) => {
      upsertPresence(nodeId, { reason: "disconnect" });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      removeRemoteNodeInfoForConnection(nodeId, connId);
    },
  });
  const { createWatchNodeHttpRuntime } = await import("./watch-node-http.js");
  const watchNodeHttpRuntime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: getRuntimeConfig,
    broadcast,
    rateLimiter: authRateLimiter,
    nodeReapprovalCoordinator,
    onNodeConnected: (session) => {
      upsertPresence(session.nodeId, {
        host: session.displayName ?? session.clientId ?? session.nodeId,
        ip: session.remoteIp,
        version: session.version,
        platform: session.platform,
        deviceFamily: session.deviceFamily,
        modelIdentifier: session.modelIdentifier,
        mode: session.clientMode,
        deviceId: session.nodeId,
        roles: ["node"],
        scopes: [],
        instanceId: session.nodeId,
        reason: "connect",
      });
      incrementPresenceVersion();
      recordRemoteNodeInfo({
        nodeId: session.nodeId,
        connId: session.connId,
        displayName: session.displayName,
        platform: session.platform,
        deviceFamily: session.deviceFamily,
        commands: session.commands,
        remoteIp: session.remoteIp,
        pairingGeneration: session.pairingGeneration,
      });
    },
    onNodeDisconnected: (nodeId) => {
      upsertPresence(nodeId, { reason: "disconnect" });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      removeRemoteNodeInfo(nodeId);
      nodeUnsubscribeAll(nodeId);
      clearNodeWakeState(nodeId);
    },
    onError: (message, error) => log.warn(`${message}: ${String(error)}`),
  });
  watchNodeRequestHandler.current = watchNodeHttpRuntime.handleRequest;
  const { TerminalSessionManager, DEFAULT_TERMINAL_DETACH_SECONDS } =
    await import("./terminal/session-manager.js");
  const { createTerminalSessionTransport } = await import("./terminal/gateway-transport.js");
  const terminalSessions = new TerminalSessionManager({
    ...createTerminalSessionTransport(broadcastToConnIds, getBufferedAmount),
    detachGraceMs:
      (cfgAtStart.gateway?.terminal?.detachedSessionTimeoutSeconds ??
        DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
  });
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(cfgAtStart), { gatewayStart: true });

  runtimeStateRef.current = createGatewayServerLiveState({
    hooksConfig: initialHooksConfig,
    hookClientIpConfig: initialHookClientIpConfig,
    cronState: createLazyGatewayCronState({
      cfg: cfgAtStart,
      deps,
      broadcast,
    }),
    gatewayMethods: listActiveGatewayMethods(pluginRuntime.baseGatewayMethods),
  });
  const runtimeState = runtimeStateRef.current;
  deps.cron = runtimeState.cronState.cron;
  const pluginHostServices = {
    get cron() {
      return runtimeState.cronState.cron;
    },
  };

  const lifecycle = { closePreludeStarted: false };
  const cronReconciliation = createGatewayCronReconciliation({
    port,
    workspaceDir: defaultWorkspaceDir,
    isClosing: () => lifecycle.closePreludeStarted,
    runHook: async (event, ctx) => {
      try {
        const hookRunner = (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner();
        if (hookRunner?.hasHooks("cron_reconciled")) {
          await hookRunner.runCronReconciled(event, ctx);
        }
      } catch (err) {
        logCron.error(`cron_reconciled hook failed: ${String(err)}`);
      }
    },
  });
  const postReadyState: {
    maintenanceTimer: ReturnType<typeof setTimeout> | null;
    retainedPluginCleanupHandle: { stop: () => void } | null;
  } = {
    maintenanceTimer: null,
    retainedPluginCleanupHandle: null,
  };
  const clearPostReadyMaintenanceTimer = () => {
    if (!postReadyState.maintenanceTimer) {
      return;
    }
    clearTimeout(postReadyState.maintenanceTimer);
    postReadyState.maintenanceTimer = null;
  };
  const markClosePreludeStarted = () => {
    lifecycle.closePreludeStarted = true;
    unsubscribeEffectiveOperatorPairing();
    startupState.dispatchReady = false;
    gatewayInstanceRuntimeRef.current?.close();
    cronReconciliation.invalidate();
    clearPostReadyMaintenanceTimer();
    postReadyState.retainedPluginCleanupHandle?.stop();
    postReadyState.retainedPluginCleanupHandle = null;
  };
  let configReloaderStopPromise: Promise<void> | null = null;
  const stopConfigReloaderForClose = () => {
    configReloaderStopPromise ??= runtimeState.configReloader.stop();
    return configReloaderStopPromise;
  };
  const beginClosePrelude = async () => {
    clearSessionSuspensionTimers();
    markClosePreludeStarted();
    // Join the last reload before any owner it can publish into is torn down.
    // The close handler re-awaits this same promise to retain warning reporting.
    await stopConfigReloaderForClose().catch(() => {});
  };
  const runClosePrelude = async () => {
    await beginClosePrelude();
    disposeNodeConnectionNotifications(nodeRegistry);
    watchNodeHttpRuntime.close();
    clearPluginMetadataLifecycleCaches();
    const { runGatewayClosePrelude } = await loadGatewayCloseModule();
    await runGatewayClosePrelude({
      ...(diagnosticsEnabled ? { stopDiagnostics: stopDiagnosticHeartbeat } : {}),
      clearSkillsRefreshTimer: () => {
        if (!runtimeState?.skillsRefreshTimer) {
          return;
        }
        clearTimeout(runtimeState.skillsRefreshTimer);
        runtimeState.skillsRefreshTimer = null;
      },
      skillsChangeUnsub: runtimeState.skillsChangeUnsub,
      disposeAuthRateLimiter: () => {
        authRateLimiter.dispose();
        nodeReapprovalCoordinator.dispose();
      },
      disposeBrowserAuthRateLimiter: () => browserAuthRateLimiter.dispose(),
      stopModelPricingRefresh: runtimeState.stopModelPricingRefresh,
      stopChannelHealthMonitor: async () => {
        const monitor = runtimeState?.channelHealthMonitor;
        monitor?.shutdown();
        await monitor?.waitForIdle();
      },
      stopReadinessEventLoopHealth: readinessEventLoopHealth.stop,
      clearSecretsRuntimeSnapshot,
      closeMcpServer: closeMcpLoopbackServerOnDemand,
    });
  };
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (
    optsResult,
  ) =>
    refreshGatewayHealthSnapshot({
      ...optsResult,
      getRuntimeSnapshot,
      getEventLoopHealth: readinessEventLoopHealth.snapshot,
      getConfigReloaderHotReloadStatus: () => runtimeState?.configReloader.hotReloadStatus?.(),
    });
  const stopRegisteredPostReadySidecars = async () => {
    const postReadySidecars = runtimeState.postReadySidecars;
    runtimeState.postReadySidecars = [];
    for (const postReadySidecar of postReadySidecars) {
      await postReadySidecar.stop();
    }
  };
  const stopRegisteredGatewayLifetimeSidecars = async () => {
    const gatewayLifetimeSidecars = runtimeState.gatewayLifetimeSidecars;
    runtimeState.gatewayLifetimeSidecars = [];
    for (const gatewayLifetimeSidecar of gatewayLifetimeSidecars) {
      await gatewayLifetimeSidecar.stop();
    }
  };
  const createCloseHandler = () => async (optsValue?: GatewayCloseOptions) => {
    const channelIds = listLoadedChannelPlugins().map((plugin) => plugin.id as ChannelId);
    const { createGatewayCloseHandler, drainActiveSessionsForShutdown } =
      await loadGatewayCloseModule();
    await createGatewayCloseHandler({
      bonjourStop: runtimeState.bonjourStop,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      releasePluginRouteRegistry,
      channelIds,
      stopChannel,
      pluginServices: runtimeState.pluginServices,
      postReadySidecars: runtimeState.postReadySidecars,
      cron: runtimeState.cronState.cron,
      heartbeatRunner: runtimeState.heartbeatRunner,
      updateCheckStop: runtimeState.stopGatewayUpdateCheck,
      stopTaskRegistryMaintenance: stopTaskRegistryMaintenanceOnDemand,
      nodePresenceTimers,
      broadcast,
      tickInterval: runtimeState.tickInterval,
      healthInterval: runtimeState.healthInterval,
      dedupeCleanup: runtimeState.dedupeCleanup,
      mediaCleanup: runtimeState.mediaCleanup,
      worktreeCleanup: runtimeState.worktreeCleanup,
      skillCuratorCleanup: runtimeState.skillCuratorCleanup,
      agentUnsub: runtimeState.agentUnsub,
      heartbeatUnsub: runtimeState.heartbeatUnsub,
      transcriptUnsub: runtimeState.transcriptUnsub,
      lifecycleUnsub: runtimeState.lifecycleUnsub,
      taskUnsub: runtimeState.taskUnsub,
      chatRunState,
      chatAbortControllers,
      chatQueuedTurns,
      restartRecoveryCandidates,
      removeChatRun,
      agentRunSeq,
      nodeSendToSession,
      resolveActiveSessionIdForKey: resolveActiveEmbeddedRunSessionId,
      markMainSessionsAbortedForRestart: async ({
        sessionKeys,
        sessionIds,
        activeRuns,
        reason,
        isActiveRun,
      }) => {
        if (sessionKeys.size === 0 && sessionIds.size === 0) {
          return;
        }
        const { markRestartAbortedMainSessions } =
          await import("../agents/main-session-restart-recovery.js");
        await markRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          sessionKeys,
          sessionIds,
          activeRuns,
          isActiveRun,
          reason,
        });
      },
      getPendingReplyCount: getTotalPendingReplies,
      clients,
      configReloader: { stop: stopConfigReloaderForClose },
      wss,
      httpServer,
      httpServers,
      drainActiveSessionsForShutdown,
    })(optsValue);
  };
  let clearFallbackGatewayContextForServer = () => {};
  const closeOnStartupFailure = async () => {
    try {
      await beginClosePrelude();
      await stopRegisteredGatewayLifetimeSidecars();
      await stopRegisteredPostReadySidecars();
      await runClosePrelude();
      await createCloseHandler()({ reason: "gateway startup failed" });
    } finally {
      clearFallbackGatewayContextForServer();
    }
  };

  return {
    ...runtime,
    completeControlUiDeviceAuthMigrationForEffectiveOperator,
    unsubscribeEffectiveOperatorPairing,
    subscribeSessionMessageEvents,
    unsubscribeSessionMessageEvents,
    restartRecoveryCandidates,
    nodeRegistry,
    nodePresenceTimers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    hasTalkNodeConnected,
    watchNodeHttpRuntime,
    terminalSessions,
    runtimeState,
    pluginHostServices,
    lifecycle,
    postReadyState,
    cronReconciliation,
    beginClosePrelude,
    runClosePrelude,
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    refreshGatewayHealthSnapshotWithRuntime,
    stopRegisteredPostReadySidecars,
    stopRegisteredGatewayLifetimeSidecars,
    createCloseHandler,
    clearFallbackGatewayContextForServer: {
      get: () => clearFallbackGatewayContextForServer,
      set: (cleanup: () => void) => {
        clearFallbackGatewayContextForServer = cleanup;
      },
    },
    closeOnStartupFailure,
  };
}
