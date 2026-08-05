import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
} from "../config/io.js";
import { isNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
import { collectGatewayProcessMemoryUsageMb, finishGatewayRestartTrace } from "./restart-trace.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
} from "./server-shared-auth-generation.js";
import {
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

const [POST_READY_MAINTENANCE_DELAY_MS, RETAINED_PLUGIN_CLEANUP_DELAY_MS] = [250, 30_000];

export async function finishGatewayStartup(params: {
  coreRuntime: GatewayCoreRuntime;
  port: number;
  opts: GatewayCoreRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  logTailscale: GatewayLogger;
  loadGatewayStartupPostAttachModule: () => Promise<
    typeof import("./server-startup-post-attach.js")
  >;
  waitForPostReadyWork: () => Promise<void>;
}) {
  const {
    coreRuntime: runtime,
    port,
    opts,
    log,
    logHealth,
    logWsControl,
    logHooks,
    logChannels,
    logCron,
    logReload,
    logTailscale,
    loadGatewayStartupPostAttachModule,
  } = params;
  const {
    minimalTestGateway,
    deps,
    runtimeState,
    sessionCompanion,
    sessionObserver,
    getMcpAppSandboxPort,
    ensureSandboxHostPort,
    terminalLaunchPolicy,
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    approvalSessionEvents,
    startupTrace,
    loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalog,
    refreshGatewayHealthSnapshotWithRuntime,
    getRuntimeSnapshot,
    broadcast,
    broadcastToConnIds,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    hasTalkNodeConnected,
    clients,
    watchNodeHttpRuntime,
    sharedGatewaySessionGenerationState,
    resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
    completeControlUiDeviceAuthMigrationForEffectiveOperator,
    claimControlUiDeviceAuthMigration,
    releaseControlUiDeviceAuthMigrationClaim,
    controlUiDeviceAuthMigration,
    nodeRegistry,
    workerEnvironmentService,
    workerPlacementRuntime,
    workerPlacementControlAvailable,
    terminalSessions,
    agentRunSeq,
    chatAbortControllers,
    chatQueuedTurns,
    chatRunState,
    addChatRun,
    removeChatRun,
    subscribeSessionMessageEvents,
    unsubscribeSessionMessageEvents,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    toolEventRecipients,
    dedupe,
    wizardSessions,
    systemAgentSessions,
    findRunningWizard,
    purgeWizardSession,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    wizardRunner,
    channelWizardRunner,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    pluginGatewayContext,
    getAttachedGatewayMethodRegistry,
    gatewayInstanceRuntimeRef,
    lifecycle,
    startupState,
    pluginRuntime,
    gatewayTls,
    bindHost,
    getResolvedAuth,
    authRateLimiter,
    browserAuthRateLimiter,
    nodeReapprovalCoordinator,
    preauthHandshakeTimeoutMs,
    isGatewayStartupPending,
    attachedGatewayExtraHandlers,
    startListening,
    loadStartupPluginsModule,
    gatewayPluginConfigAtStart,
    startupActivationSourceConfig,
    defaultWorkspaceDir,
    coreGatewayMethodNames,
    pluginHostServices,
    baseMethods,
    startupPluginIds,
    pluginManifestRecords,
    pluginLookUpTable,
    ambientEnvTriggers,
    replaceAttachedPluginRuntime,
    refreshAttachedGatewayDiscovery,
    wss,
    httpBindHosts,
    startChannels,
    broadcastPluginEvent,
    tailscaleMode,
    tailscaleConfig,
    controlUiBasePath,
    controlUiRootLifecycle,
    sidecarStartup,
    workerLiveEvents,
    earlyRuntime,
    cfgAtStart,
    resolvedAuth,
    preauthConnectionBudget,
    releaseStartupAccountStarts,
    cronReconciliation,
    postReadyState,
    cronStartState,
    prepareReloadCandidate,
    startupLastGoodSnapshot,
    startupInternalWriteHash,
    configSnapshot,
    channelManager,
    activateRuntimeSecrets,
    applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    reloadAttachedGatewayPlugins,
    readinessEventLoopHealth,
    stopRegisteredPostReadySidecars,
    clearFallbackGatewayContextForServer,
  } = runtime;
  const unavailableGatewayMethods = new Set<string>(
    minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
  );
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      deps,
      runtimeState,
      sessionCompanion,
      getRuntimeConfig,
      sessionObserver,
      getMcpAppSandboxPort,
      ensureSandboxHostPort,
      resolveTerminalLaunchPolicy: terminalLaunchPolicy.resolve,
      isTerminalEnabled: terminalLaunchPolicy.isEnabled,
      execApprovalManager,
      cancelRunBoundApprovals,
      forwardPluginApprovalRequest,
      pluginApprovalIosPushDelivery,
      pluginApprovalManager,
      systemAgentApprovalManager,
      listSessionPendingApprovals: approvalSessionEvents.replay,
      loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedTalkNode: hasTalkNodeConnected,
      clients,
      invalidateDeviceTransports: watchNodeHttpRuntime.invalidateSessionsForDevice,
      disconnectDeviceTransports: watchNodeHttpRuntime.disconnectSessionsForDevice,
      enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => {
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: sharedGatewaySessionGenerationState,
          nextConfig,
          resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
          clients,
        });
      },
      completeControlUiDeviceAuthMigration:
        completeControlUiDeviceAuthMigrationForEffectiveOperator,
      claimControlUiDeviceAuthMigration: (deviceId: string) =>
        claimControlUiDeviceAuthMigration(deviceId, { env: process.env }),
      releaseControlUiDeviceAuthMigrationClaim: (deviceId: string) =>
        releaseControlUiDeviceAuthMigrationClaim(deviceId, { env: process.env }),
      nodeRegistry,
      ...(workerEnvironmentService ? { workerEnvironmentService } : {}),
      ...(workerPlacementRuntime
        ? { workerSessionPlacementService: workerPlacementRuntime.placements }
        : {}),
      ...(workerPlacementControlAvailable
        ? { workerPlacementDispatchService: workerPlacementControlAvailable }
        : {}),
      terminalSessions,
      agentRunSeq,
      chatAbortControllers,
      chatQueuedTurns,
      chatRunState,
      addChatRun,
      removeChatRun,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      subscribeSessionMessageEvents,
      unsubscribeSessionMessageEvents,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
        sessionObserver.removeConnection(connId);
      },
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
      registerToolEventRecipient: toolEventRecipients.add,
      dedupe,
      wizardSessions,
      systemAgentSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      getEventLoopHealth: readinessEventLoopHealth.snapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      channelWizardRunner,
      broadcastVoiceWakeChanged,
      unavailableGatewayMethods,
      broadcastVoiceWakeRoutingChanged,
    });
  });
  const sessionChangeSidecar = {
    stop: async () => {
      const { flushPendingSessionsChangedEvents } =
        await import("./server-methods/session-change-event.js");
      flushPendingSessionsChangedEvents(gatewayRequestContext);
    },
  };
  runtimeState.gatewayLifetimeSidecars.push(sessionChangeSidecar);
  pluginGatewayContext.current = gatewayRequestContext;
  const { createGatewayInstanceRuntime } = await import("./server-instance-runtime.js");
  const gatewayInstanceRuntimeLocal = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    isDispatchAvailable: () => startupState.dispatchReady && !lifecycle.closePreludeStarted,
    logError: (message) => log.error(message),
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntimeLocal;
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntimeLocal.approvalEvents;
  gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntimeLocal.recovery;

  const fallbackGatewayContextCleanup: unknown = setFallbackGatewayContextResolver(
    () => gatewayRequestContext,
  );
  clearFallbackGatewayContextForServer.set(
    typeof fallbackGatewayContextCleanup === "function"
      ? () => {
          fallbackGatewayContextCleanup();
        }
      : () => {},
  );

  const [{ attachGatewayWsHandlers }, { listPluginNodeCapabilities }] = await startupTrace.measure(
    "gateway.ws-imports",
    () =>
      Promise.all([
        import("./server-ws-runtime.js"),
        import("./server/plugins-http/route-capability.js"),
      ]),
  );
  await startupTrace.measure("gateway.ws-attach", () =>
    attachGatewayWsHandlers({
      wss,
      clients,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      pluginSurfaceScheme: gatewayTls.enabled ? "https" : "http",
      getPluginNodeCapabilities: () =>
        withCoreCanvasNodeCapability(
          listPluginNodeCapabilities(pluginRuntime.registry),
          isCoreCanvasHostEnabled(getRuntimeConfig()),
        ),
      resolvedAuth,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      nodeReapprovalCoordinator,
      preauthHandshakeTimeoutMs,
      isStartupPending: isGatewayStartupPending,
      isControlUiDeviceAuthMigrationPending: () => controlUiDeviceAuthMigration.pending,
      gatewayMethods: runtimeState.gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: attachedGatewayExtraHandlers,
      getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
      ...(workerEnvironmentService ? { workerConnectionService: workerEnvironmentService } : {}),
      broadcast,
      context: gatewayRequestContext,
    }),
  );
  await startupTrace.measure("http.listen", () => startListening());
  startupState.dispatchReady = true;
  startupTrace.mark("http.bound");
  const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
  let postAttachRuntimeReturned = false;
  let scheduledServicesActivated = false;
  const loadScheduledServicesModule = createLazyPromise(
    () => import("./server-runtime-services.js"),
    { cacheRejections: true },
  );
  const activateScheduledServicesWhenReady = () => {
    if (
      lifecycle.closePreludeStarted ||
      !postAttachRuntimeReturned ||
      !startupState.sidecarsReady ||
      scheduledServicesActivated
    ) {
      return;
    }
    scheduledServicesActivated = true;
    void loadScheduledServicesModule().then((gatewayRuntimeServices) => {
      if (lifecycle.closePreludeStarted) {
        return;
      }
      const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
        minimalTestGateway,
        cfgAtStart,
        deps,
        sessionDeliveryRecoveryMaxEnqueuedAt,
        cronState: runtimeState.cronState,
        cronReconciliation,
        startCron: false,
        logCron,
        log,
      });
      runtimeState.heartbeatRunner = activated.heartbeatRunner;
      runtimeState.stopOutboundDeliveryRecovery = activated.stopOutboundDeliveryRecovery;
    });
  };
  ({
    stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck,
    tailscaleCleanup: runtimeState.tailscaleCleanup,
    pluginServices: runtimeState.pluginServices,
  } = await startupTrace.measure("runtime.post-attach", () =>
    loadGatewayStartupPostAttachModule().then(
      ({ startGatewayPostAttachRuntime, stopPostReadySidecarsAfterCloseStarted }) =>
        startGatewayPostAttachRuntime({
          minimalTestGateway,
          cfgAtStart,
          getConfig: getRuntimeConfig,
          bindHost,
          bindHosts: httpBindHosts,
          port,
          tlsEnabled: gatewayTls.enabled,
          log,
          isNixMode,
          startupStartedAt: opts.startupStartedAt,
          broadcast,
          broadcastPluginEvent,
          tailscaleMode,
          resetOnExit: tailscaleConfig.resetOnExit ?? false,
          serviceName: tailscaleConfig.serviceName,
          preserveFunnel: tailscaleConfig.preserveFunnel ?? false,
          controlUiBasePath,
          controlUiRootLifecycle,
          logTailscale,
          gatewayPluginConfigAtStart,
          activationSourceConfig: startupActivationSourceConfig,
          pluginManifestRecords,
          ambientEnvTriggers,
          pluginRegistry: pluginRuntime.registry,
          defaultWorkspaceDir,
          deps,
          startChannels,
          recoveryRuntime: gatewayInstanceRuntimeLocal.recovery,
          logHooks,
          logChannels,
          unavailableGatewayMethods,
          loadStartupPlugins: async () => {
            const { loadGatewayStartupPluginRuntime } = await loadStartupPluginsModule();
            return loadGatewayStartupPluginRuntime({
              cfg: gatewayPluginConfigAtStart,
              activationSourceConfig: startupActivationSourceConfig,
              workspaceDir: defaultWorkspaceDir,
              log,
              baseMethods,
              coreGatewayMethodNames,
              hostServices: pluginHostServices,
              startupPluginIds,
              pluginLookUpTable,
              startupTrace,
              ambientEnvTriggers,
            });
          },
          onStartupPluginsLoading: () => {
            startupState.pendingReason = "startup-sidecars";
          },
          onStartupPluginsLoaded: async (loaded) => {
            replaceAttachedPluginRuntime(loaded);
            startupState.pendingReason = "startup-sidecars";
            await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
          },
          getCronService: () =>
            runtimeState?.cronState.cron as PluginHookGatewayCronService | undefined,
          onChannelsStarted: () => {
            releaseStartupAccountStarts();
          },
          onPluginServices: (pluginServices) => {
            runtimeState.pluginServices = pluginServices;
          },
          onPostReadySidecars: (postReadySidecars) => {
            runtimeState.postReadySidecars = postReadySidecars;
            stopPostReadySidecarsAfterCloseStarted({
              postReadySidecars,
              closeStarted: lifecycle.closePreludeStarted,
            });
            if (lifecycle.closePreludeStarted) {
              runtimeState.postReadySidecars = [];
            }
          },
          onGatewayLifetimeSidecars: (gatewayLifetimeSidecars) => {
            const lifetimeSidecars = [sessionChangeSidecar, ...gatewayLifetimeSidecars];
            runtimeState.gatewayLifetimeSidecars = lifetimeSidecars;
            stopPostReadySidecarsAfterCloseStarted({
              postReadySidecars: lifetimeSidecars,
              closeStarted: lifecycle.closePreludeStarted,
            });
            if (lifecycle.closePreludeStarted) {
              runtimeState.gatewayLifetimeSidecars = [];
            }
          },
          ...(workerPlacementRuntime
            ? {
                startWorkerEnvironmentRuntime: async () => {
                  if (lifecycle.closePreludeStarted) {
                    return null;
                  }
                  return await workerPlacementRuntime.startRuntime({
                    isClosePreludeStarted: () => lifecycle.closePreludeStarted,
                    // Close must see the drain handle before reconciliation can yield.
                    registerSidecar: (sidecar) => {
                      runtimeState.gatewayLifetimeSidecars.push(sidecar);
                    },
                  });
                },
              }
            : {}),
          onSidecarsReady: () => {
            startupState.sidecarsReady = true;
            activateScheduledServicesWhenReady();
          },
          isClosing: () => lifecycle.closePreludeStarted,
          startupTrace,
          sidecarStartup,
          waitForPostReadyWork: params.waitForPostReadyWork,
          providerAuthPrewarm: {
            getConfig: getRuntimeConfig,
          },
        }),
    ),
  ));
  startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
  startupTrace.mark("ready");
  if (sidecarStartup === "defer") {
    log.info("gateway ready");
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  if (!minimalTestGateway) {
    const { startOpenClawDatabaseIntegrityVerifier } =
      await import("../state/openclaw-database-verify.js");
    runtimeState.gatewayLifetimeSidecars.push(
      startOpenClawDatabaseIntegrityVerifier({ env: process.env }),
    );
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
  runtimeState.configReloader = startManagedGatewayConfigReloader({
    minimalTestGateway,
    initialConfig: cfgAtStart,
    initialCompareConfig: startupLastGoodSnapshot.sourceConfig,
    initialSnapshotRawHash: startupLastGoodSnapshot.exists
      ? (startupLastGoodSnapshot.hash ?? null)
      : null,
    initialAuthoredConfig: startupLastGoodSnapshot.parsed,
    initialIncludedPaths: startupLastGoodSnapshot.includedPaths ?? [],
    initialSnapshotValid: startupLastGoodSnapshot.valid,
    initialSnapshotIssues: startupLastGoodSnapshot.issues,
    initialInternalWriteHash: startupInternalWriteHash,
    watchPath: configSnapshot.path,
    readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
    promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
    subscribeToWrites: (listener) =>
      registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: configSnapshot.path,
        preCommitRuntimePreflight: async (sourceConfig, runtimeRefresh) => {
          const candidate = prepareReloadCandidate({
            runtimeConfig: sourceConfig,
            sourceConfig,
          });
          await activateRuntimeSecrets(candidate.runtimeConfig, {
            reason: "reload",
            activate: false,
            env: candidate.runtimeEnv.env,
            includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
          });
          return candidate;
        },
      }),
    deps,
    broadcast,
    getState: () => ({
      hooksConfig: runtimeState.hooksConfig,
      hookClientIpConfig: runtimeState.hookClientIpConfig,
      heartbeatRunner: runtimeState.heartbeatRunner,
      cronState: runtimeState.cronState,
      channelHealthMonitor: runtimeState.channelHealthMonitor,
    }),
    setState: (nextState) => {
      const cronStateChanged = nextState.cronState !== runtimeState.cronState;
      runtimeState.hooksConfig = nextState.hooksConfig;
      runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
      runtimeState.heartbeatRunner = nextState.heartbeatRunner;
      runtimeState.cronState = nextState.cronState;
      deps.cron = runtimeState.cronState.cron;
      runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
      if (cronStateChanged) {
        cronStartState.handled = true;
      }
    },
    startChannel,
    stopChannel,
    getChannelAutostartSuppression: channelManager.getAutostartSuppression,
    stopPostReadySidecars: stopRegisteredPostReadySidecars,
    reloadPlugins: reloadAttachedGatewayPlugins,
    logHooks,
    logChannels,
    logCron,
    logReload,
    cronReconciliation,
    onCronRestart: () => {
      cronStartState.handled = true;
    },
    prepareTerminalConfig: (plan, nextConfig) => {
      terminalLaunchPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
    },
    reconcileTerminalSessions: () => {
      terminalSessions.closeDisallowedAgents((agentId) => terminalLaunchPolicy.resolve(agentId).ok);
    },
    commitTerminalConfig: (nextConfig) => {
      terminalLaunchPolicy.commitConfig();
      workerLiveEvents?.rebindAll(nextConfig);
    },
    acceptTerminalConfig: terminalLaunchPolicy.acceptConfig,
    channelManager,
    activateRuntimeSecrets,
    prepareConfigCandidate: prepareReloadCandidate,
    applyRuntimeConfigOverrides: applyFixedGatewayOverlays,
    resolveSharedGatewaySessionGenerationForConfig,
    sharedGatewaySessionGenerationState,
    clients,
    ...(opts.hotReloadRecovery ? { requestRecoveryRestart: opts.hotReloadRecovery } : {}),
    restartRecoveryAvailable: opts.hotReloadRecovery !== undefined,
  });
  await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err: unknown) => {
    log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
  });
  if (!minimalTestGateway) {
    const gatewayRuntimeServices = await loadScheduledServicesModule();
    postReadyState.maintenanceTimer = gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
      delayMs: POST_READY_MAINTENANCE_DELAY_MS,
      isClosing: () => lifecycle.closePreludeStarted,
      onStarted: () => {
        postReadyState.maintenanceTimer = null;
      },
      startMaintenance: async () => {
        if (lifecycle.closePreludeStarted) {
          return null;
        }
        return earlyRuntime.startMaintenance();
      },
      applyMaintenance: (maintenance) => {
        if (lifecycle.closePreludeStarted) {
          clearInterval(maintenance.tickInterval);
          clearInterval(maintenance.healthInterval);
          clearInterval(maintenance.dedupeCleanup);
          if (maintenance.mediaCleanup) {
            clearInterval(maintenance.mediaCleanup);
          }
          clearInterval(maintenance.worktreeCleanup);
          maintenance.skillCuratorCleanup();
          return;
        }
        runtimeState.tickInterval = maintenance.tickInterval;
        runtimeState.healthInterval = maintenance.healthInterval;
        runtimeState.dedupeCleanup = maintenance.dedupeCleanup;
        runtimeState.mediaCleanup = maintenance.mediaCleanup;
        runtimeState.worktreeCleanup = maintenance.worktreeCleanup;
        runtimeState.skillCuratorCleanup = maintenance.skillCuratorCleanup;
      },
      shouldStartCron: () => !lifecycle.closePreludeStarted && !cronStartState.handled,
      markCronStartHandled: () => {
        cronStartState.handled = true;
      },
      cronState: runtimeState.cronState,
      cronReconciliation,
      cronConfig: cfgAtStart,
      logCron,
      log,
      recordPostReadyMemory: () => {
        startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
      },
    });
    // The loop closes the previous server before this generation starts, so retired
    // plugin installs are safe to remove. Wait for an idle window and resolve current
    // install paths at execution time so cleanup cannot remove active code or delay a turn.
    postReadyState.retainedPluginCleanupHandle = gatewayRuntimeServices.scheduleGatewayIdleTask({
      delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      isClosing: () => lifecycle.closePreludeStarted,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run: async () => {
        const { cleanupRetainedPluginInstallGenerations } =
          await import("./server-retained-plugin-cleanup.js");
        await cleanupRetainedPluginInstallGenerations({ log });
      },
      log,
      errorMessage: "retained npm generation cleanup failed",
    });
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
}
