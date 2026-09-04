import { resolveActiveEmbeddedRunSessionId } from "../agents/embedded-agent-runner/active-run-projections.js";
import { fenceSessionSuspensionWritesForGatewayShutdown } from "../agents/session-suspension.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import { upsertPresence } from "../infra/system-presence.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
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
  createGatewayPluginRuntimeGeneration,
  type GatewayPluginRuntimeClaim,
} from "./server-plugin-runtime-generation.js";
import type { GatewayCloseOptions } from "./server-public.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import type { prepareGatewayKernelState } from "./server-runtime-state-prepare.js";
import { resolveGatewayShutdownNotice, runGatewayShutdownSteps } from "./server-shutdown.js";
import type { GatewayShutdownRuntime } from "./server-shutdown.runtime.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
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
  releasePluginMetadata: () => void;
  port: number;
  log: GatewayLogger;
  logCron: GatewayLogger;
  diagnosticsEnabled: boolean;
  shutdownRuntime: GatewayShutdownRuntime;
}) {
  const { runtime, port, log, logCron, diagnosticsEnabled, shutdownRuntime } = params;
  const requestEntryLifetime = new GatewayRequestEntryLifetime();
  const {
    minimalTestGateway,
    transportBridge,
    sessionMessageSubscribers,
    isConnectionActive,
    clients,
    mentionInbox,
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
    desktopSessionRegistry,
    nodeDesktopStreamBroker,
    bindDeviceNodeControl,
    bindWorkerNodeDesktopControl,
    workerPlacementRuntime,
    lifecycle,
  } = runtime;
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
    getConfig: getRuntimeConfig,
    onRunnerStateChanged: (nodeId, change) => {
      if (change.availabilityChanged) {
        workerPlacementRuntime?.runnerAvailability.markChanged();
      }
      if (change.inventoryChanged) {
        void workerPlacementRuntime?.scheduleNodeWorkspaceRetention(nodeId);
      }
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
  const nodeDesktopService = (await import("./desktop/node-source.js")).createNodeDesktopService({
    getConfig: getRuntimeConfig,
    nodeRegistry,
    desktopRegistry: desktopSessionRegistry,
    streamBroker: nodeDesktopStreamBroker,
  });
  nodeDesktopServiceRef.current = nodeDesktopService;
  bindDeviceNodeControl?.(nodeWorkerSupervisorTransport);
  bindWorkerNodeDesktopControl?.(nodeWorkerSupervisorTransport);
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
      resolveGatewayContext: runtime.resolvePluginGatewayContext,
    }),
    gatewayMethods: listActiveGatewayMethods(pluginRuntime.baseGatewayMethods),
  });
  const runtimeState = runtimeStateRef.current;
  const pluginRuntimeGeneration = createGatewayPluginRuntimeGeneration({
    getServices: () => runtimeState.pluginServices,
    setServices: (services) => {
      runtimeState.pluginServices = services;
    },
  });
  const unavailableGatewayMethods = new Set<string>(
    minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
  );
  // Kernel methods are the only writers for readiness and advertised-method state.
  // Residents use this surface so later ownership splits cannot mutate shared state directly.
  const kernel = {
    pluginRuntimeGeneration,
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
      getActiveTaskCount: () => number;
      skillsChangeUnsub: typeof runtimeState.skillsChangeUnsub;
    }) => {
      activeTaskCount.get = handles.getActiveTaskCount;
      runtimeState.skillsChangeUnsub = handles.skillsChangeUnsub;
    },
    swapDiscovery: (next: typeof runtimeState.discovery) => {
      const previous = runtimeState.discovery;
      runtimeState.discovery = next;
      return previous;
    },
    setScheduledServiceHandles: (handles: {
      heartbeatRunner: typeof runtimeState.heartbeatRunner;
      stopDeliveryRecovery: typeof runtimeState.stopDeliveryRecovery;
    }) => {
      runtimeState.heartbeatRunner = handles.heartbeatRunner;
      runtimeState.stopDeliveryRecovery = handles.stopDeliveryRecovery;
    },
    setPostAttachHandles: (
      handles: {
        stopGatewayUpdateCheck: typeof runtimeState.stopGatewayUpdateCheck;
        pluginServices: typeof runtimeState.pluginServices;
      },
      claim: GatewayPluginRuntimeClaim,
    ) => {
      runtimeState.stopGatewayUpdateCheck = handles.stopGatewayUpdateCheck;
      pluginRuntimeGeneration.publishServices(claim, handles.pluginServices);
    },
    setTailscaleCleanup: (cleanup: typeof runtimeState.tailscaleCleanup) => {
      runtimeState.tailscaleCleanup = cleanup;
    },
    setConfigReloaderHandle: (configReloader: typeof runtimeState.configReloader) => {
      runtimeState.configReloader = configReloader;
    },
    getReloadState: () => ({
      hooksConfig: runtimeState.hooksConfig,
      hookClientIpConfig: runtimeState.hookClientIpConfig,
      heartbeatRunner: runtimeState.heartbeatRunner,
      cronState: runtimeState.cronState,
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
    setMaintenanceHandles: (handles: NonNullable<typeof runtimeState.maintenance>) => {
      runtimeState.maintenance = handles;
      runtimeState.stopMediaCleanup = handles.stopMediaCleanup;
    },
  };
  runtimeState.controlUiSessionPullRequests = createControlUiSessionPullRequestSubscriptions({
    broadcastToConnIds,
    isConnectionActive,
  });
  runtimeState.sessionViewerPresence = createSessionViewerPresenceDeclarations({
    clients,
    broadcast,
    incrementPresenceVersion,
    getHealthVersion,
  });
  deps.cron = runtimeState.cronState.cron;
  const pluginHostServices = {
    get cron() {
      return runtimeState.cronState.cron;
    },
  };

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
  } = {
    maintenanceTimer: null,
  };
  const clearPostReadyMaintenanceTimer = () => {
    if (!postReadyState.maintenanceTimer) {
      return;
    }
    clearTimeout(postReadyState.maintenanceTimer);
    postReadyState.maintenanceTimer = null;
  };
  let deliveryRecoveryStopPromise: Promise<void> | null = null;
  const stopDeliveryRecoveryForClose = () => {
    deliveryRecoveryStopPromise ??= runtimeState.stopDeliveryRecovery();
    return deliveryRecoveryStopPromise;
  };
  let mediaCleanupStopPromise: ReturnType<typeof runtimeState.stopMediaCleanup> | null = null;
  const stopMediaCleanupForClose = () => {
    mediaCleanupStopPromise ??= runtimeState.stopMediaCleanup();
    return mediaCleanupStopPromise;
  };
  // Connect, RPC, and maintenance refreshes share a Gateway owner, not a socket lifetime.
  const healthWork = new AsyncWorkScope();
  const markClosePreludeStarted = (options?: GatewayCloseOptions) => {
    if (lifecycle.closePreludeStarted) {
      return;
    }
    lifecycle.closePreludeStarted = true;
    requestEntryLifetime.beginClose();
    mentionInbox.dispose();
    healthWork.beginClose();
    broadcast("shutdown", resolveGatewayShutdownNotice(options));
    runtime.connectionWork.beginClose();
    connectionDependentSidecarStopOwner.beginClose();
    // Keep late general sidecars owned until received work drains. Fence background
    // producers now, before their plugin/channel and shared-state dependencies can close.
    void stopDeliveryRecoveryForClose();
    void stopMediaCleanupForClose();
    void runtimeState.stopGatewayUpdateCheck().catch(() => {});
    void runtimeState.controlUiSessionPullRequests?.stop();
    runtimeState.sessionViewerPresence?.stop();
    kernel.setDispatchReady(false);
    gatewayInstanceRuntimeRef.current?.close();
    cronReconciliation.invalidate();
    clearPostReadyMaintenanceTimer();
  };
  let configReloaderStopPromise: Promise<void> | null = null;
  const stopConfigReloaderForClose = () => {
    configReloaderStopPromise ??= runtimeState.configReloader.stop();
    return configReloaderStopPromise;
  };
  const beginClosePrelude = async (options?: GatewayCloseOptions) => {
    fenceSessionSuspensionWritesForGatewayShutdown();
    markClosePreludeStarted(options);
    // Owners are fenced synchronously above. Join them before any runtime they
    // can publish into is torn down.
    await Promise.all([
      requestEntryLifetime.waitForPendingEntries(),
      stopDeliveryRecoveryForClose(),
      stopMediaCleanupForClose(),
      runtimeState.stopGatewayUpdateCheck(),
      stopConfigReloaderForClose().catch(() => {}),
      runtimeState.controlUiSessionPullRequests?.stop(),
      healthWork.drain(),
    ]);
  };
  const runClosePrelude = async () => {
    await beginClosePrelude();
    disposeNodeConnectionNotifications(nodeRegistry);
    watchNodeHttpRuntime.close();
    await shutdownRuntime.runGatewayClosePrelude({
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
      closeMcpServer: shutdownRuntime.closeMcpLoopbackServer,
    });
  };
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (
    optsResult,
  ) => {
    if (healthWork.isClosing) {
      return Promise.reject(new Error("Gateway health refresh owner is closed"));
    }
    return healthWork.track(() =>
      refreshGatewayHealthSnapshot({
        ...optsResult,
        getRuntimeSnapshot,
        getEventLoopHealth: readinessEventLoopHealth.snapshot,
        getConfigReloaderHotReloadStatus: kernel.getConfigReloaderHotReloadStatus,
      }),
    );
  };
  let connectionDependentSidecars: typeof runtimeState.gatewayLifetimeSidecars = [];
  const connectionDependentSidecarStopOwner = createGatewaySidecarStopOwner({
    getRegistered: () => connectionDependentSidecars,
    setRegistered: (sidecars) => {
      connectionDependentSidecars = sidecars;
    },
  });
  const stopConnectionDependentSidecars = async () => {
    // Failed worker stops still need their supervisor transport and runtime dependencies.
    try {
      await connectionDependentSidecarStopOwner.stop();
    } finally {
      // Acquisition publishes before yielding; seal its late cleanup before transport closes.
      await connectionDependentSidecarStopOwner.sealAndJoin();
    }
  };
  const postReadySidecarStopOwner = createGatewaySidecarStopOwner({
    getRegistered: () => runtimeState.postReadySidecars,
    setRegistered: (sidecars) => {
      runtimeState.postReadySidecars = sidecars;
    },
  });
  const gatewayLifetimeSidecarStopOwner = createGatewaySidecarStopOwner({
    getRegistered: () => runtimeState.gatewayLifetimeSidecars,
    setRegistered: (sidecars) => {
      runtimeState.gatewayLifetimeSidecars = sidecars;
    },
  });
  const stopRegisteredPostReadySidecars = postReadySidecarStopOwner.stop;
  const stopRegisteredGatewayLifetimeSidecars = gatewayLifetimeSidecarStopOwner.stop;
  const sealAndJoinRegisteredSidecarStops = async () => {
    const results = await Promise.allSettled([
      postReadySidecarStopOwner.sealAndJoin(),
      gatewayLifetimeSidecarStopOwner.sealAndJoin(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  };
  const prepareClose = async (optsValue?: GatewayCloseOptions) => {
    await beginClosePrelude(optsValue);
    const preparation = await shutdownRuntime.prepareGatewayClose(
      {
        resolveGatewayContext: runtime.resolvePluginGatewayContext,
        chatRunState,
        chatAbortControllers,
        chatQueuedTurns,
        restartRecoveryCandidates,
        removeChatRun,
        agentRunSeq,
        broadcast,
        nodeSendToSession,
        resolveActiveSessionIdForKey: resolveActiveEmbeddedRunSessionId,
        markMainSessionsAbortedForRestart: async (restart) => {
          await shutdownRuntime.markRestartAbortedMainSessions({
            cfg: getRuntimeConfig(),
            ...restart,
          });
        },
        getPendingReplyCount: getTotalPendingReplies,
        updateCheckStop: runtimeState.stopGatewayUpdateCheck,
        configReloader: { stop: stopConfigReloaderForClose },
      },
      optsValue,
    );
    // Startup may still publish cleanup owners while received work settles.
    // Resolve their handles only when the caller reaches final teardown.
    return async () => {
      const channelIds = listLoadedChannelPlugins().map((plugin) => plugin.id as ChannelId);
      const transport = transportBridge.current();
      await transport?.portalService.closeAll();
      await shutdownRuntime.completeGatewayClose(
        {
          bonjourStop: kernel.swapDiscovery(null)?.stop ?? null,
          tailscaleCleanup: runtimeState.tailscaleCleanup,
          clearSecretsRuntimeSnapshot: clearSecretsRuntimeSnapshotState,
          channelIds,
          stopChannel,
          pluginServices: runtimeState.pluginServices,
          cron: runtimeState.cronState.cron,
          heartbeatRunner: runtimeState.heartbeatRunner,
          stopTaskRegistryMaintenance: shutdownRuntime.stopTaskRegistryMaintenance,
          nodePresenceTimers,
          maintenance: runtimeState.maintenance,
          stopMediaCleanup: stopMediaCleanupForClose,
          agentUnsub: runtimeState.agentUnsub,
          heartbeatUnsub: runtimeState.heartbeatUnsub,
          transcriptUnsub: runtimeState.transcriptUnsub,
          lifecycleUnsub: runtimeState.lifecycleUnsub,
          taskUnsub: runtimeState.taskUnsub,
          chatRunState,
          clients,
          finishRequestEntries: () => requestEntryLifetime.sealAndJoin(),
          ...(transport
            ? {
                wss: transport.wss,
                httpServer: transport.httpServer,
                httpServers: transport.httpServers,
              }
            : {}),
          drainActiveSessionsForShutdown: shutdownRuntime.drainActiveSessionsForShutdown,
          disposeAllBundleLspRuntimes: shutdownRuntime.disposeAllBundleLspRuntimes,
          drainRetainedOpenAiEmbeddingProviders:
            shutdownRuntime.drainRetainedOpenAiEmbeddingProviders,
          stopGmailWatcher: shutdownRuntime.stopGmailWatcher,
          disposeAllCodeModeRuns: shutdownRuntime.disposeAllCodeModeRuns,
          closeProviderTransportDispatcherPool:
            shutdownRuntime.closeProviderTransportDispatcherPool,
        },
        preparation,
      );
      await requestEntryLifetime.sealAndJoin();
      params.releasePluginMetadata();
    };
  };
  const closeOnStartupFailure = async () => {
    const close = await prepareClose({ reason: "gateway startup failed" });
    await runGatewayShutdownSteps({
      steps: [
        {
          name: "connection-dependent sidecars",
          run: stopConnectionDependentSidecars,
          required: true,
        },
        {
          name: "received connection work",
          run: () => runtime.connectionWork.drain(),
          required: true,
        },
        { name: "gateway lifetime sidecars", run: stopRegisteredGatewayLifetimeSidecars },
        { name: "post-ready sidecars", run: stopRegisteredPostReadySidecars },
        { name: "gateway close prelude", run: runClosePrelude },
        { name: "late sidecar cleanup", run: sealAndJoinRegisteredSidecarStops },
        {
          name: "gateway close",
          run: close,
        },
      ],
      onError: (message) => log.error(message),
    });
  };

  if (diagnosticsEnabled) {
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
  }

  return {
    ...runtime,
    requestEntryLifetime,
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
    shutdownRuntime,
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
    stopConnectionDependentSidecars,
    registerConnectionDependentSidecars: connectionDependentSidecarStopOwner.publish,
    unregisterConnectionDependentSidecar: (
      sidecar: (typeof connectionDependentSidecars)[number],
    ) => {
      connectionDependentSidecars = connectionDependentSidecars.filter(
        (registered) => registered !== sidecar,
      );
    },
    registerPostReadySidecars: postReadySidecarStopOwner.publish,
    registerGatewayLifetimeSidecars: gatewayLifetimeSidecarStopOwner.publish,
    sealAndJoinRegisteredSidecarStops,
    prepareClose,
    closeOnStartupFailure,
  };
}
