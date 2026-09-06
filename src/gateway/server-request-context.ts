// Gateway request context factory.
// Wires live runtime state into method handlers and client management helpers.
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
  type GatewayClientId,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import { NODE_DESKTOP_SERVICE_CONTEXT } from "./desktop/node-source-context.js";
import { ScopeUpgradeCoordinator } from "./device-scope-upgrade.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { disconnectAllSharedGatewayAuthClients } from "./server-shared-auth-generation.js";
import { recordClientPresenceActivity, refreshClientPresence } from "./server/client-presence.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { SessionCompanionService } from "./session-companion.js";
import type { SessionObserverService } from "./session-observer-contract.js";

type GatewayRequestContextClient = GatewayClient & {
  socket: { close: (code: number, reason: string) => void };
  usesSharedGatewayAuth?: boolean;
  invalidated?: boolean;
  invalidatedReason?: string;
};

type GatewayRequestContextParams = {
  trackExecution: GatewayRequestContext["trackExecution"];
  deps: GatewayRequestContext["deps"];
  configRevisionProjector: GatewayRequestContext["configRevisionProjector"];
  runtimeState: Pick<
    GatewayServerLiveState,
    "cronState" | "controlUiSessionPullRequests" | "sessionViewerPresence"
  >;
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  isConfigReloadSettled: GatewayRequestContext["isConfigReloadSettled"];
  getGatewayMethodRegistry: NonNullable<GatewayRequestContext["getGatewayMethodRegistry"]>;
  gatewayTlsFingerprint?: GatewayRequestContext["gatewayTlsFingerprint"];
  sessionCompanion: SessionCompanionService;
  sessionObserver: SessionObserverService;
  mentionInbox?: GatewayRequestContext["mentionInbox"];
  getMcpAppSandboxPort?: GatewayRequestContext["getMcpAppSandboxPort"];
  ensureSandboxHostPort?: GatewayRequestContext["ensureSandboxHostPort"];
  getPortalService?: () => GatewayRequestContext["portalService"];
  resolveTerminalLaunchPolicy: GatewayRequestContext["resolveTerminalLaunchPolicy"];
  isTerminalEnabled: GatewayRequestContext["isTerminalEnabled"];
  execApprovalManager: GatewayRequestContext["execApprovalManager"];
  questionManager?: GatewayRequestContext["questionManager"];
  cancelRunBoundApprovals?: (
    target: Parameters<NonNullable<GatewayRequestContext["cancelRunBoundApprovals"]>>[0],
    context: GatewayRequestContext,
  ) => number;
  forwardPluginApprovalRequest?: GatewayRequestContext["forwardPluginApprovalRequest"];
  approvalWebPushDelivery?: GatewayRequestContext["approvalWebPushDelivery"];
  pluginApprovalIosPushDelivery?: GatewayRequestContext["pluginApprovalIosPushDelivery"];
  pluginApprovalManager: GatewayRequestContext["pluginApprovalManager"];
  placementStandingGrants: GatewayRequestContext["placementStandingGrants"];
  systemAgentApprovalManager?: GatewayRequestContext["systemAgentApprovalManager"];
  listSessionPendingApprovals: GatewayRequestContext["listSessionPendingApprovals"];
  loadGatewayModelCatalog: GatewayRequestContext["loadGatewayModelCatalog"];
  loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"];
  readPreparedGatewayModelCatalog?: GatewayRequestContext["readPreparedGatewayModelCatalog"];
  readChatMetadata: GatewayRequestContext["readChatMetadata"];
  readChatStartupProjection?: GatewayRequestContext["readChatStartupProjection"];
  getHealthCache: GatewayRequestContext["getHealthCache"];
  refreshHealthSnapshot: GatewayRequestContext["refreshHealthSnapshot"];
  logHealth: GatewayRequestContext["logHealth"];
  logGateway: GatewayRequestContext["logGateway"];
  incrementPresenceVersion: GatewayRequestContext["incrementPresenceVersion"];
  getHealthVersion: GatewayRequestContext["getHealthVersion"];
  broadcast: GatewayRequestContext["broadcast"];
  broadcastToConnIds: GatewayRequestContext["broadcastToConnIds"];
  nodeSendToSession: GatewayRequestContext["nodeSendToSession"];
  nodeSendToAllSubscribed: GatewayRequestContext["nodeSendToAllSubscribed"];
  nodeSubscribe: GatewayRequestContext["nodeSubscribe"];
  nodeUnsubscribe: GatewayRequestContext["nodeUnsubscribe"];
  nodeUnsubscribeAll: GatewayRequestContext["nodeUnsubscribeAll"];
  hasConnectedTalkNode: GatewayRequestContext["hasConnectedTalkNode"];
  clients: Set<GatewayWsClient>;
  isConnectionActive: NonNullable<GatewayRequestContext["isConnectionActive"]>;
  invalidateDeviceTransports?: (
    deviceId: string,
    opts?: { role?: string; reason?: string },
  ) => void;
  disconnectDeviceTransports?: (deviceId: string, opts?: { role?: string }) => void;
  enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: GatewayRequestContext["nodeRegistry"];
  nodeDesktopService?: import("./desktop/node-source.js").NodeDesktopService;
  workerEnvironmentService?: GatewayRequestContext["workerEnvironmentService"];
  hostDesktopService?: GatewayRequestContext["hostDesktopService"];
  workerSessionPlacementService?: GatewayRequestContext["workerSessionPlacementService"];
  workerPlacementDiskSpaceReader?: GatewayRequestContext["workerPlacementDiskSpaceReader"];
  workerPlacementRunnerAvailabilityReader?: GatewayRequestContext["workerPlacementRunnerAvailabilityReader"];
  workerPlacementDispatchService?: GatewayRequestContext["workerPlacementDispatchService"];
  githubPublicationService?: GatewayRequestContext["githubPublicationService"];
  validateAgentRuntimeApprovalAuthority: GatewayRequestContext["validateAgentRuntimeApprovalAuthority"];
  terminalSessions?: GatewayRequestContext["terminalSessions"];
  agentRunSeq: GatewayRequestContext["agentRunSeq"];
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"];
  chatQueuedTurns: GatewayRequestContext["chatQueuedTurns"];
  chatRunState: GatewayRequestContext["chatRunState"];
  addChatRun: GatewayRequestContext["addChatRun"];
  removeChatRun: GatewayRequestContext["removeChatRun"];
  subscribeSessionEvents: GatewayRequestContext["subscribeSessionEvents"];
  unsubscribeSessionEvents: GatewayRequestContext["unsubscribeSessionEvents"];
  subscribeSessionMessageEvents: GatewayRequestContext["subscribeSessionMessageEvents"];
  unsubscribeSessionMessageEvents: GatewayRequestContext["unsubscribeSessionMessageEvents"];
  unsubscribeAllSessionEvents: GatewayRequestContext["unsubscribeAllSessionEvents"];
  getSessionEventSubscriberConnIds: GatewayRequestContext["getSessionEventSubscriberConnIds"];
  registerToolEventRecipient: GatewayRequestContext["registerToolEventRecipient"];
  dedupe: GatewayRequestContext["dedupe"];
  wizardSessions: GatewayRequestContext["wizardSessions"];
  systemAgentSessions: GatewayRequestContext["systemAgentSessions"];
  findRunningWizard: GatewayRequestContext["findRunningWizard"];
  purgeWizardSession: GatewayRequestContext["purgeWizardSession"];
  getRuntimeSnapshot: GatewayRequestContext["getRuntimeSnapshot"];
  getEventLoopHealth?: GatewayRequestContext["getEventLoopHealth"];
  startChannel: GatewayRequestContext["startChannel"];
  stopChannel: GatewayRequestContext["stopChannel"];
  markChannelLoggedOut: GatewayRequestContext["markChannelLoggedOut"];
  wizardRunner: GatewayRequestContext["wizardRunner"];
  channelWizardRunner: GatewayRequestContext["channelWizardRunner"];
  broadcastVoiceWakeChanged: GatewayRequestContext["broadcastVoiceWakeChanged"];
  broadcastVoiceWakeRoutingChanged: GatewayRequestContext["broadcastVoiceWakeRoutingChanged"];
  notifyPluginMetadataChanged: GatewayRequestContext["notifyPluginMetadataChanged"];
  getConfigReloaderHotReloadStatus: GatewayRequestContext["getConfigReloaderHotReloadStatus"];
  unavailableGatewayMethods: ReadonlySet<string>;
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

export type GatewayRequestContextWithClientLookup = GatewayRequestContext & {
  getClientConnIds?: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
};

export function createGatewayRequestContext(
  params: GatewayRequestContextParams,
): GatewayRequestContextWithClientLookup {
  const scopeUpgradeCoordinator = new ScopeUpgradeCoordinator();
  const context: GatewayRequestContextWithClientLookup = {
    trackExecution: params.trackExecution,
    deps: params.deps,
    configRevisionProjector: params.configRevisionProjector,
    // Keep cron reads live so config hot reload can swap cron/store state without rebuilding
    // every handler closure that already holds this request context.
    get cron() {
      return params.runtimeState.cronState.cron;
    },
    get cronStorePath() {
      return params.runtimeState.cronState.storePath;
    },
    getRuntimeConfig: params.getRuntimeConfig,
    isConfigReloadSettled: params.isConfigReloadSettled,
    getGatewayMethodRegistry: params.getGatewayMethodRegistry,
    gatewayTlsFingerprint: params.gatewayTlsFingerprint,
    controlUiSessionPullRequests: params.runtimeState.controlUiSessionPullRequests,
    sessionViewerPresence: params.runtimeState.sessionViewerPresence,
    sessionCompanion: params.sessionCompanion,
    sessionObserver: params.sessionObserver,
    mentionInbox: params.mentionInbox,
    notifyPluginMetadataChanged: params.notifyPluginMetadataChanged,
    getMcpAppSandboxPort: params.getMcpAppSandboxPort,
    ensureSandboxHostPort: params.ensureSandboxHostPort,
    get portalService() {
      return params.getPortalService?.();
    },
    resolveTerminalLaunchPolicy: params.resolveTerminalLaunchPolicy,
    isTerminalEnabled: params.isTerminalEnabled,
    execApprovalManager: params.execApprovalManager,
    questionManager: params.questionManager,
    scopeUpgradeCoordinator,
    cancelRunBoundApprovals: params.cancelRunBoundApprovals
      ? (runId) => params.cancelRunBoundApprovals!(runId, context)
      : undefined,
    forwardPluginApprovalRequest: params.forwardPluginApprovalRequest,
    approvalWebPushDelivery: params.approvalWebPushDelivery,
    pluginApprovalIosPushDelivery: params.pluginApprovalIosPushDelivery,
    pluginApprovalManager: params.pluginApprovalManager,
    placementStandingGrants: params.placementStandingGrants,
    systemAgentApprovalManager: params.systemAgentApprovalManager,
    listSessionPendingApprovals: params.listSessionPendingApprovals,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
    ...(params.readPreparedGatewayModelCatalog
      ? { readPreparedGatewayModelCatalog: params.readPreparedGatewayModelCatalog }
      : {}),
    readChatMetadata: params.readChatMetadata,
    ...(params.readChatStartupProjection
      ? { readChatStartupProjection: params.readChatStartupProjection }
      : {}),
    getHealthCache: params.getHealthCache,
    refreshHealthSnapshot: params.refreshHealthSnapshot,
    logHealth: params.logHealth,
    logGateway: params.logGateway,
    incrementPresenceVersion: params.incrementPresenceVersion,
    getHealthVersion: params.getHealthVersion,
    broadcast: params.broadcast,
    broadcastToConnIds: params.broadcastToConnIds,
    nodeSendToSession: params.nodeSendToSession,
    nodeSendToAllSubscribed: params.nodeSendToAllSubscribed,
    nodeSubscribe: params.nodeSubscribe,
    nodeUnsubscribe: params.nodeUnsubscribe,
    nodeUnsubscribeAll: params.nodeUnsubscribeAll,
    hasConnectedTalkNode: params.hasConnectedTalkNode,
    isConnectionActive: params.isConnectionActive,
    recordClientActivity: (client) => {
      if (recordClientPresenceActivity(params.clients, client)) {
        broadcastPresenceSnapshot(params);
      }
    },
    hasExecApprovalClients: (excludeConnId?: string) => {
      for (const gatewayClient of params.clients) {
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
      for (const gatewayClient of params.clients) {
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
      for (const gatewayClient of params.clients) {
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
      for (const gatewayClient of params.clients) {
        if (gatewayClient.connect.device?.id === deviceId && !gatewayClient.invalidated) {
          return true;
        }
      }
      return false;
    },
    refreshConnectedUserProfile: (profile) => {
      let presenceChanged = false;
      for (const gatewayClient of params.clients) {
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
        presenceChanged = refreshClientPresence(params.clients, gatewayClient) || presenceChanged;
      }
      if (presenceChanged) {
        broadcastPresenceSnapshot({
          broadcast: params.broadcast,
          incrementPresenceVersion: params.incrementPresenceVersion,
          getHealthVersion: params.getHealthVersion,
        });
      }
    },
    invalidateClientsForDevice: (deviceId: string, opts?: { role?: string; reason?: string }) => {
      const reason = opts?.reason ?? "device-invalidated";
      for (const gatewayClient of params.clients) {
        if (gatewayClient.connect.device?.id !== deviceId) {
          continue;
        }
        if (opts?.role && gatewayClient.connect.role !== opts.role) {
          continue;
        }
        // Retire node-owned projections and pending invokes synchronously; socket
        // close remains separate so already-buffered requests fail authorization.
        if (gatewayClient.connId) {
          params.nodeRegistry.invalidateConnectionForPairingChange(gatewayClient.connId, reason);
        }
        gatewayClient.invalidated = true;
        gatewayClient.invalidatedReason = reason;
      }
      params.invalidateDeviceTransports?.(deviceId, opts);
    },
    disconnectClientsForDevice: (deviceId: string, opts?: { role?: string }) => {
      for (const gatewayClient of params.clients) {
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
      params.disconnectDeviceTransports?.(deviceId, opts);
    },
    disconnectClientsForUserProfile: (profileId: string) => {
      for (const gatewayClient of params.clients) {
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
      disconnectAllSharedGatewayAuthClients(params.clients);
    },
    enforceSharedGatewayAuthGenerationForConfigWrite:
      params.enforceSharedGatewayAuthGenerationForConfigWrite,
    nodeRegistry: params.nodeRegistry,
    ...(params.nodeDesktopService
      ? { [NODE_DESKTOP_SERVICE_CONTEXT]: params.nodeDesktopService }
      : {}),
    ...(params.workerEnvironmentService
      ? { workerEnvironmentService: params.workerEnvironmentService }
      : {}),
    ...(params.hostDesktopService ? { hostDesktopService: params.hostDesktopService } : {}),
    ...(params.workerSessionPlacementService
      ? { workerSessionPlacementService: params.workerSessionPlacementService }
      : {}),
    ...(params.workerPlacementDiskSpaceReader
      ? { workerPlacementDiskSpaceReader: params.workerPlacementDiskSpaceReader }
      : {}),
    ...(params.workerPlacementRunnerAvailabilityReader
      ? { workerPlacementRunnerAvailabilityReader: params.workerPlacementRunnerAvailabilityReader }
      : {}),
    validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
    ...(params.workerPlacementDispatchService
      ? { workerPlacementDispatchService: params.workerPlacementDispatchService }
      : {}),
    ...(params.githubPublicationService
      ? { githubPublicationService: params.githubPublicationService }
      : {}),
    terminalSessions: params.terminalSessions,
    agentRunSeq: params.agentRunSeq,
    chatAbortControllers: params.chatAbortControllers,
    chatQueuedTurns: params.chatQueuedTurns,
    chatRunState: params.chatRunState,
    addChatRun: params.addChatRun,
    removeChatRun: params.removeChatRun,
    subscribeSessionEvents: params.subscribeSessionEvents,
    unsubscribeSessionEvents: params.unsubscribeSessionEvents,
    subscribeSessionMessageEvents: params.subscribeSessionMessageEvents,
    unsubscribeSessionMessageEvents: params.unsubscribeSessionMessageEvents,
    unsubscribeAllSessionEvents: (connId) => {
      params.unsubscribeAllSessionEvents(connId);
      // PR replace-sets share this websocket cleanup boundary with session events.
      params.runtimeState.controlUiSessionPullRequests?.unsubscribe(connId);
      params.runtimeState.sessionViewerPresence?.unsubscribe(connId);
    },
    getSessionEventSubscriberConnIds: params.getSessionEventSubscriberConnIds,
    registerToolEventRecipient: params.registerToolEventRecipient,
    dedupe: params.dedupe,
    wizardSessions: params.wizardSessions,
    systemAgentSessions: params.systemAgentSessions,
    findRunningWizard: params.findRunningWizard,
    purgeWizardSession: params.purgeWizardSession,
    getRuntimeSnapshot: params.getRuntimeSnapshot,
    getEventLoopHealth: params.getEventLoopHealth,
    getConfigReloaderHotReloadStatus: params.getConfigReloaderHotReloadStatus,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    markChannelLoggedOut: params.markChannelLoggedOut,
    wizardRunner: params.wizardRunner,
    channelWizardRunner: params.channelWizardRunner,
    broadcastVoiceWakeChanged: params.broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged: params.broadcastVoiceWakeRoutingChanged,
    unavailableGatewayMethods: params.unavailableGatewayMethods,
  };
  return context;
}
