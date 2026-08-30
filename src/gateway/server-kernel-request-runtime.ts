import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { enforceSharedGatewaySessionGenerationForConfigWrite } from "./server-shared-auth-generation.js";
import {
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

/** Completes the socket-free request and internal-dispatch half of Gateway startup. */
export async function prepareGatewayKernelRequestRuntime(params: {
  coreRuntime: GatewayCoreRuntime;
  log: GatewayLogger;
  logHealth: GatewayLogger;
}) {
  const { coreRuntime: runtime, log, logHealth } = params;
  const {
    minimalTestGateway,
    deps,
    runtimeState,
    unavailableGatewayMethods,
    sessionCompanion,
    sessionObserver,
    getMcpAppSandboxPort,
    ensureSandboxHostPort,
    getPortalService,
    terminalLaunchPolicy,
    execApprovalManager,
    questionManager,
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
    approvalWebPushDelivery,
    pluginApprovalIosPushDelivery,
    pluginApprovalManager,
    systemAgentApprovalManager,
    bindApprovalPublicationContext,
    validateAgentRuntimeApprovalAuthority,
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
    isConnectionActive,
    watchNodeHttpRuntime,
    sharedGatewaySessionGenerationState,
    resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
    nodeRegistry,
    nodeDesktopService,
    workerEnvironmentService,
    hostDesktopService,
    workerEnvironmentStartup,
    workerPlacementRuntime,
    workerPlacementControlAvailable,
    githubPublicationRuntime,
    githubPublicationService,
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
    readinessEventLoopHealth,
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
    gatewayTls,
    lifecycle,
    startupState,
    kernel,
    shutdownRuntime,
  } = runtime;
  const chatMetadataLifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: getRuntimeConfig,
    minimalTestGateway,
    log,
  });
  const configRevisionProjector = await startupTrace.measure(
    "gateway.config-revision-key",
    async () => {
      const { loadGatewayConfigRevisionProjector } = await import("./config-revision-token.js");
      return loadGatewayConfigRevisionProjector({ env: process.env });
    },
  );
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      deps,
      configRevisionProjector,
      runtimeState,
      sessionCompanion,
      getRuntimeConfig,
      getGatewayMethodRegistry: getAttachedGatewayMethodRegistry,
      gatewayTlsFingerprint: gatewayTls.enabled ? gatewayTls.fingerprintSha256 : undefined,
      sessionObserver,
      getMcpAppSandboxPort,
      ensureSandboxHostPort,
      getPortalService,
      resolveTerminalLaunchPolicy: terminalLaunchPolicy.resolve,
      isTerminalEnabled: terminalLaunchPolicy.isEnabled,
      execApprovalManager,
      questionManager,
      cancelRunBoundApprovals,
      forwardPluginApprovalRequest,
      approvalWebPushDelivery,
      pluginApprovalIosPushDelivery,
      pluginApprovalManager,
      systemAgentApprovalManager,
      listSessionPendingApprovals: approvalSessionEvents.replay,
      loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalog,
      readChatMetadata: chatMetadataLifecycle.read,
      readChatStartupProjection: chatMetadataLifecycle.readStartup,
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
      isConnectionActive,
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
      nodeRegistry,
      ...(nodeDesktopService ? { nodeDesktopService } : {}),
      ...(workerEnvironmentService ? { workerEnvironmentService } : {}),
      ...(hostDesktopService ? { hostDesktopService } : {}),
      ...(workerEnvironmentStartup
        ? { workerSessionPlacementService: workerEnvironmentStartup.placementStore }
        : {}),
      ...(workerPlacementRuntime
        ? {
            workerPlacementDiskSpaceReader: workerPlacementRuntime.diskSpace,
            workerPlacementRunnerAvailabilityReader: workerPlacementRuntime.runnerAvailability,
          }
        : {}),
      ...(workerPlacementControlAvailable
        ? { workerPlacementDispatchService: workerPlacementControlAvailable }
        : {}),
      ...(githubPublicationService ? { githubPublicationService } : {}),
      validateAgentRuntimeApprovalAuthority,
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
      notifyPluginMetadataChanged: kernel.notifyPluginMetadataChanged,
      getConfigReloaderHotReloadStatus: kernel.getConfigReloaderHotReloadStatus,
    });
  });
  bindApprovalPublicationContext(gatewayRequestContext);
  await attachInitialGatewayLifetimeSidecars({
    chatMetadataLifecycle,
    gatewayRequestContext,
    flushPendingSessionsChangedEvents: shutdownRuntime.flushPendingSessionsChangedEvents,
    minimalTestGateway,
    logWarning: (message) => log.warn(message),
    ...(!workerPlacementRuntime && githubPublicationRuntime
      ? { reconcileGitHubPublications: githubPublicationRuntime.reconcilePublications }
      : {}),
    sidecars: runtimeState.gatewayLifetimeSidecars,
  });
  pluginGatewayContext.current = gatewayRequestContext;
  gatewayRequestContext.dispatchHookAgentTurn = async (pluginId, hookParams) => {
    const transport = runtime.transportBridge.current();
    if (!transport) {
      throw new Error("Gateway listener must start before plugin hook dispatch");
    }
    return await transport.dispatchHookAgentTurn(pluginId, hookParams);
  };
  const { createGatewayInstanceRuntime } = await import("./server-instance-runtime.js");
  const gatewayInstanceRuntime = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    isDispatchAvailable: () => startupState.dispatchReady && !lifecycle.closePreludeStarted,
    logError: (message) => log.error(message),
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntime;
  gatewayRequestContext.resolveGatewayContext = () =>
    gatewayInstanceRuntime.isAvailable() ? gatewayRequestContext : undefined;
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntime.approvalEvents;
  gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntime.recovery;
  gatewayRequestContext.createAgentTurnFacade = gatewayInstanceRuntime.createAgentTurnFacade;
  return { ...runtime, chatMetadataLifecycle, gatewayRequestContext, gatewayInstanceRuntime };
}

export type GatewayKernelRuntime = Awaited<ReturnType<typeof prepareGatewayKernelRequestRuntime>>;
