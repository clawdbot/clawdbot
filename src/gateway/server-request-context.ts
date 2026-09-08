// Gateway request context factory.
// Wires live runtime state into method handlers and client management helpers.
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
  type GatewayClientId,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "./desktop/node-source-context.js";
import { ScopeUpgradeCoordinator } from "./device-scope-upgrade.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { startGatewayCoreRuntime } from "./server-core-runtime.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import {
  disconnectAllSharedGatewayAuthClients,
  enforceSharedGatewaySessionGenerationForConfigWrite,
} from "./server-shared-auth-generation.js";
import { recordClientPresenceActivity, refreshClientPresence } from "./server/client-presence.js";
import {
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
} from "./server/health-state.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type GatewayRequestContextClient = GatewayClient & {
  socket: { close: (code: number, reason: string) => void };
  usesSharedGatewayAuth?: boolean;
  invalidated?: boolean;
  invalidatedReason?: string;
};

type GatewayCoreRuntime = Awaited<ReturnType<typeof startGatewayCoreRuntime>>;

type GatewayRequestContextRuntime = Pick<
  GatewayRequestContext,
  | "deps"
  | "mentionInbox"
  | "execApprovalManager"
  | "questionManager"
  | "forwardPluginApprovalRequest"
  | "approvalWebPushDelivery"
  | "pluginApprovalIosPushDelivery"
  | "pluginApprovalManager"
  | "placementStandingGrants"
  | "systemAgentApprovalManager"
  | "loadGatewayModelCatalog"
  | "loadGatewayModelCatalogSnapshot"
  | "readPreparedGatewayModelCatalog"
  | "getRuntimeSnapshot"
  | "broadcast"
  | "broadcastToConnIds"
  | "nodeSendToSession"
  | "nodeSendToAllSubscribed"
  | "nodeSubscribe"
  | "nodeUnsubscribe"
  | "nodeUnsubscribeAll"
  | "nodeRegistry"
  | "workerEnvironmentService"
  | "hostDesktopService"
  | "githubPublicationService"
  | "validateAgentRuntimeApprovalAuthority"
  | "terminalSessions"
  | "agentRunSeq"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "addChatRun"
  | "removeChatRun"
  | "subscribeSessionMessageEvents"
  | "unsubscribeSessionMessageEvents"
  | "dedupe"
  | "wizardSessions"
  | "systemAgentSessions"
  | "findRunningWizard"
  | "purgeWizardSession"
  | "startChannel"
  | "stopChannel"
  | "markChannelLoggedOut"
  | "wizardRunner"
  | "channelWizardRunner"
  | "broadcastVoiceWakeChanged"
  | "broadcastVoiceWakeRoutingChanged"
  | "unavailableGatewayMethods"
> &
  Pick<
    GatewayCoreRuntime,
    | "refreshGatewayHealthSnapshotWithRuntime"
    | "hasTalkNodeConnected"
    | "sharedGatewaySessionGenerationState"
    | "resolveSharedGatewaySessionGenerationForRuntimeSnapshot"
    | "workerPlacementControlAvailable"
    | "getAttachedGatewayMethodRegistry"
  > & {
    sessionObserver: NonNullable<GatewayRequestContext["sessionObserver"]>;
    sessionCompanion: NonNullable<GatewayRequestContext["sessionCompanion"]>;
    isConnectionActive: NonNullable<GatewayRequestContext["isConnectionActive"]>;
    clients: Set<GatewayWsClient>;
    gatewayTls: Pick<GatewayCoreRuntime["gatewayTls"], "enabled" | "fingerprintSha256">;
    nodeDesktopService?: GatewayCoreRuntime["nodeDesktopService"];
    cancelRunBoundApprovals?: GatewayCoreRuntime["cancelRunBoundApprovals"];
    connectionWork: Pick<GatewayCoreRuntime["connectionWork"], "track">;
    runtimeState: Pick<
      GatewayCoreRuntime["runtimeState"],
      "cronState" | "controlUiSessionPullRequests" | "sessionViewerPresence"
    > & {
      configReloader: Pick<
        GatewayCoreRuntime["runtimeState"]["configReloader"],
        "isConfigReloadSettled"
      >;
    };
    lifecycle: Pick<GatewayCoreRuntime["lifecycle"], "closePreludeStarted">;
    transportBridge: Pick<
      GatewayCoreRuntime["transportBridge"],
      "getPortalService" | "getMcpAppSandboxPort" | "ensureSandboxHostPort"
    >;
    terminalLaunchPolicy: Pick<GatewayCoreRuntime["terminalLaunchPolicy"], "resolve" | "isEnabled">;
    approvalSessionEvents: { replay: GatewayRequestContext["listSessionPendingApprovals"] };
    watchNodeHttpRuntime: Pick<
      GatewayCoreRuntime["watchNodeHttpRuntime"],
      "invalidateSessionsForDevice" | "disconnectSessionsForDevice"
    >;
    sessionEventSubscribers: Pick<
      GatewayCoreRuntime["sessionEventSubscribers"],
      "subscribe" | "unsubscribe" | "getAll"
    >;
    sessionMessageSubscribers: Pick<
      GatewayCoreRuntime["sessionMessageSubscribers"],
      "unsubscribeAll"
    >;
    toolEventRecipients: Pick<GatewayCoreRuntime["toolEventRecipients"], "add">;
    readinessEventLoopHealth: Pick<GatewayCoreRuntime["readinessEventLoopHealth"], "snapshot">;
    kernel: Pick<
      GatewayCoreRuntime["kernel"],
      "notifyPluginMetadataChanged" | "getConfigReloaderHotReloadStatus"
    >;
    workerEnvironmentStartup:
      | Pick<NonNullable<GatewayCoreRuntime["workerEnvironmentStartup"]>, "placementStore">
      | undefined;
    workerPlacementRuntime:
      | {
          diskSpace: GatewayRequestContext["workerPlacementDiskSpaceReader"];
          runnerAvailability: GatewayRequestContext["workerPlacementRunnerAvailabilityReader"];
          repositoryWorkspaceMutationService: GatewayRequestContext["workerRepositoryWorkspaceMutationService"];
        }
      | undefined;
  };

