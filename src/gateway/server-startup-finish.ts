import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
} from "../config/io.js";
import { isNixMode } from "../config/paths.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { collectGatewayProcessMemoryUsageMb, finishGatewayRestartTrace } from "./restart-trace.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { getRequiredSharedGatewaySessionGeneration } from "./server-shared-auth-generation.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
const [POST_READY_MAINTENANCE_DELAY_MS, RETAINED_PLUGIN_CLEANUP_DELAY_MS] = [250, 30_000];

type GatewayStartedRuntime = GatewayKernelRuntime & GatewayHttpTransport;

export async function finishGatewayStartup(params: {
  kernelRuntime: GatewayStartedRuntime;
  port: number;
  bootId: string;
  opts: GatewayStartedRuntime["opts"];
  log: GatewayLogger;
  logHealth: GatewayLogger;
  logWsControl: GatewayLogger;
  logHooks: GatewayLogger;
  logChannels: GatewayLogger;
  logCron: GatewayLogger;
  logReload: GatewayLogger;
  loadGatewayStartupPostAttachModule: () => Promise<
    typeof import("./server-startup-post-attach.js")
  >;
  waitForPostReadyWork: () => Promise<void>;
}) {
  const {
    kernelRuntime: runtime,
    port,
    bootId,
    opts,
    log,
    logHealth,
    logWsControl,
    logHooks,
    logChannels,
    logCron,
    logReload,
    loadGatewayStartupPostAttachModule,
  } = params;
  const {
    minimalTestGateway,
    deps,
    runtimeState,
    kernel,
    startupTrace,
    broadcast,
    broadcastToConnIds,
    clients,
    sharedGatewaySessionGenerationState,
    workerEnvironmentService,
    workerPlacementRuntime,
    terminalLaunchPolicy,
    terminalSessions,
    startChannel,
    stopChannel,
    getAttachedGatewayMethodRegistry,
    lifecycle,
    startupState,
    pluginRuntime,
    resolvePluginGatewayContext,
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
    pluginMetadata,
    pluginMetadataOwner,
    pluginLookUpTable,
    ambientEnvTriggers,
    replaceAttachedPluginRuntime,
    refreshAttachedGatewayDiscovery,
    wss,
    httpBindHosts,
    startChannels,
    broadcastPluginEvent,
    controlUiBasePath,
    controlUiRootLifecycle,
    sidecarStartup,
    workerLiveEvents,
    earlyRuntime,
    cfgAtStart,
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
    stopRegisteredGatewayLifetimeSidecars,
    stopRegisteredPostReadySidecars,
    registerPostReadySidecars,
    registerGatewayLifetimeSidecars,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    getPluginMetadata,
  } = runtime;
  const startupPluginRuntimeClaim = kernel.pluginRuntimeGeneration.currentClaim();
  const unregisterGatewayLifetimeSidecar = (sidecar: GatewayPostReadySidecarHandle) => {
    kernel.setGatewayLifetimeSidecars(
      runtimeState.gatewayLifetimeSidecars.filter((registered) => registered !== sidecar),
    );
  };
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
      bootId,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      pluginSurfaceScheme: gatewayTls.enabled ? "https" : "http",
      getPluginNodeCapabilities: () =>
        withCoreCanvasNodeCapability(
          listPluginNodeCapabilities(pluginRuntime.registry),
          isCoreCanvasHostEnabled(getRuntimeConfig()),
        ),
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      nodeReapprovalCoordinator,
      preauthHandshakeTimeoutMs,
      isStartupPending: isGatewayStartupPending,
      isPendingWorkerNodeSetup: workerEnvironmentService?.hasPendingNodeEnrollmentSetup,
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
  kernel.setDispatchReady(true);
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
        resolveGatewayContext: resolvePluginGatewayContext,
      });
      kernel.setScheduledServiceHandles(activated);
    });
  };
  const { createGatewayServerActiveWorkInspectors } = await import("./server-active-work.js");
  const activeWorkInspectors = createGatewayServerActiveWorkInspectors(gatewayRequestContext);
  const postAttachHandles = await startupTrace.measure("runtime.post-attach", () =>
    loadGatewayStartupPostAttachModule().then(({ startGatewayPostAttachRuntime }) =>
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
        broadcastToConnIds,
        getClientConnIds: gatewayRequestContext.getClientConnIds!,
        broadcastPluginEvent,
        controlUiBasePath,
        controlUiRootLifecycle,
        gatewayPluginConfigAtStart,
        activationSourceConfig: startupActivationSourceConfig,
        pluginManifestRecords,
        ...(pluginMetadata ? { pluginMetadata } : {}),
        pluginRuntimeClaim: startupPluginRuntimeClaim,
        getCurrentPluginRegistry: () => pluginRuntime.registry,
        getCurrentPluginMetadata: getPluginMetadata,
        ambientEnvTriggers,
        pluginRegistry: pluginRuntime.registry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        recoveryRuntime: gatewayInstanceRuntime.recovery,
        resolveGatewayContext: gatewayRequestContext.resolveGatewayContext!,
        logHooks,
        logChannels,
        unlockStartupMethods: kernel.unlockStartupMethods,
        refreshChatMetadata: chatMetadataLifecycle.refresh,
        loadStartupPlugins: async () => {
          const { loadGatewayStartupPluginRuntime } = await loadStartupPluginsModule();
          return loadGatewayStartupPluginRuntime({
            cfg: gatewayPluginConfigAtStart,
            activationSourceConfig: startupActivationSourceConfig,
            workspaceDir: runtime.pluginWorkspaceDir,
            log,
            baseMethods,
            coreGatewayMethodNames,
            hostServices: pluginHostServices,
            startupPluginIds,
            pluginLookUpTable,
            startupTrace,
            ambientEnvTriggers,
            resolveGatewayContext: resolvePluginGatewayContext,
            pluginRuntimeClaim: startupPluginRuntimeClaim,
            getCurrentPluginRegistry: () => pluginRuntime.registry,
          });
        },
        onStartupPluginsLoading: () => {
          startupState.pendingReason = "startup-sidecars";
        },
        onStartupPluginsLoaded: async (loaded) => {
          if (!startupPluginRuntimeClaim.publish(() => replaceAttachedPluginRuntime(loaded))) {
            loaded.retireGatewayRuntimeBindings?.();
            return;
          }
          startupState.pendingReason = "startup-sidecars";
          await refreshAttachedGatewayDiscovery(loaded.pluginRegistry, startupPluginRuntimeClaim);
        },
        getCronService: () =>
          runtimeState?.cronState.cron as PluginHookGatewayCronService | undefined,
        onChannelsStarted: () => {
          releaseStartupAccountStarts();
        },
        onPluginServices: (pluginServices) => {
          kernel.pluginRuntimeGeneration.publishServices(startupPluginRuntimeClaim, pluginServices);
        },
        onPostReadySidecars: registerPostReadySidecars,
        onGatewayLifetimeSidecars: registerGatewayLifetimeSidecars,
        stopRegisteredPostReadySidecars,
        stopRegisteredGatewayLifetimeSidecars,
        unregisterGatewayLifetimeSidecar,
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
                    registerGatewayLifetimeSidecars([sidecar]);
                  },
                  unregisterSidecar: unregisterGatewayLifetimeSidecar,
                });
              },
            }
          : {}),
        onSidecarsReady: () => {
          kernel.markSidecarsReady();
          activateScheduledServicesWhenReady();
        },
        isClosing: () => lifecycle.closePreludeStarted,
        startupTrace,
        sidecarStartup,
        waitForPostReadyWork: params.waitForPostReadyWork,
        activeWorkInspectors,
        providerAuthPrewarm: {
          getConfig: getRuntimeConfig,
        },
      }),
    ),
  );
  kernel.setPostAttachHandles(postAttachHandles, startupPluginRuntimeClaim);
  startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
  startupTrace.mark("ready");
  if (sidecarStartup === "defer") {
    log.info("gateway ready");
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  if (!minimalTestGateway) {
    const { startOpenClawDatabaseIntegrityVerifier } =
      await import("../state/openclaw-database-verify.js");
    kernel.addGatewayLifetimeSidecar(startOpenClawDatabaseIntegrityVerifier({ env: process.env }));
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
  const configReloaderParams: Parameters<typeof startManagedGatewayConfigReloader>[0] = {
    configRevisionProjector: gatewayRequestContext.configRevisionProjector,
    resolveGatewayContext: resolvePluginGatewayContext,
    minimalTestGateway,
    initialConfig: cfgAtStart,
    pluginMetadataOwner,
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
            manifestRegistry: candidate.pluginMetadata.manifestRegistry,
            includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
          });
          return candidate;
        },
      }),
    deps,
    broadcast,
    getState: kernel.getReloadState,
    setState: (nextState) => {
      kernel.setReloadHookState(nextState);
      kernel.swapHeartbeatRunner(nextState.heartbeatRunner);
      const previousCronState = kernel.swapCronState(nextState.cronState);
      kernel.setChannelHealthMonitor(nextState.channelHealthMonitor);
      if (previousCronState !== nextState.cronState) {
        cronStartState.handled = true;
      }
    },
    getPluginMetadata,
    startChannel,
    stopChannel,
    getChannelAutostartSuppression: channelManager.getAutostartSuppression,
    stopPostReadySidecars: stopRegisteredPostReadySidecars,
    reloadPlugins: kernel.reloadPlugins,
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
  };
  kernel.setConfigReloaderHandle(startManagedGatewayConfigReloader(configReloaderParams));
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
        return earlyRuntime.startMaintenance(activeWorkInspectors);
      },
      applyMaintenance: async (maintenance) => {
        if (lifecycle.closePreludeStarted) {
          await gatewayRuntimeServices.clearGatewayMaintenanceHandles(maintenance);
          return;
        }
        // Publish the stop owner before cleanup can touch SQLite or state paths;
        // shutdown may begin immediately after this synchronous handoff.
        kernel.setMaintenanceHandles(maintenance);
        maintenance.startMediaCleanup();
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
    // This Gateway may still import boot-generation code after an install retires
    // it. Capture those paths before the idle delay; cleanup also protects the new ledger.
    const startupInstallPaths = [...pluginMetadata.workspaces.values()].flatMap((snapshot) =>
      Object.values(snapshot.index.installRecords)
        .flatMap((record) => (record.installPath ? [record.installPath] : []))
        .concat(
          snapshot.plugins.flatMap((record) =>
            record.setupSource
              ? [record.rootDir, record.source, record.setupSource]
              : [record.rootDir, record.source],
          ),
        ),
    );
    postReadyState.retainedPluginCleanupHandle = gatewayRuntimeServices.scheduleGatewayIdleTask({
      delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
      isClosing: () => lifecycle.closePreludeStarted,
      isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
      run: async () => {
        const { cleanupRetainedPluginInstallGenerations } =
          await import("./server-retained-plugin-cleanup.js");
        await cleanupRetainedPluginInstallGenerations({ log, startupInstallPaths });
      },
      log,
      errorMessage: "retained npm generation cleanup failed",
    });
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
  return { startupSettled: postAttachHandles.startupSettled };
}
