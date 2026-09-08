import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
} from "../config/io.js";
import { isNixMode } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { resolveGatewayAuth } from "./auth.js";
import { diffGatewayReloadPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "./config-reload-plan.js";
import { collectGatewayProcessMemoryUsageMb, finishGatewayRestartTrace } from "./restart-trace.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { refreshConnectedNodeSurfaceCaches } from "./server-methods/nodes.read.js";
import { assertGatewayRuntimeSecurityConfig } from "./server-runtime-config.js";
import { getRequiredSharedGatewaySessionGeneration } from "./server-shared-auth-generation.js";
import type { GatewayHttpTransport } from "./server-transport-bridge.js";
import { disconnectDisallowedGatewayBrowserOriginClients } from "./server/ws-origin-policy.js";
import { DEFAULT_TERMINAL_DETACH_SECONDS } from "./terminal/session-limits.js";

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
    nodeRegistry,
    nodeDesktopService,
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
    pluginMetadataSnapshot,
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
    startEarlyRuntime,
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
    stopRegisteredPostReadySidecars,
    registerPostReadySidecars,
    registerGatewayLifetimeSidecars,
    registerConnectionDependentSidecars,
    unregisterConnectionDependentSidecar,
    chatMetadataLifecycle,
    gatewayRequestContext,
    gatewayInstanceRuntime,
    getPluginMetadataSnapshot,
    getPluginNodeCapabilities,
  } = runtime;
  const startupPluginRuntimeClaim = kernel.pluginRuntimeGeneration.currentClaim();
  const { attachGatewayWsHandlers } = await startupTrace.measure(
    "gateway.ws-imports",
    () => import("./server-ws-runtime.js"),
  );
  await startupTrace.measure("gateway.ws-attach", () =>
    attachGatewayWsHandlers({
      wss,
      clients,
      connectionWork: runtime.connectionWork,
      bootId,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      pluginSurfaceScheme: gatewayTls.enabled ? "https" : "http",
      getPluginNodeCapabilities,
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
  // Health can answer as soon as the listener binds. Discovery, remote-skill
  // setup, and maintenance do not determine liveness, so keep them off that
  // critical path while still completing before usable readiness.
  const earlyRuntime = await startEarlyRuntime();
  const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
  let postAttachRuntimeReturned = false;
  let scheduledServicesActivated = false;
  const loadScheduledServicesModule = createLazyPromise(
    () => import("./server-runtime-services.js"),
    { cacheRejections: true },
  );
  const activateScheduledServicesWhenReady = () => {
    if (
      opts.updateCanary ||
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
  const { createGatewayServerActiveWorkInspectors } = await startupTrace.measure(
    "gateway.active-work-import",
    () => import("./server-active-work.js"),
  );
  const activeWorkInspectors = createGatewayServerActiveWorkInspectors(gatewayRequestContext);
  const trackStartupWork = <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    // Register before starting, without lending the connection scope to long-lived services.
    const operation = Promise.resolve().then(() => run(runtime.connectionWork.signal));
    return runtime.connectionWork.track(() => operation);
  };
  const postAttachHandles = await trackStartupWork(() =>
    startupTrace.measure("runtime.post-attach", () =>
      loadGatewayStartupPostAttachModule().then(({ startGatewayPostAttachRuntime }) =>
        startGatewayPostAttachRuntime({
          minimalTestGateway,
          updateCanary: opts.updateCanary,
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
          ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
          pluginRuntimeClaim: startupPluginRuntimeClaim,
          getCurrentPluginRegistry: () => pluginRuntime.registry,
          getCurrentPluginMetadataSnapshot: getPluginMetadataSnapshot,
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
          getCronService: () => runtimeState.cronState.cron,
          onChannelsStarted: () => {
            releaseStartupAccountStarts();
          },
          onPluginServices: (pluginServices) => {
            kernel.pluginRuntimeGeneration.publishServices(
              startupPluginRuntimeClaim,
              pluginServices,
            );
          },
          onPostReadySidecars: registerPostReadySidecars,
          onGatewayLifetimeSidecars: registerGatewayLifetimeSidecars,
          trackStartupWork,
          unregisterConnectionDependentSidecar,
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
                      registerConnectionDependentSidecars([sidecar]);
                    },
                    unregisterSidecar: unregisterConnectionDependentSidecar,
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
    ),
  );
  kernel.setPostAttachHandles(postAttachHandles, startupPluginRuntimeClaim);
  startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
  startupTrace.mark("ready");
  if (sidecarStartup === "defer") {
    log.info("gateway ready");
  }
  finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
  if (opts.updateCanary) {
    // Copied queues and jobs must not resume; the canary owns only startup probes.
    return { startupSettled: postAttachHandles.startupSettled };
  }
  if (!minimalTestGateway) {
    const { startOpenClawDatabaseIntegrityVerifier } =
      await import("../state/openclaw-database-verify.js");
    kernel.addGatewayLifetimeSidecar(startOpenClawDatabaseIntegrityVerifier({ env: process.env }));
  }
  postAttachRuntimeReturned = true;
  activateScheduledServicesWhenReady();

  const { startManagedGatewayConfigReloader } = await import("./server-reload-managed.js");
  const assertRuntimeSecurityConfig = (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => {
    assertGatewayRuntimeSecurityConfig({
      cfg,
      port,
      bindHost,
      controlUiEnabled: opts.controlUiEnabled ?? cfg.gateway?.controlUi?.enabled ?? true,
      tailscaleMode: runtime.tailscaleMode,
      resolvedAuth: resolveGatewayAuth({
        authConfig: cfg.gateway?.auth,
        tailscaleMode: runtime.tailscaleMode,
        env,
      }),
    });
  };
  const configReloaderParams: Parameters<typeof startManagedGatewayConfigReloader>[0] = {
    configRevisionProjector: gatewayRequestContext.configRevisionProjector,
    resolveGatewayContext: resolvePluginGatewayContext,
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
          const prepared = await activateRuntimeSecrets(candidate.runtimeConfig, {
            reason: "reload",
            activate: false,
            env: candidate.runtimeEnv.env,
            includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
          });
          const previousConfig = getRuntimeConfig();
          // Runtime defaults and startup overlays are not authored changes; they
          // must not classify a hot write as a restart and bypass this validation.
          const plan = buildGatewayReloadPlan(
            diffGatewayReloadPaths(
              getRuntimeConfigSourceSnapshot() ?? startupLastGoodSnapshot.sourceConfig,
              sourceConfig,
              listConfigReloadRefinementPrefixes(),
            ),
            { previousConfig, candidateConfig: prepared.config },
          );
          if (!plan.restartGateway) {
            assertRuntimeSecurityConfig(prepared.config, candidate.runtimeEnv.env);
          }
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
      if (previousCronState !== nextState.cronState) {
        cronStartState.handled = true;
      }
    },
    getPluginMetadataSnapshot,
    getPluginRegistry: () => runtime.pluginRuntime.registry,
    startChannel,
    stopChannel,
    getChannelAutostartSuppression: channelManager.getAutostartSuppression,
    stopPostReadySidecars: stopRegisteredPostReadySidecars,
    reloadPlugins: kernel.reloadPlugins,
    reloadPluginServices: async (config, serviceIds) => {
      const services = runtimeState.pluginServices;
      if (!services) {
        throw new Error("Plugin services are not attached");
      }
      await services.reload(config, serviceIds);
    },
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
    reconcileRuntimePolicy: async (nextConfig, phase) => {
      terminalSessions.closeDisallowedAgents((agentId) => terminalLaunchPolicy.resolve(agentId).ok);
      if (phase !== "committed") {
        return;
      }
      terminalSessions.updateDetachGraceMs(
        (nextConfig.gateway?.terminal?.detachedSessionTimeoutSeconds ??
          DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
      );
      disconnectDisallowedGatewayBrowserOriginClients(clients, nextConfig);
      for (const nodeSession of nodeRegistry.refreshRuntimePolicy(nextConfig)) {
        refreshConnectedNodeSurfaceCaches({ context: gatewayRequestContext, nodeSession });
      }
      await Promise.all([
        nodeDesktopService.reconcileRuntimePolicy(),
        runtimeState.discovery?.update({ mdnsMode: nextConfig.discovery?.mdns?.mode }),
      ]);
    },
    commitRuntimePolicy: (nextConfig) => {
      controlUiRootLifecycle.setEnabled(
        opts.controlUiEnabled ?? nextConfig.gateway?.controlUi?.enabled ?? true,
      );
      runtime.configureDiagnostics(nextConfig);
      const rateLimit = nextConfig.gateway?.auth?.rateLimit;
      authRateLimiter.updateConfig(rateLimit);
      browserAuthRateLimiter.updateConfig({ ...rateLimit, exemptLoopback: false });
      nodeReapprovalCoordinator.updateConfig(rateLimit);
      terminalLaunchPolicy.commitConfig();
      workerLiveEvents?.rebindAll(nextConfig);
    },
    acceptTerminalConfig: terminalLaunchPolicy.acceptConfig,
    channelManager,
    activateRuntimeSecrets,
    assertRuntimeSecurityConfig,
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
    const startupInstallPaths = [
      ...Object.values(pluginMetadataSnapshot?.index.installRecords ?? {}).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
      ...(pluginMetadataSnapshot?.plugins.flatMap((record) =>
        record.setupSource
          ? [record.rootDir, record.source, record.setupSource]
          : [record.rootDir, record.source],
      ) ?? []),
    ];
    registerGatewayLifetimeSidecars([
      gatewayRuntimeServices.scheduleGatewayIdleTask({
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
      }),
    ]);
  } else {
    startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
  }
  return { startupSettled: postAttachHandles.startupSettled };
}
