// Gateway request context factory.
// Wires live runtime state into method handlers and client management helpers.
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
  type GatewayClientId,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { disconnectAllSharedGatewayAuthClients } from "./server-shared-auth-generation.js";
import type { SessionObserverService } from "./session-observer-contract.js";

type GatewayRequestContextClient = GatewayClient & {
  socket: { close: (code: number, reason: string) => void };
  usesSharedGatewayAuth?: boolean;
  invalidated?: boolean;
  invalidatedReason?: string;
};

type GatewayRequestContextParams = {
  deps: GatewayRequestContext["deps"];
  runtimeState: Pick<GatewayServerLiveState, "cronState" | "configReloader">;
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  sessionObserver: SessionObserverService;
  getMcpAppSandboxPort?: GatewayRequestContext["getMcpAppSandboxPort"];
  ensureSandboxHostPort?: GatewayRequestContext["ensureSandboxHostPort"];
  resolveTerminalLaunchPolicy: GatewayRequestContext["resolveTerminalLaunchPolicy"];
  isTerminalEnabled: GatewayRequestContext["isTerminalEnabled"];
  execApprovalManager: GatewayRequestContext["execApprovalManager"];
  cancelRunBoundApprovals?: (runId: string, context: GatewayRequestContext) => number;
  forwardPluginApprovalRequest?: GatewayRequestContext["forwardPluginApprovalRequest"];
  pluginApprovalIosPushDelivery?: GatewayRequestContext["pluginApprovalIosPushDelivery"];
  pluginApprovalManager: GatewayRequestContext["pluginApprovalManager"];
  systemAgentApprovalManager?: GatewayRequestContext["systemAgentApprovalManager"];
  listSessionPendingApprovals: GatewayRequestContext["listSessionPendingApprovals"];
  loadGatewayModelCatalog: GatewayRequestContext["loadGatewayModelCatalog"];
  loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"];
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
  clients: Set<GatewayRequestContextClient>;
  invalidateDeviceTransports?: (
    deviceId: string,
    opts?: { role?: string; reason?: string },
  ) => void;
  disconnectDeviceTransports?: (deviceId: string, opts?: { role?: string }) => void;
  enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => void;
  claimControlUiDeviceAuthMigration?: (deviceId: string) => boolean;
  releaseControlUiDeviceAuthMigrationClaim?: (deviceId: string) => void;
  completeControlUiDeviceAuthMigration?: (device: {
    deviceId: string;
    publicKey: string;
    scopes: string[];
  }) => void;
  nodeRegistry: GatewayRequestContext["nodeRegistry"];
  workerEnvironmentService?: GatewayRequestContext["workerEnvironmentService"];
  workerSessionPlacementService?: GatewayRequestContext["workerSessionPlacementService"];
  workerPlacementDispatchService?: GatewayRequestContext["workerPlacementDispatchService"];
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
  const context: GatewayRequestContextWithClientLookup = {
    deps: params.deps,
    // Keep cron reads live so config hot reload can swap cron/store state without rebuilding
    // every handler closure that already holds this request context.
    get cron() {
      return params.runtimeState.cronState.cron;
    },
    get cronStorePath() {
      return params.runtimeState.cronState.storePath;
    },
    getRuntimeConfig: params.getRuntimeConfig,
    sessionObserver: params.sessionObserver,
    notifyPluginMetadataChanged: () =>
      params.runtimeState.configReloader.notifyPluginMetadataChanged(),
    getMcpAppSandboxPort: params.getMcpAppSandboxPort,
    ensureSandboxHostPort: params.ensureSandboxHostPort,
    resolveTerminalLaunchPolicy: params.resolveTerminalLaunchPolicy,
    isTerminalEnabled: params.isTerminalEnabled,
    execApprovalManager: params.execApprovalManager,
    cancelRunBoundApprovals: params.cancelRunBoundApprovals
      ? (runId) => params.cancelRunBoundApprovals!(runId, context)
      : undefined,
    forwardPluginApprovalRequest: params.forwardPluginApprovalRequest,
    pluginApprovalIosPushDelivery: params.pluginApprovalIosPushDelivery,
    pluginApprovalManager: params.pluginApprovalManager,
    systemAgentApprovalManager: params.systemAgentApprovalManager,
    listSessionPendingApprovals: params.listSessionPendingApprovals,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
    loadGatewayModelCatalogSnapshot: params.loadGatewayModelCatalogSnapshot,
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
    isConnectionActive: (connId) =>
      [...params.clients].some((client) => client.connId === connId && !client.invalidated),
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
    disconnectClientsUsingSharedGatewayAuth: () => {
      disconnectAllSharedGatewayAuthClients(params.clients);
    },
    enforceSharedGatewayAuthGenerationForConfigWrite:
      params.enforceSharedGatewayAuthGenerationForConfigWrite,
    claimControlUiDeviceAuthMigration: params.claimControlUiDeviceAuthMigration,
    releaseControlUiDeviceAuthMigrationClaim: params.releaseControlUiDeviceAuthMigrationClaim,
    completeControlUiDeviceAuthMigration: params.completeControlUiDeviceAuthMigration,
    nodeRegistry: params.nodeRegistry,
    ...(params.workerEnvironmentService
      ? { workerEnvironmentService: params.workerEnvironmentService }
      : {}),
    ...(params.workerSessionPlacementService
      ? { workerSessionPlacementService: params.workerSessionPlacementService }
      : {}),
    ...(params.workerPlacementDispatchService
      ? { workerPlacementDispatchService: params.workerPlacementDispatchService }
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
    unsubscribeAllSessionEvents: params.unsubscribeAllSessionEvents,
    getSessionEventSubscriberConnIds: params.getSessionEventSubscriberConnIds,
    registerToolEventRecipient: params.registerToolEventRecipient,
    dedupe: params.dedupe,
    wizardSessions: params.wizardSessions,
    systemAgentSessions: params.systemAgentSessions,
    findRunningWizard: params.findRunningWizard,
    purgeWizardSession: params.purgeWizardSession,
    getRuntimeSnapshot: params.getRuntimeSnapshot,
    getEventLoopHealth: params.getEventLoopHealth,
    getConfigReloaderHotReloadStatus: () => params.runtimeState.configReloader.hotReloadStatus?.(),
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
