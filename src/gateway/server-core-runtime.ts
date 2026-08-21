import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
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
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import type {
  GatewayPluginReloadResult,
  GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
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

const listGatewayStartupChannelPlugins = (): GatewayStartupChannelPlugin[] =>
  listLoadedChannelPlugins() as GatewayStartupChannelPlugin[];

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
    resolvePluginGatewayContext,
    workerEnvironmentStartup,
    broadcastPluginEvent,
    activateRuntimeSecrets,
    residentRegistry,
    shutdownRuntime,
  } = runtime;
  let currentPluginMetadataSnapshot = runtime.pluginMetadataSnapshot;
  if (desktopSessionRegistry) {
    kernel.addGatewayLifetimeSidecar({ stop: () => desktopSessionRegistry.stopAll() });
  }
  const secretEgressProxy =
    cfgAtStart.secrets?.egressProxy?.enabled === true
      ? await import("../secrets/egress-proxy/runtime.js").then((egressRuntime) =>
          egressRuntime.startGatewaySecretEgressProxy(
            cfgAtStart.secrets?.egressProxy?.bypassHosts
              ? { bypassHosts: cfgAtStart.secrets.egressProxy.bypassHosts }
              : {},
          ),
        )
      : undefined;
  if (secretEgressProxy) {
    kernel.addGatewayLifetimeSidecar(secretEgressProxy);
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
        swapBonjourStop: kernel.swapBonjourStop,
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
    stop: async () => await kernel.swapBonjourStop(null)?.(),
  });
  const taskAndSkillsResident = residentRegistry.register({
    name: "task-and-skills-runtime",
    start: async () => await discoveryResident.start(),
    stop: async () => {
      const earlyRuntime = await startEarlyRuntime();
      await earlyRuntime.skillsChangeUnsub();
      shutdownRuntime.stopTaskRegistryMaintenance();
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
        channelManager,
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
        onAgentRunAuthorityClosed: (authority) => {
          secretEgressProxy?.revokeRun(authority.operationalRunInstance);
        },
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
    // Dispatch fencing closes approval authority deliberately: record it as a
    // run-aborted cancellation, not a timeout, so ask-fallback replay cannot
    // re-admit through the fenced record (consumeAskFallback admits only
    // expired/no-route terminals).
    const fenceResolver = { kind: "system", id: "worker-dispatch" } as const;
    for (const manager of [execApprovalManager, pluginApprovalManager]) {
      for (const record of manager.listPendingRecords()) {
        if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
          manager.forceDenyDetailed(record.id, "run-aborted", fenceResolver, "cancelled");
        }
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
        (workerPlacementControlAvailable ||
          (descriptor.name !== "sessions.reclaim" && descriptor.name !== "sessions.move")) &&
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
  let retireAttachedPluginRuntimeBindings = () => {};
  kernel.addGatewayLifetimeSidecar({
    stop: async () => retireAttachedPluginRuntimeBindings(),
  });
  const listAttachedGatewayMethods = () => {
    const methods = attachedGatewayMethodRegistry.listAdvertisedMethods();
    methods.push(...listStartupChannelGatewayMethods());
    return uniqueStrings(methods);
  };
  kernel.publishMethodSurface(listAttachedGatewayMethods());
  const replaceAttachedPluginRuntime = (loaded: {
    pluginRegistry: typeof pluginRuntime.registry;
    gatewayMethods: string[];
    retireGatewayRuntimeBindings?: () => void;
  }) => {
    const retirePreviousBindings = retireAttachedPluginRuntimeBindings;
    retireAttachedPluginRuntimeBindings = loaded.retireGatewayRuntimeBindings ?? (() => {});
    retirePreviousBindings();
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
    claim: GatewayPluginRuntimeClaim,
  ) => {
    if (minimalTestGateway) {
      return;
    }
    try {
      if (!(await claim.waitForUnblocked())) {
        return;
      }
      const stopPreviousDiscovery = kernel.swapBonjourStop(null);
      await stopPreviousDiscovery?.().catch((err: unknown) => {
        logDiscovery.warn(`gateway discovery stop failed before plugin refresh: ${String(err)}`);
      });
      const { startGatewayPluginDiscovery } = await loadGatewayStartupEarlyModule();
      if (!(await claim.waitForUnblocked())) {
        return;
      }
      const stopNextDiscovery = await startGatewayPluginDiscovery({
        minimalTestGateway,
        cfgAtStart,
        port,
        gatewayTls,
        gatewayDirectReachable: !isLoopbackHost(bindHost),
        tailscaleMode,
        logDiscovery,
        pluginRegistry: nextPluginRegistry,
      });
      if (
        !(await claim.waitForUnblocked()) ||
        !claim.publish(() => kernel.swapBonjourStop(stopNextDiscovery))
      ) {
        await stopNextDiscovery?.();
      }
    } catch (err) {
      logDiscovery.warn(`gateway discovery refresh failed after plugin load: ${String(err)}`);
    }
  };
  const reloadAttachedGatewayPlugins: GatewayReloadHandlerParams["reloadPlugins"] = async (
    params,
  ) => {
    const [
      { loadPluginLookUpTable },
      { listAmbientOnlyConfiguredChannelIds },
      { prepareGatewayPluginLoad },
      { startPluginServices, PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS },
      { listChannelPluginConfigTargetIds, pluginConfigTargetsChanged },
    ] = await Promise.all([
      import("../plugins/plugin-lookup-table.js"),
      import("../plugins/channel-presence-policy.js"),
      loadGatewayPluginBootstrapModule(),
      import("../plugins/services.js"),
      import("./plugin-channel-reload-targets.js"),
    ]);
    const cancelledReload = (activeChannels: Iterable<ChannelId>): GatewayPluginReloadResult => ({
      restartChannels: new Set(),
      activeChannels: new Set(activeChannels),
      cancelled: true,
    });
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
      activationSourceConfig: params.sourceConfig,
      env: params.env,
      ambientEnvTriggers,
    });
    const nextPluginLookUpTable = loadPluginLookUpTable({
      config: nextPluginActivationConfig,
      workspaceDir: pluginWorkspaceDir,
      env: params.env,
      activationSourceConfig: params.sourceConfig,
      // Workers can be created after startup; reload planning needs the live durable set.
      workerProviderIds: workerEnvironmentStartup?.listDurableProviderIds() ?? [],
      ambientEnvTriggers,
    });
    const nextAmbientAutostartSuppressedChannelIds =
      ambientEnvTriggers === "suppress"
        ? new Set(
            listAmbientOnlyConfiguredChannelIds({
              config: params.nextConfig,
              activationSourceConfig: params.sourceConfig,
              env: params.env,
              includePersistedAuthState: false,
              manifestRecords: nextPluginLookUpTable.manifestRegistry.plugins,
            }),
          )
        : new Set<string>();
    const nextStartupPluginIds = new Set(nextPluginLookUpTable.startup.pluginIds);
    const nextStartupChannelIds = new Set<ChannelId>(
      nextPluginLookUpTable.manifestRegistry.plugins.flatMap(({ id, channels }) =>
        nextStartupPluginIds.has(id) ? (channels.length > 0 ? channels : [id]) : [],
      ),
    );
    const channelsToStopBeforeReplace = new Set<ChannelId>();
    for (const [channelId, targetIds] of beforeChannelTargets) {
      if (
        !nextStartupChannelIds.has(channelId) ||
        pluginConfigTargetsChanged(targetIds, params.changedPaths)
      ) {
        channelsToStopBeforeReplace.add(channelId);
      }
    }
    const pluginRuntimeGeneration = kernel.pluginRuntimeGeneration;
    const replacement = pluginRuntimeGeneration.reserve();
    let recoverFromReplacementTeardown: ((error: unknown) => void) | undefined;
    try {
      await params.beforeReplace(
        channelsToStopBeforeReplace,
        channelManager.getPluginCommandCatalogAccounts(),
      );
      // A rejected reservation restores startup authority; a committed replacement never does.
      if (params.isAborted?.()) {
        replacement.reject();
        return cancelledReload(beforeChannelIds);
      }
      const previousServices = pluginRuntimeGeneration.currentServices();
      if (previousServices) {
        // Service shutdown is irreversible; only the synchronous runtime commit releases recovery.
        recoverFromReplacementTeardown = params.onReplacementTeardownFailure;
        await previousServices.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        });
        if (params.isAborted?.()) {
          throw new Error(
            "Gateway plugin runtime replacement was superseded after service teardown",
          );
        }
      }
      await params.commitRuntime(() => {
        replacement.commit();
        pluginRuntimeGeneration.publishServices(replacement.claim, null);
        recoverFromReplacementTeardown = undefined;
      });
      if (!(await replacement.claim.waitForUnblocked())) {
        return cancelledReload(beforeChannelIds);
      }

      let loaded: ReturnType<typeof prepareGatewayPluginLoad> | undefined;
      if (
        !replacement.claim.publish(() => {
          channelManager.setAmbientAutostartSuppressedChannelIds(
            nextAmbientAutostartSuppressedChannelIds,
          );
          loaded = prepareGatewayPluginLoad({
            cfg: params.nextConfig,
            activationSourceConfig: params.sourceConfig,
            workspaceDir: pluginWorkspaceDir,
            log,
            coreGatewayMethodNames,
            hostServices: pluginHostServices,
            baseMethods,
            pluginLookUpTable: nextPluginLookUpTable,
            ambientEnvTriggers,
            resolveGatewayContext: resolvePluginGatewayContext,
          });
          const nextPluginMetadataSnapshot = completePluginMetadataSnapshot({
            snapshot: nextPluginLookUpTable,
            config: params.sourceConfig,
            env: params.env,
            workspaceDir: pluginWorkspaceDir,
          });
          setCurrentPluginMetadataSnapshot(nextPluginMetadataSnapshot, {
            config: params.sourceConfig,
            compatibleConfigs: [params.nextConfig],
            env: params.env,
            workspaceDir: pluginWorkspaceDir,
          });
          currentPluginMetadataSnapshot = nextPluginMetadataSnapshot;
          replaceAttachedPluginRuntime(loaded);
        }) ||
        !loaded
      ) {
        return cancelledReload(listAttachedChannelConfigTargets().keys());
      }
      await refreshAttachedGatewayDiscovery(loaded.pluginRegistry, replacement.claim);
      if (!(await replacement.claim.waitForUnblocked())) {
        return cancelledReload(listAttachedChannelConfigTargets().keys());
      }
      const nextServices = await startPluginServices({
        registry: loaded.pluginRegistry,
        config: params.nextConfig,
        workspaceDir: pluginWorkspaceDir,
        broadcastPluginEvent,
        onHandle: (handle) => pluginRuntimeGeneration.publishServices(replacement.claim, handle),
      });
      if (
        !(await replacement.claim.waitForUnblocked()) ||
        !pluginRuntimeGeneration.publishServices(replacement.claim, nextServices)
      ) {
        await nextServices.stop({
          strict: true,
          deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        });
      }
    } catch (error) {
      replacement.reject();
      recoverFromReplacementTeardown?.(error);
      throw error;
    }
    const afterChannelTargets = listAttachedChannelConfigTargets();
    const restartChannels = new Set<ChannelId>();
    for (const [channelId, targetIds] of afterChannelTargets) {
      if (
        !beforeChannelIds.has(channelId) ||
        pluginConfigTargetsChanged(targetIds, params.changedPaths)
      ) {
        restartChannels.add(channelId);
      }
    }
    return {
      restartChannels,
      activeChannels: new Set(afterChannelTargets.keys()),
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
    readPreparedGatewayModelCatalog,
    getPluginMetadataSnapshot: () => currentPluginMetadataSnapshot,
  };
}