type GatewayRequestContextParams = {
  runtime: GatewayRequestContextRuntime;
  configRevisionProjector: GatewayRequestContext["configRevisionProjector"];
  chatMetadataLifecycle: {
    read: GatewayRequestContext["readChatMetadata"];
    readStartup: GatewayRequestContext["readChatStartupProjection"];
  };
  log: GatewayRequestContext["logGateway"];
  logHealth: GatewayRequestContext["logHealth"];
};

const ALL_APPROVAL_CLIENT_IDS: ReadonlySet<GatewayClientId> = new Set([
  GATEWAY_CLIENT_IDS.CONTROL_UI,
]);

const EXEC_APPROVAL_CLIENT_IDS: ReadonlySet<GatewayClientId> = new Set([
  GATEWAY_CLIENT_IDS.MACOS_APP,
  GATEWAY_CLIENT_IDS.IOS_APP,
  GATEWAY_CLIENT_IDS.ANDROID_APP,
]);

const PLUGIN_APPROVAL_CLIENT_IDS: ReadonlySet<GatewayClientId> = new Set([GATEWAY_CLIENT_IDS.TUI]);

function canDeliverApprovals(
  gatewayClient: GatewayRequestContextClient,
  approvalKind: "exec" | "plugin" | "system-agent",
): boolean {
  if (gatewayClient.invalidated) {
    return false;
  }
  const scopes = Array.isArray(gatewayClient.connect.scopes) ? gatewayClient.connect.scopes : [];
  const hasApprovalScope =
    scopes.includes("operator.admin") || scopes.includes("operator.approvals");
  if (!hasApprovalScope) {
    return false;
  }
  // Scope grants approval access; it does not prove the client renders this approval kind.
  // Stable ids preserve shipped clients while explicit caps describe newer non-UI bridges.
  return (
    gatewayClient.internal?.approvalRuntime === true ||
    ALL_APPROVAL_CLIENT_IDS.has(gatewayClient.connect.client.id) ||
    hasGatewayClientCap(gatewayClient.connect.caps, GATEWAY_CLIENT_CAPS.APPROVALS) ||
    (approvalKind === "exec" &&
      (EXEC_APPROVAL_CLIENT_IDS.has(gatewayClient.connect.client.id) ||
        hasGatewayClientCap(gatewayClient.connect.caps, GATEWAY_CLIENT_CAPS.EXEC_APPROVALS))) ||
    (approvalKind === "plugin" &&
      (PLUGIN_APPROVAL_CLIENT_IDS.has(gatewayClient.connect.client.id) ||
        hasGatewayClientCap(gatewayClient.connect.caps, GATEWAY_CLIENT_CAPS.PLUGIN_APPROVALS)))
  );
}

