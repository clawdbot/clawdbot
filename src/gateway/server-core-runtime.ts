import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import { getRuntimeConfig } from "../config/io.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { adoptPluginHttpRouteHandoffs } from "../plugins/http-registry.js";
import { isGatewayWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import { restartRunningChannelAccounts, type ThawRestartTarget } from "./channel-thaw-restart.js";
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
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import {
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";
import { listPluginNodeCapabilities } from "./server/plugins-http/route-capability.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import { resolveGrantExpiryDaysConfig } from "./standing-grant-expiry-config.js";

type GatewayLifecycle = Awaited<ReturnType<typeof prepareGatewayLifecycle>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
type GatewayEarlyRuntime = Awaited<
  ReturnType<typeof import("./server-startup-early.js").startGatewayEarlyRuntime>
>;

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
    desktopSessionRegistry,
    listStartupChannelGatewayMethods,
    workerEnvironmentStartup,
    activateRuntimeSecrets,
  } = runtime;
  kernel.addGatewayLifetimeSidecar({ stop: () => desktopSessionRegistry.stopAll() });
  const secretEgressProxy =
    cfgAtStart.secrets?.egressProxy?.enabled === true
      ? await import("../secrets/egress-proxy/runtime.js").then((egressRuntime) =>
          egressRuntime.startGatewaySecretEgressProxy({
            ...(cfgAtStart.secrets?.egressProxy?.allowedHosts !== undefined
              ? { allowedHosts: cfgAtStart.secrets.egressProxy.allowedHosts }
              : {}),
            ...(cfgAtStart.secrets?.egressProxy?.bypassHosts
              ? { bypassHosts: cfgAtStart.secrets.egressProxy.bypassHosts }
              : {}),
          }),
        )
      : undefined;
  if (secretEgressProxy) {
    kernel.addGatewayLifetimeSidecar(secretEgressProxy);
  }
  let pendingThawRestartTargets: readonly ThawRestartTarget[] | undefined;
  let earlyRuntimePromise: Promise<GatewayEarlyRuntime> | undefined;
  const startEarlyRuntime = (): Promise<GatewayEarlyRuntime> =>
    (earlyRuntimePromise ??= startupTrace
      .measure("runtime.early", () =>
        loadGatewayStartupEarlyModule().then(({ startGatewayEarlyRuntime }) =>
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
            swapDiscovery: kernel.swapDiscovery,
            pluginRegistry: pluginRuntime.registry,
            pluginRuntimeClaim: kernel.pluginRuntimeGeneration.currentClaim(),
            broadcast,
            nodeSendToAllSubscribed,
            getPresenceVersion,
            getHealthVersion,
            refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
            restartRunningChannels: async (
              mode,
              shouldContinue = () => !isGatewayWorkAdmissionClosed(),
            ) => {
              // A new timing gap must resnapshot every running account even while
              // older failures remain pending. A retry before the first attempted
              // pass has no target list yet, so it also needs that fresh snapshot.
              const selection =
                mode === "new-thaw" || pendingThawRestartTargets === undefined
                  ? { kind: "new-thaw" as const, pendingTargets: pendingThawRestartTargets }
                  : { kind: "deferred-retry" as const, targets: pendingThawRestartTargets };
              const failedTargets = await restartRunningChannelAccounts(
                channelManager,
                {
                  shouldContinue,
                  onError: (message) => logHealth.error(message),
                },
                selection,
              );
              pendingThawRestartTargets = failedTargets.length > 0 ? failedTargets : undefined;
              return failedTargets.length === 0;
            },
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
            skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
            getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
            setSkillsRefreshTimer: (timer) => {
              runtimeState.skillsRefreshTimer = timer;
            },
            getRuntimeConfig,
            startupTrace,
          }),
        ),
      )
      .then((earlyRuntime) => {
        kernel.setEarlyRuntimeHandles(earlyRuntime);
        return earlyRuntime;
      }));

  const [{ startGatewayEventSubscriptions }, { startGatewayChannelHealthMonitor }] =
    await startupTrace.measure("runtime.post-early-imports", () =>
      Promise.all([
        import("./server-runtime-subscriptions.js"),
        import("./server-runtime-startup-services.js"),
      ]),
    );
  const { sessionCompanion, sessionObserver, ...runtimeSubscriptionUnsubs } =
    await startupTrace.measure("runtime.subscriptions", () =>
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
    );
  Object.assign(runtimeState, runtimeSubscriptionUnsubs);

  await startupTrace.measure("runtime.services", () =>
    kernel.setChannelHealthMonitor(startGatewayChannelHealthMonitor({ channelManager })),
  );

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
    questionManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    placementStandingGrants,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    beginCloseApprovalObservers,
    stopOperatorInteractions,
    extraHandlers,
    coreGatewayHandlers,
  } = await startupTrace.measure("gateway.handlers", async () => {
    const [{ createGatewayAuxHandlers }, { coreGatewayHandlers: coreGatewayHandlersLocal }] =
      await Promise.all([import("./server-aux-handlers.js"), import("./server-methods.js")]);
    return {
      ...createGatewayAuxHandlers({
        log,
        chatAbortControllers,
        hasRunAbortMarker: (runId) => chatRunState.hasAbortMarker(runId),
        // Grant terms freeze at mint. This reads the live config so a policy
        // change applies to grants minted after it, never retroactively.
        resolveGrantDefaultExpiresAtMs: (nowMs) => {
          const days = resolveGrantExpiryDaysConfig(getRuntimeConfig());
          return days !== null ? nowMs + days * 86_400_000 : null;
        },
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
  const requestLifetime = runtime.connectionWork.signal;
  requestLifetime.addEventListener("abort", beginCloseApprovalObservers, { once: true });
  if (requestLifetime.aborted) {
    beginCloseApprovalObservers();
  }
  kernel.addGatewayLifetimeSidecar({
    stop: async () => {
      requestLifetime.removeEventListener("abort", beginCloseApprovalObservers);
      await stopOperatorInteractions();
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
  const getPluginNodeCapabilities = () =>
    withCoreCanvasNodeCapability(
      listPluginNodeCapabilities(pluginRuntime.registry),
      isCoreCanvasHostEnabled(getRuntimeConfig()),
    );
  const prepareAttachedPluginRuntime = async (loaded: {
    pluginRegistry: typeof pluginRuntime.registry;
    gatewayMethods: string[];
  }) => {
    const { activatePluginRegistry } = await import("../plugins/loader-shared.js");
    const nextMethodRegistry = buildAttachedGatewayMethodRegistry(loaded.pluginRegistry);
    const nextMethods = uniqueStrings([
      ...nextMethodRegistry.listAdvertisedMethods(),
      ...listStartupChannelGatewayMethods(loaded.pluginRegistry),
    ]);
    const nextHandlerKeys = new Set(Object.keys(loaded.pluginRegistry.gatewayHandlers));
    return {
      publish: () => {
        adoptPluginHttpRouteHandoffs(pluginRuntime.registry, loaded.pluginRegistry);
        // Startup and reload share one synchronous handoff, so another Gateway cannot
        // select and retire this candidate between activation and owner publication.
        activatePluginRegistry(
          loaded.pluginRegistry,
          null,
          "gateway-bindable",
          runtime.pluginWorkspaceDir,
          pluginRuntime.registry,
        );
        pluginRuntime.publish(loaded.pluginRegistry);
        pluginRuntime.baseGatewayMethods = loaded.gatewayMethods;
        for (const key of attachedPluginGatewayHandlerKeys) {
          delete attachedGatewayExtraHandlers[key];
        }
        Object.assign(attachedGatewayExtraHandlers, loaded.pluginRegistry.gatewayHandlers);
        attachedPluginGatewayHandlerKeys = nextHandlerKeys;
        attachedGatewayMethodRegistry = nextMethodRegistry;
        kernel.publishMethodSurface(nextMethods);
      },
      afterCommit: () => {
        nodeRegistry.refreshRuntimePolicy();
      },
    };
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
      await runtimeState.discovery?.update(
        { gatewayDiscoveryServices: nextPluginRegistry.gatewayDiscoveryServices },
        claim,
      );
    } catch (err) {
      logDiscovery.warn(`gateway discovery refresh failed after plugin load: ${String(err)}`);
    }
  };
  const reloadAttachedGatewayPlugins: GatewayReloadHandlerParams["reloadPlugins"] = async (
    params,
  ) => {
    const { reloadGatewayPlugins } = await import("./server-plugin-reload.js");
    return reloadGatewayPlugins(
      {
        runtime,
        port,
        log,
        loadGatewayPluginBootstrapModule,
        prepareAttachedPluginRuntime,
      },
      params,
    );
  };

  return {
    ...runtime,
    kernel: {
      ...kernel,
      reloadPlugins: reloadAttachedGatewayPlugins,
    },
    startEarlyRuntime,
    sessionCompanion,
    sessionObserver,
    approvalSessionEvents,
    execApprovalManager,
    questionManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    placementStandingGrants,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    validateAgentRuntimeApprovalAuthority,
    attachedGatewayExtraHandlers,
    getAttachedGatewayMethodRegistry: () => attachedGatewayMethodRegistry,
    getPluginNodeCapabilities,
    prepareAttachedPluginRuntime,
    refreshAttachedGatewayDiscovery,
    loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot,
    readPreparedGatewayModelCatalog,
    getPluginMetadataSnapshot: () => runtime.pluginMetadataSnapshot,
  };
}
