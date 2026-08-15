import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { attachInitialGatewayLifetimeSidecars } from "./server-lifetime-sidecars.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
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
    cancelRunBoundApprovals,
    forwardPluginApprovalRequest,
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
    watchNodeHttpRuntime,
    sharedGatewaySessionGenerationState,
    resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
    completeControlUiDeviceAuthMigrationForEffectiveOperator,
    claimControlUiDeviceAuthMigration,
    releaseControlUiDeviceAuthMigrationClaim,
    nodeRegistry,
    nodeDesktopService,
    workerEnvironmentService,
    hostDesktopService,
    workerEnvironmentStartup,
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
    clearFallbackGatewayContextForServer,
    kernel,
  } = runtime;
  const chatMetadataLifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: getRuntimeConfig,
    minimalTestGateway,
    log,
  });
  const gatewayRequestContext = await startupTrace.measure("gateway.request-context", async () => {
    const { createGatewayRequestContext } = await import("./server-request-context.js");
    return createGatewayRequestContext({
      deps,
      runtimeState,
      sessionCompanion,
      getRuntimeConfig,
      gatewayTlsFingerprint: gatewayTls.enabled ? gatewayTls.fingerprintSha256 : undefined,
      sessionObserver,
      getMcpAppSandboxPort,
      ensureSandboxHostPort,
      getPortalService,
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
      ...(nodeDesktopService ? { nodeDesktopService } : {}),
      ...(workerEnvironmentService ? { workerEnvironmentService } : {}),
      ...(hostDesktopService ? { hostDesktopService } : {}),
      ...(workerEnvironmentStartup
        ? { workerSessionPlacementService: workerEnvironmentStartup.placementStore }
        : {}),
      ...(workerPlacementRuntime
        ? { workerPlacementDiskSpaceReader: workerPlacementRuntime.diskSpace }
        : {}),
      ...(workerPlacementControlAvailable
        ? { workerPlacementDispatchService: workerPlacementControlAvailable }
        : {}),
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
    sidecars: runtimeState.gatewayLifetimeSidecars,
  });
  pluginGatewayContext.current = gatewayRequestContext;
  const { createGatewayInstanceRuntime } = await import("./server-instance-runtime.js");
  const gatewayInstanceRuntime = createGatewayInstanceRuntime({
    getContext: () => gatewayRequestContext,
    getMethodRegistry: () => getAttachedGatewayMethodRegistry(),
    isDispatchAvailable: () => startupState.dispatchReady && !lifecycle.closePreludeStarted,
    logError: (message) => log.error(message),
  });
  gatewayInstanceRuntimeRef.current = gatewayInstanceRuntime;
  gatewayRequestContext.approvalEvents = gatewayInstanceRuntime.approvalEvents;
  gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntime.recovery;
  const clearFallbackContext: unknown = setFallbackGatewayContextResolver(
    () => gatewayRequestContext,
  );
  clearFallbackGatewayContextForServer.set(
    typeof clearFallbackContext === "function" ? () => clearFallbackContext() : () => {},
  );
  return { ...runtime, chatMetadataLifecycle, gatewayRequestContext, gatewayInstanceRuntime };
}

export type GatewayKernelRuntime = Awaited<ReturnType<typeof prepareGatewayKernelRequestRuntime>>;