export function createGatewayRequestContext(
  params: GatewayRequestContextParams,
): GatewayRequestContext {
  const { runtime } = params;
  const {
    connectionWork,
    runtimeState,
    lifecycle,
    cancelRunBoundApprovals,
    clients,
    broadcast,
    nodeRegistry,
    sharedGatewaySessionGenerationState,
    resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    sessionObserver,
  } = runtime;
  const { getPortalService } = runtime.transportBridge;
  const workerSessionPlacementService = runtime.workerEnvironmentStartup?.placementStore;
  const workerPlacementDiskSpaceReader = runtime.workerPlacementRuntime?.diskSpace;
  const workerPlacementRunnerAvailabilityReader =
    runtime.workerPlacementRuntime?.runnerAvailability;
  const workerRepositoryWorkspaceMutationService =
    runtime.workerPlacementRuntime?.repositoryWorkspaceMutationService;
  const {
    invalidateSessionsForDevice: invalidateDeviceTransports,
    disconnectSessionsForDevice: disconnectDeviceTransports,
  } = runtime.watchNodeHttpRuntime;
  const scopeUpgradeCoordinator = new ScopeUpgradeCoordinator();
  const context: GatewayRequestContext = {
    trackExecution: (run) => connectionWork.track(run),
    deps: runtime.deps,
    configRevisionProjector: params.configRevisionProjector,
    // Keep cron reads live so config hot reload can swap cron/store state without rebuilding
    // every handler closure that already holds this request context.
    get cron() {
      return runtimeState.cronState.cron;
    },
    get cronStorePath() {
      return runtimeState.cronState.storePath;
    },
    getRuntimeConfig,
    isConfigReloadSettled: () =>
      !lifecycle.closePreludeStarted && runtimeState.configReloader.isConfigReloadSettled(),
    getGatewayMethodRegistry: runtime.getAttachedGatewayMethodRegistry,
    gatewayTlsFingerprint: runtime.gatewayTls.enabled
      ? runtime.gatewayTls.fingerprintSha256
      : undefined,
    controlUiSessionPullRequests: runtimeState.controlUiSessionPullRequests,
    sessionViewerPresence: runtimeState.sessionViewerPresence,
    sessionCompanion: runtime.sessionCompanion,
    sessionObserver,
    mentionInbox: runtime.mentionInbox,
    notifyPluginMetadataChanged: runtime.kernel.notifyPluginMetadataChanged,
    getMcpAppSandboxPort: runtime.transportBridge.getMcpAppSandboxPort,
    ensureSandboxHostPort: runtime.transportBridge.ensureSandboxHostPort,
    get portalService() {
      return getPortalService?.();
    },
    resolveTerminalLaunchPolicy: runtime.terminalLaunchPolicy.resolve,
    isTerminalEnabled: runtime.terminalLaunchPolicy.isEnabled,
    execApprovalManager: runtime.execApprovalManager,
    questionManager: runtime.questionManager,
    scopeUpgradeCoordinator,
    cancelRunBoundApprovals: cancelRunBoundApprovals
      ? (runId) => cancelRunBoundApprovals(runId, context)
      : undefined,
    forwardPluginApprovalRequest: runtime.forwardPluginApprovalRequest,
    approvalWebPushDelivery: runtime.approvalWebPushDelivery,
    pluginApprovalIosPushDelivery: runtime.pluginApprovalIosPushDelivery,
    pluginApprovalManager: runtime.pluginApprovalManager,
    placementStandingGrants: runtime.placementStandingGrants,
    systemAgentApprovalManager: runtime.systemAgentApprovalManager,
    listSessionPendingApprovals: runtime.approvalSessionEvents.replay,
    loadGatewayModelCatalog: runtime.loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot: runtime.loadGatewayModelCatalogSnapshot,
    ...(runtime.readPreparedGatewayModelCatalog
      ? { readPreparedGatewayModelCatalog: runtime.readPreparedGatewayModelCatalog }
      : {}),
    readChatMetadata: params.chatMetadataLifecycle.read,
    ...(params.chatMetadataLifecycle.readStartup
      ? { readChatStartupProjection: params.chatMetadataLifecycle.readStartup }
      : {}),
    getHealthCache,
    refreshHealthSnapshot: runtime.refreshGatewayHealthSnapshotWithRuntime,
    logHealth: params.logHealth,
    logGateway: params.log,
    incrementPresenceVersion,
    getHealthVersion,
    broadcast,
    broadcastToConnIds: runtime.broadcastToConnIds,
    nodeSendToSession: runtime.nodeSendToSession,
    nodeSendToAllSubscribed: runtime.nodeSendToAllSubscribed,
    nodeSubscribe: runtime.nodeSubscribe,
    nodeUnsubscribe: runtime.nodeUnsubscribe,
    nodeUnsubscribeAll: runtime.nodeUnsubscribeAll,
    hasConnectedTalkNode: runtime.hasTalkNodeConnected,
    isConnectionActive: runtime.isConnectionActive,
    recordClientActivity: (client) => {
      if (recordClientPresenceActivity(clients, client)) {
        broadcastPresenceSnapshot({
          broadcast,
          incrementPresenceVersion,
          getHealthVersion,
        });
      }
    },
    hasExecApprovalClients: (excludeConnId?: string) => {
      for (const gatewayClient of clients) {
        if (excludeConnId && gatewayClient.connId === excludeConnId) {
          continue;
        }
        if (canDeliverApprovals(gatewayClient, "exec")) {
          return true;
        }
      }
      return false;
    },
    getApprovalClientConnIds: (opts = {}) => {
      const connIds = new Set<string>();
      for (const gatewayClient of clients) {
        if (!gatewayClient.connId) {
          continue;
        }
        if (opts.excludeConnId && gatewayClient.connId === opts.excludeConnId) {
          continue;
        }
        if (!canDeliverApprovals(gatewayClient, opts.approvalKind ?? "exec")) {
          continue;
        }
        if (opts.filter && !opts.filter(gatewayClient, opts.record)) {
          continue;
        }
        connIds.add(gatewayClient.connId);
      }
      return connIds;
    },
    getClientConnIds: (filter) => {
      const connIds = new Set<string>();
      for (const gatewayClient of clients) {
        if (!gatewayClient.connId || gatewayClient.invalidated) {
          continue;
        }
        if (filter && !filter(gatewayClient)) {
          continue;
        }
        connIds.add(gatewayClient.connId);
      }
      return connIds;
    },
    hasConnectedClientsForDevice: (deviceId: string) => {
      for (const gatewayClient of clients) {
        if (gatewayClient.connect.device?.id === deviceId && !gatewayClient.invalidated) {
          return true;
        }
      }
      return false;
    },
    refreshConnectedUserProfile: (profile) => {
      let presenceChanged = false;
      for (const gatewayClient of clients) {
        if (
          gatewayClient.invalidated ||
          gatewayClient.socket.readyState !== WEBSOCKET_OPEN_READY_STATE
        ) {
          continue;
        }
        const authenticatedUserProfile = gatewayClient.authenticatedUserProfile;
        if (!authenticatedUserProfile) {
          continue;
        }
        const canonicalProfileId =
          authenticatedUserProfile.profileId === profile.id
            ? profile.id
            : resolveUserProfileId(authenticatedUserProfile.profileId);
        if (canonicalProfileId !== profile.id) {
          continue;
        }
        Object.assign(authenticatedUserProfile, {
          profileId: canonicalProfileId,
          displayName: profile.displayName,
          avatarRevision: profile.avatarRevision,
          hasAvatar: profile.hasAvatar,
          updatedAt: profile.updatedAt,
        });
        presenceChanged = refreshClientPresence(clients, gatewayClient) || presenceChanged;
      }
      if (presenceChanged) {
        broadcastPresenceSnapshot({
          broadcast,
          incrementPresenceVersion,
          getHealthVersion,
        });
      }
    },
    invalidateClientsForDevice: (deviceId: string, opts?: { role?: string; reason?: string }) => {
      const reason = opts?.reason ?? "device-invalidated";
      for (const gatewayClient of clients) {
        if (gatewayClient.connect.device?.id !== deviceId) {
          continue;
        }
        if (opts?.role && gatewayClient.connect.role !== opts.role) {
          continue;
        }
        // Retire node-owned projections and pending invokes synchronously; socket
        // close remains separate so already-buffered requests fail authorization.
        if (gatewayClient.connId) {
          nodeRegistry.invalidateConnectionForPairingChange(gatewayClient.connId, reason);
        }
        gatewayClient.invalidated = true;
        gatewayClient.invalidatedReason = reason;
      }
      invalidateDeviceTransports?.(deviceId, opts);
    },
    disconnectClientsForDevice: (deviceId: string, opts?: { role?: string }) => {
      for (const gatewayClient of clients) {
        if (gatewayClient.connect.device?.id !== deviceId) {
          continue;
        }
        if (opts?.role && gatewayClient.connect.role !== opts.role) {
          continue;
        }
        // Mark before closing so any RPCs already pipelined in the WS buffer
        // are rejected at the per-request dispatch check, regardless of
        // whether socket.close() takes effect synchronously.
        gatewayClient.invalidated = true;
        gatewayClient.invalidatedReason ??= "device-removed";
        try {
          gatewayClient.socket.close(4001, "device removed");
        } catch {
          /* ignore */
        }
      }
      disconnectDeviceTransports?.(deviceId, opts);
    },
    disconnectClientsForUserProfile: (profileId: string) => {
      for (const gatewayClient of clients) {
        if (gatewayClient.authenticatedUserProfile?.profileId !== profileId) {
          continue;
        }
        // Invalidate before closing so buffered requests cannot retain revoked role scopes.
        gatewayClient.invalidated = true;
        gatewayClient.invalidatedReason = "operator-role-changed";
        try {
          gatewayClient.socket.close(4001, "operator role changed");
        } catch {
          /* ignore */
        }
      }
    },
    disconnectClientsUsingSharedGatewayAuth: () => {
      disconnectAllSharedGatewayAuthClients(clients);
    },
    enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig) => {
      enforceSharedGatewaySessionGenerationForConfigWrite({
        state: sharedGatewaySessionGenerationState,
        nextConfig,
        resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
        clients,
      });
    },
    nodeRegistry,
    ...(runtime.nodeDesktopService
      ? { [NODE_DESKTOP_SERVICE_CONTEXT]: runtime.nodeDesktopService }
      : {}),
    ...(runtime.workerEnvironmentService
      ? { workerEnvironmentService: runtime.workerEnvironmentService }
      : {}),
    ...(runtime.hostDesktopService ? { hostDesktopService: runtime.hostDesktopService } : {}),
    ...(workerSessionPlacementService ? { workerSessionPlacementService } : {}),
    ...(workerPlacementDiskSpaceReader ? { workerPlacementDiskSpaceReader } : {}),
    ...(workerPlacementRunnerAvailabilityReader ? { workerPlacementRunnerAvailabilityReader } : {}),
    ...(workerRepositoryWorkspaceMutationService
      ? { workerRepositoryWorkspaceMutationService }
      : {}),
    validateAgentRuntimeApprovalAuthority: runtime.validateAgentRuntimeApprovalAuthority,
    ...(runtime.workerPlacementControlAvailable
      ? { workerPlacementDispatchService: runtime.workerPlacementControlAvailable }
      : {}),
    ...(runtime.githubPublicationService
      ? { githubPublicationService: runtime.githubPublicationService }
      : {}),
    terminalSessions: runtime.terminalSessions,
    agentRunSeq: runtime.agentRunSeq,
    chatAbortControllers: runtime.chatAbortControllers,
    chatQueuedTurns: runtime.chatQueuedTurns,
    chatRunState: runtime.chatRunState,
    addChatRun: runtime.addChatRun,
    removeChatRun: runtime.removeChatRun,
    subscribeSessionEvents: sessionEventSubscribers.subscribe,
    unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
    subscribeSessionMessageEvents: runtime.subscribeSessionMessageEvents,
    unsubscribeSessionMessageEvents: runtime.unsubscribeSessionMessageEvents,
    unsubscribeAllSessionEvents: (connId) => {
      sessionEventSubscribers.unsubscribe(connId);
      sessionMessageSubscribers.unsubscribeAll(connId);
      sessionObserver.removeConnection(connId);
      // PR replace-sets share this websocket cleanup boundary with session events.
      runtimeState.controlUiSessionPullRequests?.unsubscribe(connId);
      runtimeState.sessionViewerPresence?.unsubscribe(connId);
    },
    getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
    registerToolEventRecipient: runtime.toolEventRecipients.add,
    dedupe: runtime.dedupe,
    wizardSessions: runtime.wizardSessions,
    systemAgentSessions: runtime.systemAgentSessions,
    findRunningWizard: runtime.findRunningWizard,
    purgeWizardSession: runtime.purgeWizardSession,
    getRuntimeSnapshot: runtime.getRuntimeSnapshot,
    getEventLoopHealth: runtime.readinessEventLoopHealth.snapshot,
    getConfigReloaderHotReloadStatus: runtime.kernel.getConfigReloaderHotReloadStatus,
    startChannel: runtime.startChannel,
    stopChannel: runtime.stopChannel,
    markChannelLoggedOut: runtime.markChannelLoggedOut,
    wizardRunner: runtime.wizardRunner,
    channelWizardRunner: runtime.channelWizardRunner,
    broadcastVoiceWakeChanged: runtime.broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged: runtime.broadcastVoiceWakeRoutingChanged,
    unavailableGatewayMethods: runtime.unavailableGatewayMethods,
  };
  return context;
}
