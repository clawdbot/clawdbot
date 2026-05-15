import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayRequestContext, GatewayClient } from "./server-methods/types.js";
import { disconnectAllSharedGatewayAuthClients } from "./server-shared-auth-generation.js";

type GatewayRequestContextClient = GatewayClient & {
  socket: { close: (code: number, reason: string) => void };
  usesSharedGatewayAuth?: boolean;
};

type GatewayRequestContextParams = {
  deps: GatewayRequestContext["deps"];
  runtimeState: Pick<GatewayServerLiveState, "cronState">;
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"];
  execApprovalManager: GatewayRequestContext["execApprovalManager"];
  pluginApprovalManager: GatewayRequestContext["pluginApprovalManager"];
  loadGatewayModelCatalog: GatewayRequestContext["loadGatewayModelCatalog"];
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
  enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => void;
  nodeRegistry: GatewayRequestContext["nodeRegistry"];
  agentRunSeq: GatewayRequestContext["agentRunSeq"];
  chatAbortControllers: GatewayRequestContext["chatAbortControllers"];
  chatAbortedRuns: GatewayRequestContext["chatAbortedRuns"];
  chatRunBuffers: GatewayRequestContext["chatRunBuffers"];
  chatDeltaSentAt: GatewayRequestContext["chatDeltaSentAt"];
  chatDeltaLastBroadcastLen: GatewayRequestContext["chatDeltaLastBroadcastLen"];
  chatDeltaLastBroadcastText: GatewayRequestContext["chatDeltaLastBroadcastText"];
  agentDeltaSentAt: GatewayRequestContext["agentDeltaSentAt"];
  bufferedAgentEvents: GatewayRequestContext["bufferedAgentEvents"];
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
    execApprovalManager: params.execApprovalManager,
    pluginApprovalManager: params.pluginApprovalManager,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
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
    disconnectClientsForDevice: (deviceId: string, opts?: { role?: string }) => {
      for (const gatewayClient of params.clients) {
        if (gatewayClient.connect.device?.id !== deviceId) {
          continue;
        }
        if (opts?.role && gatewayClient.connect.role !== opts.role) {
          continue;
        }
        try {
          gatewayClient.socket.close(4001, "device removed");
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
    agentRunSeq: params.agentRunSeq,
    chatAbortControllers: params.chatAbortControllers,
    chatAbortedRuns: params.chatAbortedRuns,
    chatRunBuffers: params.chatRunBuffers,
    chatDeltaSentAt: params.chatDeltaSentAt,
    chatDeltaLastBroadcastLen: params.chatDeltaLastBroadcastLen,
    chatDeltaLastBroadcastText: params.chatDeltaLastBroadcastText,
    agentDeltaSentAt: params.agentDeltaSentAt,
    bufferedAgentEvents: params.bufferedAgentEvents,
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
    findRunningWizard: params.findRunningWizard,
    purgeWizardSession: params.purgeWizardSession,
    getRuntimeSnapshot: params.getRuntimeSnapshot,
    getEventLoopHealth: params.getEventLoopHealth,
    startChannel: params.startChannel,
    stopChannel: params.stopChannel,
    markChannelLoggedOut: params.markChannelLoggedOut,
    wizardRunner: params.wizardRunner,
    broadcastVoiceWakeChanged: params.broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged: params.broadcastVoiceWakeRoutingChanged,
    unavailableGatewayMethods: params.unavailableGatewayMethods,
  };
}
