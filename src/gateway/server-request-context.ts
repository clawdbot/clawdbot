// Gateway request context factory.
// Wires live runtime state into method handlers and client management helpers.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayRequestContext, GatewayClient } from "./server-methods/types.js";
import { disconnectAllSharedGatewayAuthClients } from "./server-shared-auth-generation.js";

type GatewayRequestContextClient = GatewayClient & {
  socket: { close: (code: number, reason: string) => void };
  usesSharedGatewayAuth?: boolean;
  invalidated?: boolean;
  invalidatedReason?: string;
};

export type GatewayRequestContextParams = {
  deps: GatewayRequestContext["deps"];
  runtimeState: Pick<GatewayServerLiveState, "cronState" | "configReloader">;
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  getMcpAppSandboxPort?: GatewayRequestContext["getMcpAppSandboxPort"];
  resolveTerminalLaunchPolicy: GatewayRequestContext["resolveTerminalLaunchPolicy"];
  isTerminalEnabled: GatewayRequestContext["isTerminalEnabled"];
  execApprovalManager: GatewayRequestContext["execApprovalManager"];
  forwardPluginApprovalRequest?: GatewayRequestContext["forwardPluginApprovalRequest"];
  pluginApprovalManager: GatewayRequestContext["pluginApprovalManager"];
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
  nodeRegistry: GatewayRequestContext["nodeRegistry"];
  workerEnvironmentService?: GatewayRequestContext["workerEnvironmentService"];
  terminalSessions?: GatewayRequestContext["terminalSessions"];
  agentRunSeq: GatewayRequestContext["agentRunSeq"];
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"];
  chatQueuedTurns: GatewayRequestContext["chatQueuedTurns"];
  chatAbortedRuns: GatewayRequestContext["chatAbortedRuns"];
  chatRunBuffers: GatewayRequestContext["chatRunBuffers"];
  chatDeltaSentAt: GatewayRequestContext["chatDeltaSentAt"];
  chatDeltaLastBroadcastLen: GatewayRequestContext["chatDeltaLastBroadcastLen"];
  chatDeltaLastBroadcastText: GatewayRequestContext["chatDeltaLastBroadcastText"];
  agentDeltaSentAt: GatewayRequestContext["agentDeltaSentAt"];
  bufferedAgentEvents: GatewayRequestContext["bufferedAgentEvents"];
  clearChatRunState: GatewayRequestContext["clearChatRunState"];
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
  crestodianSessions: GatewayRequestContext["crestodianSessions"];
  findRunningWizard: GatewayRequestContext["findRunningWizard"];
  purgeWizardSession: GatewayRequestContext["purgeWizardSession"];
  getRuntimeSnapshot: GatewayRequestContext["getRuntimeSnapshot"];
  getEventLoopHealth?: GatewayRequestContext["getEventLoopHealth"];
  startChannel: GatewayRequestContext["startChannel"];
  stopChannel: GatewayRequestContext["stopChannel"];
  markChannelLoggedOut: GatewayRequestContext["markChannelLoggedOut"];
  wizardRunner: GatewayRequestContext["wizardRunner"];
  broadcastVoiceWakeChanged: GatewayRequestContext["broadcastVoiceWakeChanged"];
  broadcastVoiceWakeRoutingChanged: GatewayRequestContext["broadcastVoiceWakeRoutingChanged"];
  unavailableGatewayMethods: ReadonlySet<string>;
};

export function createGatewayRequestContext(
  params: GatewayRequestContextParams,
): GatewayRequestContext {
  const hasApprovalScope = (gatewayClient: GatewayClient): boolean => {
    const scopes = Array.isArray(gatewayClient.connect.scopes) ? gatewayClient.connect.scopes : [];
    return scopes.includes("operator.admin") || scopes.includes("operator.approvals");
  };

  return {
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
    getMcpAppSandboxPort: params.getMcpAppSandboxPort,
    resolveTerminalLaunchPolicy: params.resolveTerminalLaunchPolicy,
    isTerminalEnabled: params.isTerminalEnabled,
    execApprovalManager: params.execApprovalManager,
    forwardPluginApprovalRequest: params.forwardPluginApprovalRequest,
    pluginApprovalManager: params.pluginApprovalManager,
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
    hasExecApprovalClients: (excludeConnId?: string) => {
      for (const gatewayClient of params.clients) {
        if (excludeConnId && gatewayClient.connId === excludeConnId) {
          continue;
        }
        if (hasApprovalScope(gatewayClient)) {
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
        if (!hasApprovalScope(gatewayClient)) {
          continue;
        }
        if (opts.filter && !opts.filter(gatewayClient, opts.record)) {
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
        // Marking is separate from socket close so already-buffered requests
        // fail authorization even if transport teardown has not completed.
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
    nodeRegistry: params.nodeRegistry,
    ...(params.workerEnvironmentService
      ? { workerEnvironmentService: params.workerEnvironmentService }
      : {}),
    terminalSessions: params.terminalSessions,
    agentRunSeq: params.agentRunSeq,
    chatAbortControllers: params.chatAbortControllers,
    chatQueuedTurns: params.chatQueuedTurns,
    chatAbortedRuns: params.chatAbortedRuns,
    chatRunBuffers: params.chatRunBuffers,
    chatDeltaSentAt: params.chatDeltaSentAt,
    chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
    chatDeltaLastBroadcastText: params.chatDeltaLastBroadcastText,
    agentDeltaSentAt: params.agentDeltaSentAt,
    bufferedAgentEvents: params.bufferedAgentEvents,
    clearChatRunState: params.clearChatRunState,
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
    crestodianSessions: params.crestodianSessions,
    findRunningWizard: params.findRunningWizard,
    purgeWizardSession: params.purgeWizardSession,
    getRuntimeSnapshot: params.getRuntimeSnapshot,
    getEventLoopHealth: params.getEventLoopHealth,
    getConfigReloaderHotReloadStatus: () => params.runtimeState.configReloader.hotReloadStatus?.(),
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    markChannelLoggedOut: params.markChannelLoggedOut,
    wizardRunner: params.wizardRunner,
    broadcastVoiceWakeChanged: params.broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged: params.broadcastVoiceWakeRoutingChanged,
    unavailableGatewayMethods: params.unavailableGatewayMethods,
  };
}
