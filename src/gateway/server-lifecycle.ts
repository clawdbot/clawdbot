import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/run-state.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  onEffectiveOperatorDevicePaired,
  type EffectiveOperatorDeviceIdentity,
} from "../infra/device-pairing.js";
import { upsertPresence } from "../infra/system-presence.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  removeRemoteNodeInfoForConnection,
} from "../skills/runtime/remote.js";
import type { RestartRecoveryCandidate } from "./chat-abort.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
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
import type { prepareGatewayKernelState } from "./server-runtime-state-prepare.js";
import {
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

type GatewayRuntimePreparation = Awaited<ReturnType<typeof prepareGatewayKernelState>>;
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
    minimalTestGateway,
    controlUiDeviceAuthMigration,
    completeControlUiDeviceAuthMigration,
    workerGatewayEndpoint,
    transportBridge,
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
    browserAuthRateLimiter,
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
    activeTaskCount,
    residentRegistry,
    desktopSessionRegistry,
    nodeDesktopStreamBroker,
    bindDeviceNodeControl,
    workerPlacementRuntime,
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
  workerGatewayEndpoint.resolve = transportBridge.getWorkerIngressEndpoint;
  const subscribeSessionMessageEvents: GatewayRequestContext["subscribeSessionMessageEvents"] = (
    connId,
    sessionKey,
    options,
  ) => sessionMessageSubscribers.subscribe(connId, sessionKey, options);
  const unsubscribeSessionMessageEvents: GatewayRequestContext["unsubscribeSessionMessageEvents"] =
    (connId, sessionKey) => sessionMessageSubscribers.unsubscribe(connId, sessionKey);
  const restartRecoveryCandidates = new Map<string, RestartRecoveryCandidate>();
  const nodeDesktopServiceRef: {
    current?: import("./desktop/node-source.js").NodeDesktopService;
  } = {};
  const { createGatewayNodeSessionRuntime } = await import("./server-node-session-runtime.js");
  const {
    nodeRegistry,
    nodeWorkerSupervisorTransport,
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
    onRunnerInventoryChanged: (nodeId) => {
      void workerPlacementRuntime?.scheduleNodeWorkspaceRetention(nodeId);
    },
    onPairingInvalidated: ({ nodeId, connId }) => {
      void nodeDesktopServiceRef.current?.stopNode(nodeId);
      upsertPresence(nodeId, { reason: "disconnect" });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      removeRemoteNodeInfoForConnection(nodeId, connId);
    },
    onPairingGenerationChanged: ({ nodeId }) => {
      void nodeDesktopServiceRef.current?.stopNode(nodeId);
    },
  });
  const nodeDesktopService =
    desktopSessionRegistry && nodeDesktopStreamBroker
      ? (await import("./desktop/node-source.js")).createNodeDesktopService({
          getConfig: getRuntimeConfig,
          nodeRegistry,
          desktopRegistry: desktopSessionRegistry,
          streamBroker: nodeDesktopStreamBroker,
        })
      : undefined;
  nodeDesktopServiceRef.current = nodeDesktopService;
  bindDeviceNodeControl?.(nodeWorkerSupervisorTransport);
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
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
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
  const unavailableGatewayMethods = new Set<string>(
    minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
  );
  // Kernel methods are the only writers for readiness and advertised-method state.
  // Residents use this surface so later ownership splits cannot mutate shared state directly.
  const kernel = {
    setDispatchReady: (ready: boolean) => {
      startupState.dispatchReady = ready;
    },
    markSidecarsReady: () => {
      startupState.sidecarsReady = true;
    },
    unlockStartupMethods: () => {
      for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
        unavailableGatewayMethods.delete(method);
      }
    },
    publishMethodSurface: (methods: readonly string[]) => {
      runtimeState.gatewayMethods.splice(0, runtimeState.gatewayMethods.length, ...methods);
    },
    setEarlyRuntimeHandles: (handles: {
      bonjourStop: typeof runtimeState.bonjourStop;
      getActiveTaskCount: () => number;
      skillsChangeUnsub: typeof runtimeState.skillsChangeUnsub;
    }) => {
      runtimeState.bonjourStop = handles.bonjourStop;
      activeTaskCount.get = handles.getActiveTaskCount;
      runtimeState.skillsChangeUnsub = handles.skillsChangeUnsub;
    },
    swapBonjourStop: (next: typeof runtimeState.bonjourStop) => {
      const previous = runtimeState.bonjourStop;
      runtimeState.bonjourStop = next;
      return previous;
    },
    setScheduledServiceHandles: (handles: {
      heartbeatRunner: typeof runtimeState.heartbeatRunner;
      stopOutboundDeliveryRecovery: typeof runtimeState.stopOutboundDeliveryRecovery;
    }) => {
      runtimeState.heartbeatRunner = handles.heartbeatRunner;
      runtimeState.stopOutboundDeliveryRecovery = handles.stopOutboundDeliveryRecovery;
    },
    setPostAttachHandles: (handles: {
      stopGatewayUpdateCheck: typeof runtimeState.stopGatewayUpdateCheck;
      tailscaleCleanup: typeof runtimeState.tailscaleCleanup;
      pluginServices: typeof runtimeState.pluginServices;
    }) => {
      runtimeState.stopGatewayUpdateCheck = handles.stopGatewayUpdateCheck;
      runtimeState.tailscaleCleanup = handles.tailscaleCleanup;
      runtimeState.pluginServices = handles.pluginServices;
    },
    setPluginServices: (pluginServices: typeof runtimeState.pluginServices) => {
      runtimeState.pluginServices = pluginServices;
    },
    setConfigReloaderHandle: (configReloader: typeof runtimeState.configReloader) => {
      runtimeState.configReloader = configReloader;
    },
    getReloadState: () => ({
      hooksConfig: runtimeState.hooksConfig,
      hookClientIpConfig: runtimeState.hookClientIpConfig,
      heartbeatRunner: runtimeState.heartbeatRunner,
      cronState: runtimeState.cronState,
      channelHealthMonitor: runtimeState.channelHealthMonitor,
    }),
    setReloadHookState: (next: {
      hooksConfig: typeof runtimeState.hooksConfig;
      hookClientIpConfig: typeof runtimeState.hookClientIpConfig;
    }) => {
      runtimeState.hooksConfig = next.hooksConfig;
      runtimeState.hookClientIpConfig = next.hookClientIpConfig;
    },
    swapHeartbeatRunner: (next: typeof runtimeState.heartbeatRunner) => {
      const previous = runtimeState.heartbeatRunner;
      runtimeState.heartbeatRunner = next;
      return previous;
    },
    swapCronState: (next: typeof runtimeState.cronState) => {
      const previous = runtimeState.cronState;
      runtimeState.cronState = next;
      deps.cron = next.cron;
      return previous;
    },
    setChannelHealthMonitor: (next: typeof runtimeState.channelHealthMonitor) => {
      runtimeState.channelHealthMonitor = next;
    },
    notifyPluginMetadataChanged: () => {
      runtimeState.configReloader.notifyPluginMetadataChanged();
    },
    getConfigReloaderHotReloadStatus: () => runtimeState.configReloader.hotReloadStatus?.(),
    setPostReadySidecars: (sidecars: typeof runtimeState.postReadySidecars) => {
      runtimeState.postReadySidecars = sidecars;
    },
    setGatewayLifetimeSidecars: (sidecars: typeof runtimeState.gatewayLifetimeSidecars) => {
      runtimeState.gatewayLifetimeSidecars = sidecars;
    },
    addGatewayLifetimeSidecar: (sidecar: (typeof runtimeState.gatewayLifetimeSidecars)[number]) => {
      runtimeState.gatewayLifetimeSidecars.push(sidecar);
    },
    setMaintenanceHandles: (handles: {
      tickInterval: typeof runtimeState.tickInterval;
      healthInterval: typeof runtimeState.healthInterval;
      dedupeCleanup: typeof runtimeState.dedupeCleanup;
      stopMediaCleanup: typeof runtimeState.stopMediaCleanup;
      worktreeCleanup: typeof runtimeState.worktreeCleanup;
      skillCuratorCleanup: typeof runtimeState.skillCuratorCleanup;
    }) => {
      runtimeState.tickInterval = handles.tickInterval;
      runtimeState.healthInterval = handles.healthInterval;
      runtimeState.dedupeCleanup = handles.dedupeCleanup;
      runtimeState.stopMediaCleanup = handles.stopMediaCleanup;
      runtimeState.worktreeCleanup = handles.worktreeCleanup;
      runtimeState.skillCuratorCleanup = handles.skillCuratorCleanup;
    },
  };
  runtimeState.controlUiSessionPullRequests = createControlUiSessionPullRequestSubscriptions({
    broadcastToConnIds,
  });
  runtimeState.sessionViewerPresence = createSessionViewerPresenceDeclarations({
    onReplace: (connId, sessionKeys) => {
      const client = [...clients].find((candidate) => candidate.connId === connId);
      if (!client?.presenceKey) {
        return;
      }
      upsertPresence(client.presenceKey, {
        watchedSessions: sessionKeys.length > 0 ? [...sessionKeys] : undefined,
      });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
    },
  });
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
  let outboundDeliveryRecoveryStopPromise: Promise<void> | null = null;
  const stopOutboundDeliveryRecoveryForClose = () => {
    outboundDeliveryRecoveryStopPromise ??= runtimeState.stopOutboundDeliveryRecovery();
    return outboundDeliveryRecoveryStopPromise;
  };
  let mediaCleanupStopPromise: ReturnType<typeof runtimeState.stopMediaCleanup> | null = null;
  const stopMediaCleanupForClose = () => {
    mediaCleanupStopPromise ??= runtimeState.stopMediaCleanup();
    return mediaCleanupStopPromise;
  };
  const markClosePreludeStarted = () => {
    lifecycle.closePreludeStarted = true;
    // Fence background owners before any awaited close step can tear down the
    // plugin/channel or shared-state runtime they still need.
    void stopOutboundDeliveryRecoveryForClose();
    void stopMediaCleanupForClose();
    runtimeState.stopGatewayUpdateCheck();
    runtimeState.controlUiSessionPullRequests?.stop();
    runtimeState.sessionViewerPresence?.stop();
    unsubscribeEffectiveOperatorPairing();
    kernel.setDispatchReady(false);
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
    fenceSessionSuspensionWritesForGatewayShutdown();
    markClosePreludeStarted();
    // Owners are fenced synchronously above. Join them before any runtime they
    // can publish into is torn down.
    await Promise.all([
      stopOutboundDeliveryRecoveryForClose(),
      stopMediaCleanupForClose(),
      stopConfigReloaderForClose().catch(() => {}),
    ]);
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
      stopChannelHealthMonitor: async () => {
        const monitor = runtimeState?.channelHealthMonitor;
        monitor?.shutdown();
        await monitor?.waitForIdle();
      },
      stopReadinessEventLoopHealth: readinessEventLoopHealth.stop,
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
      getConfigReloaderHotReloadStatus: kernel.getConfigReloaderHotReloadStatus,
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
    const transport = transportBridge.current();
    await transport?.portalService.closeAll();
    await createGatewayCloseHandler({
      bonjourStop: runtimeState.bonjourStop,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotState,
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
      stopMediaCleanup: stopMediaCleanupForClose,
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
          await import("../agents/main-session-recovery/main-session-restart-recovery.js");
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
      ...(transport
        ? {
            wss: transport.wss,
            httpServer: transport.httpServer,
            httpServers: transport.httpServers,
          }
        : {}),
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

  const diagnosticHeartbeatResident = residentRegistry.register({
    name: "diagnostic-heartbeat",
    start: () => {
      // Gateway lifecycle owns both this existing heartbeat timer and the monitor
      // it samples, so startup failure and normal close tear them down together.
      startDiagnosticHeartbeat(undefined, {
        getConfig: getRuntimeConfig,
        startupGraceMs: 60_000,
        sampleLiveness: () => {
          const sample = readinessEventLoopHealth.persistentDegradationSnapshot();
          if (!sample || sample.degradedSinceMs == null) {
            return null;
          }
          return {
            reasons: sample.reasons,
            intervalMs: sample.intervalMs,
            degradedSinceMs: sample.degradedSinceMs,
            eventLoopDelayP99Ms: sample.delayP99Ms,
            eventLoopDelayMaxMs: sample.delayMaxMs,
            eventLoopUtilization: sample.utilization,
            cpuCoreRatio: sample.cpuCoreRatio,
          };
        },
      });
    },
    stop: () => stopDiagnosticHeartbeat(),
  });
  if (diagnosticsEnabled) {
    diagnosticHeartbeatResident.start();
  }

  return {
    ...runtime,
    completeControlUiDeviceAuthMigrationForEffectiveOperator,
    unsubscribeEffectiveOperatorPairing,
    subscribeSessionMessageEvents,
    unsubscribeSessionMessageEvents,
    restartRecoveryCandidates,
    nodeRegistry,
    nodeDesktopService,
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
    unavailableGatewayMethods,
    kernel,
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
