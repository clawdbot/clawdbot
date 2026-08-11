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
import { publishGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { getRequiredSharedGatewaySessionGeneration } from "./server-shared-auth-generation.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
const [POST_READY_MAINTENANCE_DELAY_MS, RETAINED_PLUGIN_CLEANUP_DELAY_MS] = [250, 30_000];

type GatewayStartedRuntime = GatewayKernelRuntime & GatewayHttpTransport;

export async function finishGatewayStartup(params: {
  kernelRuntime: GatewayStartedRuntime;
  port: number;
  opts: GatewayStartedRuntime["opts"];
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
    kernelRuntime: runtime,
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
    kernel,
    startupTrace,
    broadcast,
    broadcastToConnIds,
    clients,
    sharedGatewaySessionGenerationState,
    controlUiDeviceAuthMigration,
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
    stopRegisteredPostReadySidecars,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    residentRegistry,
  } = runtime;
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
  kernel.setDispatchReady(true);
  startupTrace.mark("http.bound");
  let databaseVerifierHandle: { stop: () => void | Promise<void> } | null = null;
  const databaseIntegrityResident = residentRegistry.register({
    name: "database-integrity-verifier",
    start: async () => {
      if (minimalTestGateway) {
        return;
      }
      const { startOpenClawDatabaseIntegrityVerifier } =
        await import("../state/openclaw-database-verify.js");
      databaseVerifierHandle = startOpenClawDatabaseIntegrityVerifier({ env: process.env });
      kernel.addGatewayLifetimeSidecar(databaseVerifierHandle);
    },
    stop: async () => await databaseVerifierHandle?.stop(),
  });
  const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
  let postAttachRuntimeReturned = false;
  let scheduledServicesActivated = false;
  const loadScheduledServicesModule = createLazyPromise(
    () => import("./server-runtime-services.js"),
    { cacheRejections: true },
  );
  const scheduledServicesResident = residentRegistry.register({
    name: "scheduled-services",
    start: () => {
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
        kernel.setScheduledServiceHandles(activated);
      });
    },
    stop: async () => {
      await runtimeState.stopOutboundDeliveryRecovery();
      runtimeState.heartbeatRunner.stop();
    },
  });
  const activateScheduledServicesWhenReady = scheduledServicesResident.start;
  const { createGatewayServerActiveWorkInspectors } = await import("./server-active-work.js");
  const postAttachHandles = await startupTrace.measure("runtime.post-attach", () =>
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
          broadcastToConnIds,
          getClientConnIds: gatewayRequestContext.getClientConnIds!,
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
          recoveryRuntime: gatewayInstanceRuntime.recovery,
          logHooks,
          logChannels,
          unlockStartupMethods: kernel.unlockStartupMethods,
          refreshChatMetadata: chatMetadataLifecycle.refresh,
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
            kernel.setPluginServices(pluginServices);
          },
          onPostReadySidecars: (postReadySidecars) => {
            kernel.setPostReadySidecars(postReadySidecars);
            stopPostReadySidecarsAfterCloseStarted({
              postReadySidecars,
              closeStarted: lifecycle.closePreludeStarted,
            });
            if (lifecycle.closePreludeStarted) {
              kernel.setPostReadySidecars([]);
            }
          },
          onGatewayLifetimeSidecars: (gatewayLifetimeSidecars) => {
            kernel.setGatewayLifetimeSidecars(
              publishGatewayLifetimeSidecars({
                registered: runtimeState.gatewayLifetimeSidecars,
                published: gatewayLifetimeSidecars,
                closeStarted: lifecycle.closePreludeStarted,
                stopAfterCloseStarted: stopPostReadySidecarsAfterCloseStarted,
              }),
            );
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
                      kernel.addGatewayLifetimeSidecar(sidecar);
                    },
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
          activeWorkInspectors: createGatewayServerActiveWorkInspectors(gatewayRequestContext),
          residentRegistry,
          providerAuthPrewarm: {
            getConfig: getRuntimeConfig,
          },
        }),
    ),
  );
  kernel.setPostAttachHandles(postAttachHandles);
  startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
  startupTrace.mark("ready");
  if (sidecarStartup === "defer") {
    log.info("gateway ready");
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  if (!minimalTestGateway) {
    await databaseIntegrityResident.start();
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
  const configReloaderParams: Parameters<typeof startManagedGatewayConfigReloader>[0] = {
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
  };
  const configReloaderResident = residentRegistry.register({
    name: "config-reloader",
    start: () => startManagedGatewayConfigReloader(configReloaderParams),
    stop: async () => await runtimeState.configReloader.stop(),
  });
  kernel.setConfigReloaderHandle(configReloaderResident.start());
  await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err: unknown) => {
    log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
  });
  if (!minimalTestGateway) {
    const gatewayRuntimeServices = await loadScheduledServicesModule();
    const maintenanceResident = residentRegistry.register({
      name: "post-ready-maintenance",
      start: () => {
        postReadyState.maintenanceTimer =
          gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
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
            applyMaintenance: async (maintenance) => {
              if (lifecycle.closePreludeStarted) {
                clearInterval(maintenance.tickInterval);
                clearInterval(maintenance.healthInterval);
                clearInterval(maintenance.dedupeCleanup);
                await maintenance.stopMediaCleanup();
                clearInterval(maintenance.worktreeCleanup);
                maintenance.skillCuratorCleanup();
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
      },
      stop: () => {
        if (postReadyState.maintenanceTimer) {
          clearTimeout(postReadyState.maintenanceTimer);
          postReadyState.maintenanceTimer = null;
        }
      },
    });
    maintenanceResident.start();
    // The loop closes the previous server before this generation starts, so retired
    // plugin installs are safe to remove. Wait for an idle window and resolve current
    // install paths at execution time so cleanup cannot remove active code or delay a turn.
    const retainedPluginCleanupResident = residentRegistry.register({
      name: "retained-plugin-cleanup",
      start: () => {
        postReadyState.retainedPluginCleanupHandle = gatewayRuntimeServices.scheduleGatewayIdleTask(
          {
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
          },
        );
      },
      stop: () => {
        postReadyState.retainedPluginCleanupHandle?.stop();
        postReadyState.retainedPluginCleanupHandle = null;
      },
    });
    retainedPluginCleanupResident.start();
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
}
