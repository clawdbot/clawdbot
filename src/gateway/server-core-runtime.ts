import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { completePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isGatewayWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import { restartRunningChannelAccounts } from "./channel-thaw-restart.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { revokeAttachGrantsForSession } from "./mcp-grant-store.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { isLoopbackHost } from "./net.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import {
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";

type GatewayLifecycle = Awaited<ReturnType<typeof prepareGatewayLifecycle>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

type GatewayStartupChannelPlugin = {
  id: ChannelId;
  meta: { aliases?: readonly string[] };
};

function listGatewayStartupChannelPlugins(): GatewayStartupChannelPlugin[] {
  return listLoadedChannelPlugins() as GatewayStartupChannelPlugin[];
}

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

function approvalRequestTargetsSession(
  request: unknown,
  sessionKeys: ReadonlySet<string>,
  sessionId: string,
): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const record = request as { sessionKey?: unknown; sessionId?: unknown };
  return (
    (typeof record.sessionId === "string" && record.sessionId === sessionId) ||
    (typeof record.sessionKey === "string" && sessionKeys.has(record.sessionKey))
  );
}

export async function startGatewayCoreRuntime(input: {
  lifecycleRuntime: GatewayLifecycle;
  port: number;
  log: GatewayLogger;
  logDiscovery: GatewayLogger;
  logHealth: GatewayLogger;
  logChannels: GatewayLogger;
  loadGatewayStartupEarlyModule: () => Promise<typeof import("./server-startup-early.js")>;
  loadGatewayPluginBootstrapModule: () => Promise<typeof import("./server-plugin-bootstrap.js")>;
  loadGatewayModelCatalog: typeof import("./server-model-catalog.js").loadGatewayModelCatalog;
  loadGatewayModelCatalogSnapshot: typeof import("./server-model-catalog.js").loadGatewayModelCatalogSnapshot;
  readPreparedGatewayModelCatalogSnapshot: typeof import("./server-model-catalog.js").readPreparedGatewayModelCatalogSnapshot;
  readPreparedGatewayModelCatalog: typeof import("./server-model-catalog.js").readPreparedGatewayModelCatalog;
}) {
  const {
    lifecycleRuntime: runtime,
    port,
    log,
    logDiscovery,
    logHealth,
    logChannels,
    loadGatewayStartupEarlyModule,
    loadGatewayPluginBootstrapModule,
    loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalog,
  } = input;
  const {
    minimalTestGateway,
    cfgAtStart,
    gatewayTls,
    bindHost,
    tailscaleMode,
    nodeRegistry,
    pluginRuntime,
    broadcast,
    nodeSendToAllSubscribed,
    refreshGatewayHealthSnapshotWithRuntime,
    dedupe,
    chatAbortControllers,
    chatQueuedTurns,
    restartRecoveryCandidates,
    chatRunState,
    removeChatRun,
    agentRunSeq,
    nodeSendToSession,
    runtimeState,
    kernel,
    startupTrace,
    channelManager,
    readinessEventLoopHealth,
    workerDispatchAuthority,
    clients,
    startChannel,
    stopChannel,
    sharedGatewaySessionGenerationState,
    resolveSharedGatewaySessionGenerationForConfig,
    sessionMessageSubscribers,
    sessionEventSubscribers,
    toolEventRecipients,
    broadcastToConnIds,
    terminalSessions,
    controlUiBasePath,
    workerEnvironmentService,
    workerPlacementDispatchAvailable,
    workerPlacementControlAvailable,
    workerDesktopObserveAvailable,
    desktopObserveAvailable,
    desktopSessionRegistry,
    listStartupChannelGatewayMethods,
    coreGatewayMethodNames,
    pluginHostServices,
    baseMethods,
    pluginWorkspaceDir,
    ambientEnvTriggers,
    workerEnvironmentStartup,
    broadcastPluginEvent,
    activateRuntimeSecrets,
    residentRegistry,
  } = runtime;
  if (desktopSessionRegistry) {
    kernel.addGatewayLifetimeSidecar({ stop: () => desktopSessionRegistry.stopAll() });
  }
  let earlyRuntimePromise: ReturnType<
    Awaited<ReturnType<typeof loadGatewayStartupEarlyModule>>["startGatewayEarlyRuntime"]
  > | null = null;
  const startEarlyRuntime = () => {
    earlyRuntimePromise ??= loadGatewayStartupEarlyModule().then(({ startGatewayEarlyRuntime }) =>
      startGatewayEarlyRuntime({
        minimalTestGateway,
        cfgAtStart,
        port,
        gatewayTls,
        gatewayDirectReachable: !isLoopbackHost(bindHost),
        tailscaleMode,
        log,
        logDiscovery,
        nodeRegistry,
        pluginRegistry: pluginRuntime.registry,
        broadcast,
        nodeSendToAllSubscribed,
        getPresenceVersion,
        getHealthVersion,
        refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
        restartRunningChannels: async () =>
          await restartRunningChannelAccounts(channelManager, {
            shouldContinue: () => !isGatewayWorkAdmissionClosed(),
            onError: (message) => logHealth.error(message),
          }),
        refreshPresence: () =>
          broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion }),
        resetEventLoopHealth: readinessEventLoopHealth.reset,
        logHealth,
        dedupe,
        chatAbortControllers,
        chatQueuedTurns,
        restartRecoveryCandidates,
        chatRunState,
        removeChatRun,
        agentRunSeq,
        nodeSendToSession,
        ...(typeof cfgAtStart.attachments?.ttlHours === "number"
          ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.attachments.ttlHours) }
          : {}),
        skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
        getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
        setSkillsRefreshTimer: (timer) => {
          runtimeState.skillsRefreshTimer = timer;
        },
        getRuntimeConfig,
        startupTrace,
      }),
    );
    return earlyRuntimePromise;
  };
  const discoveryResident = residentRegistry.register({
    name: "bonjour-discovery",
    start: startEarlyRuntime,
    stop: async () => {
      const earlyRuntime = await startEarlyRuntime();
      await earlyRuntime.bonjourStop?.();
    },
  });
  const taskAndSkillsResident = residentRegistry.register({
    name: "task-and-skills-runtime",
    start: async () => await discoveryResident.start(),
    stop: async () => {
      const earlyRuntime = await startEarlyRuntime();
      earlyRuntime.skillsChangeUnsub();
      const { stopTaskRegistryMaintenance } = await import("../tasks/task-registry.maintenance.js");
      stopTaskRegistryMaintenance();
    },
  });
  const earlyRuntime = await startupTrace.measure("runtime.early", () =>
    taskAndSkillsResident.start(),
  );
  kernel.setEarlyRuntimeHandles(earlyRuntime);

  const [{ startGatewayEventSubscriptions }, { startGatewayRuntimeServices }] =
    await startupTrace.measure("runtime.post-early-imports", () =>
      Promise.all([
        import("./server-runtime-subscriptions.js"),
        import("./server-runtime-startup-services.js"),
      ]),
    );
  const eventSubscriptionsResident = residentRegistry.register({
    name: "event-subscriptions",
    start: () =>
      startGatewayEventSubscriptions({
        log,
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        agentRunSeq,
        chatRunState,
        toolEventRecipients,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        chatAbortControllers,
        restartRecoveryCandidates,
        terminalSessions,
      }),
    stop: async () => {
      await runtimeState.agentUnsub?.();
      runtimeState.heartbeatUnsub?.();
      runtimeState.transcriptUnsub?.();
      runtimeState.lifecycleUnsub?.();
      runtimeState.taskUnsub?.();
    },
  });
  const { sessionCompanion, sessionObserver, ...runtimeSubscriptionUnsubs } =
    await startupTrace.measure("runtime.subscriptions", () => eventSubscriptionsResident.start());
  Object.assign(runtimeState, runtimeSubscriptionUnsubs);

  const runtimeServices = await startupTrace.measure("runtime.services", () =>
    startGatewayRuntimeServices({
      minimalTestGateway,
      cfgAtStart,
      channelManager,
      log,
    }),
  );
  Object.assign(runtimeState, runtimeServices);

  const { createOperatorApprovalSessionEventRuntime } =
    await import("./operator-approval-session-events.js");
  // Managers publish through this runtime, while replay routes durable
  // expiry back through the owning manager to release its parked waiter once.
  const approvalManagersForReplay = new Map<
    string,
    Pick<ExecApprovalManager, "reconcileDurableTerminal">
  >();
  const approvalSessionEvents = createOperatorApprovalSessionEventRuntime({
    clients,
    sessionMessageSubscribers,
    broadcastToConnIds,
    controlUiBasePath,
    reconcileTerminal: (record) => {
      const manager = approvalManagersForReplay.get(record.kind);
      return manager?.reconcileDurableTerminal(record) ?? false;
    },
  });
  // One validator owns both request-time and manager-time checks. Worker claims
  // are always read from the authoritative operational placement store.
  const validateAgentRuntimeApprovalAuthority = createAgentRuntimeApprovalAuthorityValidator(
    workerEnvironmentStartup?.placementStore,
  );

  const {
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    unregisterApprovalAuthorityObserver,
    extraHandlers,
    coreGatewayHandlers,
  } = await startupTrace.measure("gateway.handlers", async () => {
    const [{ createGatewayAuxHandlers }, { coreGatewayHandlers: coreGatewayHandlersLocal }] =
      await Promise.all([import("./server-aux-handlers.js"), import("./server-methods.js")]);
    return {
      ...createGatewayAuxHandlers({
        log,
        chatAbortControllers,
        activateRuntimeSecrets,
        sharedGatewaySessionGenerationState,
        resolveSharedGatewaySessionGenerationForConfig,
        clients,
        startChannel,
        stopChannel,
        getChannelAutostartSuppression: channelManager.getAutostartSuppression,
        logChannels,
        registerWorkerTurnClaimClosedHandler: workerEnvironmentStartup?.placementStore
          ? (handler) =>
              workerEnvironmentStartup.placementStore.registerTurnClaimClosedHandler(handler)
          : undefined,
        validateAgentRuntimeDelegatedAuthority: (authority) =>
          validateAgentRuntimeApprovalAuthority({
            kind: "agentRuntime",
            agentId: "approval-manager",
            sessionKey: "approval-manager",
            operationalRunInstance: authority.operationalRunInstance,
            delegatedAuthority: authority,
          }),
        onApprovalLifecycle: approvalSessionEvents.publish,
      }),
      coreGatewayHandlers: coreGatewayHandlersLocal,
    };
  });
  kernel.addGatewayLifetimeSidecar({
    stop: async () => {
      unregisterApprovalAuthorityObserver();
    },
  });
  approvalManagersForReplay.set("exec", execApprovalManager);
  approvalManagersForReplay.set("plugin", pluginApprovalManager);
  approvalManagersForReplay.set("system-agent", systemAgentApprovalManager);
  workerDispatchAuthority.revoke = ({ sessionId, sessionKeys }) => {
    const keys = new Set(sessionKeys);
    for (const sessionKey of keys) {
      revokeAttachGrantsForSession(sessionKey);
    }
    for (const record of execApprovalManager.listPendingRecords()) {
      if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
        execApprovalManager.expire(record.id, "worker-dispatch");
      }
    }
    for (const record of pluginApprovalManager.listPendingRecords()) {
      if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
        pluginApprovalManager.expire(record.id, "worker-dispatch");
      }
    }
  };
  const attachedGatewayExtraHandlers: GatewayRequestHandlers = {
    ...pluginRuntime.registry.gatewayHandlers,
    ...extraHandlers,
  };
  let attachedPluginGatewayHandlerKeys = new Set(
    Object.keys(pluginRuntime.registry.gatewayHandlers),
  );
  const buildAttachedGatewayMethodRegistry = (
    nextPluginRegistry: typeof pluginRuntime.registry,
  ): GatewayMethodRegistry => {
    const coreDescriptorHandlers: GatewayRequestHandlers = { ...coreGatewayHandlers };
    const auxHandlers: GatewayRequestHandlers = {};
    for (const [method, handler] of Object.entries(extraHandlers)) {
      if (isCoreGatewayMethodClassified(method)) {
        coreDescriptorHandlers[method] = handler;
      } else {
        auxHandlers[method] = handler;
      }
    }
    const coreDescriptors = createCoreGatewayMethodDescriptors(coreDescriptorHandlers).filter(
      (descriptor) =>
        (workerEnvironmentService ||
          (descriptor.name !== "environments.create" &&
            descriptor.name !== "environments.destroy")) &&
        (workerPlacementDispatchAvailable || descriptor.name !== "sessions.dispatch") &&
        (workerPlacementControlAvailable || descriptor.name !== "sessions.reclaim") &&
        (desktopObserveAvailable || descriptor.name !== "desktop.observe") &&
        (workerDesktopObserveAvailable ||
          (descriptor.name !== "desktop.launch" &&
            descriptor.name !== "worker.desktop.observe" &&
            descriptor.name !== "worker.desktop.launch")),
    );
    return createGatewayMethodRegistry(
      [
        ...coreDescriptors,
        ...createPluginGatewayMethodDescriptors(nextPluginRegistry),
        ...createGatewayMethodDescriptorsFromHandlers({
          handlers: auxHandlers,
          owner: { kind: "aux", area: "gateway-extra" },
          defaultScope: ADMIN_SCOPE,
        }),
      ],
      nextPluginRegistry,
    );
  };
  let attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRuntime.registry);
  const listAttachedGatewayMethods = () => {
    const methods = attachedGatewayMethodRegistry.listAdvertisedMethods();
    methods.push(...listStartupChannelGatewayMethods());
    return uniqueStrings(methods);
  };
  kernel.publishMethodSurface(listAttachedGatewayMethods());
  const replaceAttachedPluginRuntime = (loaded: {
    pluginRegistry: typeof pluginRuntime.registry;
    gatewayMethods: string[];
  }) => {
    pluginRuntime.registry = loaded.pluginRegistry;
    pluginRuntime.baseGatewayMethods = loaded.gatewayMethods;
    for (const key of attachedPluginGatewayHandlerKeys) {
      delete attachedGatewayExtraHandlers[key];
    }
    Object.assign(attachedGatewayExtraHandlers, pluginRuntime.registry.gatewayHandlers);
    attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRuntime.registry.gatewayHandlers));
    attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRuntime.registry);
    kernel.publishMethodSurface(listAttachedGatewayMethods());
    nodeRegistry.refreshNodePluginTools();
  };
  const refreshAttachedGatewayDiscovery = async (
    nextPluginRegistry: typeof pluginRuntime.registry,
  ) => {
    if (minimalTestGateway) {
      return;
    }
    try {
      const stopPreviousDiscovery = kernel.swapBonjourStop(null);
      if (stopPreviousDiscovery) {
        try {
          await stopPreviousDiscovery();
        } catch (err) {
          logDiscovery.warn(`gateway discovery stop failed before plugin refresh: ${String(err)}`);
        }
      }
      const { startGatewayPluginDiscovery } = await loadGatewayStartupEarlyModule();
      kernel.swapBonjourStop(
        await startGatewayPluginDiscovery({
          minimalTestGateway,
          cfgAtStart,
          port,
          gatewayTls,
          gatewayDirectReachable: !isLoopbackHost(bindHost),
          tailscaleMode,
          logDiscovery,
          pluginRegistry: nextPluginRegistry,
        }),
      );
    } catch (err) {
      logDiscovery.warn(`gateway discovery refresh failed after plugin load: ${String(err)}`);
    }
  };
  const reloadAttachedGatewayPlugins = async (params: {
    nextConfig: OpenClawConfig;
    changedPaths: readonly string[];
    beforeReplace: (
      channels: ReadonlySet<ChannelId>,
      accounts?: ReadonlyMap<ChannelId, ReadonlySet<string>>,
    ) => Promise<void>;
    commitRuntime: () => Promise<void>;
    env: NodeJS.ProcessEnv;
    isAborted?: () => boolean;
  }): Promise<GatewayPluginReloadResult> => {
    const [
      { loadPluginLookUpTable },
      { listAmbientOnlyConfiguredChannelIds },
      { prepareGatewayPluginLoad },
      { startPluginServices },
      { listChannelPluginConfigTargetIds, pluginConfigTargetsChanged },
    ] = await Promise.all([
      import("../plugins/plugin-lookup-table.js"),
      import("../plugins/channel-presence-policy.js"),
      loadGatewayPluginBootstrapModule(),
      import("../plugins/services.js"),
      import("./plugin-channel-reload-targets.js"),
    ]);
    const listAttachedChannelConfigTargets = () =>
      new Map(
        listGatewayStartupChannelPlugins().map((plugin) => [
          plugin.id,
          listChannelPluginConfigTargetIds({
            channelId: plugin.id,
            pluginId: getLoadedChannelPluginEntryById(plugin.id)?.pluginId,
            aliases: plugin.meta.aliases,
          }),
        ]),
      );
    const beforeChannelTargets = listAttachedChannelConfigTargets();
    const beforeChannelIds = new Set(beforeChannelTargets.keys());
    const nextPluginActivationConfig = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: params.nextConfig,
      activationSourceConfig: params.nextConfig,
      env: params.env,
      ambientEnvTriggers,
    });
    const nextPluginLookUpTable = loadPluginLookUpTable({
      config: nextPluginActivationConfig,
      workspaceDir: pluginWorkspaceDir,
      env: params.env,
      activationSourceConfig: params.nextConfig,
      // Workers can be created after startup; reload planning needs the live durable set.
      workerProviderIds: workerEnvironmentStartup?.listDurableProviderIds() ?? [],
      ambientEnvTriggers,
    });
    const nextAmbientAutostartSuppressedChannelIds =
      ambientEnvTriggers === "suppress"
        ? new Set(
            listAmbientOnlyConfiguredChannelIds({
              config: params.nextConfig,
              activationSourceConfig: params.nextConfig,
              env: params.env,
              includePersistedAuthState: false,
              manifestRecords: nextPluginLookUpTable.manifestRegistry.plugins,
            }),
          )
        : new Set<string>();
    const nextStartupPluginIds = new Set(nextPluginLookUpTable.startup.pluginIds);
    const nextStartupChannelIds = new Set<ChannelId>();
    for (const plugin of nextPluginLookUpTable.manifestRegistry.plugins) {
      if (!nextStartupPluginIds.has(plugin.id)) {
        continue;
      }
      if (plugin.channels.length === 0) {
        nextStartupChannelIds.add(plugin.id);
        continue;
      }
      for (const channelId of plugin.channels) {
        nextStartupChannelIds.add(channelId);
      }
    }
    const channelsToStopBeforeReplace = new Set<ChannelId>();
    for (const channelId of beforeChannelIds) {
      const targetIds = beforeChannelTargets.get(channelId) ?? new Set([channelId]);
      if (
        !nextStartupChannelIds.has(channelId) ||
        pluginConfigTargetsChanged(targetIds, params.changedPaths)
      ) {
        channelsToStopBeforeReplace.add(channelId);
      }
    }
    await params.beforeReplace(
      channelsToStopBeforeReplace,
      channelManager.getPluginCommandCatalogAccounts(),
    );
    // If an in-process restart signalled abort during beforeReplace,
    // stop before any plugin metadata/runtime side effects continue.
    if (params.isAborted?.()) {
      return {
        restartChannels: new Set(),
        activeChannels: new Set(beforeChannelIds),
        cancelled: true,
      };
    }
    const previousPluginServices = runtimeState.pluginServices;
    await params.commitRuntime();
    channelManager.setAmbientAutostartSuppressedChannelIds(
      nextAmbientAutostartSuppressedChannelIds,
    );
    const loaded = prepareGatewayPluginLoad({
      cfg: params.nextConfig,
      workspaceDir: pluginWorkspaceDir,
      log,
      coreGatewayMethodNames,
      hostServices: pluginHostServices,
      baseMethods,
      pluginLookUpTable: nextPluginLookUpTable,
      ambientEnvTriggers,
    });
    const nextPluginMetadataSnapshot = completePluginMetadataSnapshot({
      snapshot: nextPluginLookUpTable,
      config: params.nextConfig,
      env: params.env,
      workspaceDir: pluginWorkspaceDir,
    });
    setCurrentPluginMetadataSnapshot(nextPluginMetadataSnapshot, {
      config: params.nextConfig,
      env: params.env,
      workspaceDir: pluginWorkspaceDir,
    });
    replaceAttachedPluginRuntime(loaded);
    kernel.setPluginServices(null);
    if (previousPluginServices) {
      await previousPluginServices.stop();
    }
    await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
    kernel.setPluginServices(
      await startPluginServices({
        registry: loaded.pluginRegistry,
        config: params.nextConfig,
        workspaceDir: pluginWorkspaceDir,
        broadcastPluginEvent,
      }),
    );
    const afterChannelTargets = listAttachedChannelConfigTargets();
    const afterChannelIds = new Set(afterChannelTargets.keys());
    const restartChannels = new Set<ChannelId>();
    for (const channelId of new Set([...beforeChannelIds, ...afterChannelIds])) {
      const targetIds =
        afterChannelTargets.get(channelId) ??
        beforeChannelTargets.get(channelId) ??
        new Set([channelId]);
      if (
        afterChannelIds.has(channelId) &&
        (beforeChannelIds.has(channelId) !== afterChannelIds.has(channelId) ||
          pluginConfigTargetsChanged(targetIds, params.changedPaths))
      ) {
        restartChannels.add(channelId);
      }
    }
    return {
      restartChannels,
      activeChannels: afterChannelIds,
    };
  };

  return {
    ...runtime,
    kernel: {
      ...kernel,
      reloadPlugins: reloadAttachedGatewayPlugins,
    },
    earlyRuntime,
    sessionCompanion,
    sessionObserver,
    approvalSessionEvents,
    execApprovalManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    validateAgentRuntimeApprovalAuthority,
    attachedGatewayExtraHandlers,
    getAttachedGatewayMethodRegistry: () => attachedGatewayMethodRegistry,
    replaceAttachedPluginRuntime,
    refreshAttachedGatewayDiscovery,
    loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalog,
  };
}
