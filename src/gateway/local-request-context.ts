import { loadManifestModelCatalog } from "../agents/model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { NodeRegistry } from "./node-registry.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

type LocalGatewayRequestContextParams = {
  deps: CliDeps;
  getRuntimeConfig: () => OpenClawConfig;
};

type LocalGatewayScopeParams = LocalGatewayRequestContextParams;

function cronUnavailable(): never {
  throw new Error("Cron is unavailable in local embedded agent gateway context.");
}

const unavailableCron: CronServiceContract = {
  start: async () => {
    cronUnavailable();
  },
  stop: () => {},
  status: async () => cronUnavailable(),
  list: async () => cronUnavailable(),
  listPage: async () => cronUnavailable(),
  add: async () => cronUnavailable(),
  update: async () => cronUnavailable(),
  remove: async () => cronUnavailable(),
  run: async () => cronUnavailable(),
  enqueueRun: async () => cronUnavailable(),
  getJob: () => undefined,
  readJob: async () => undefined,
  getDefaultAgentId: () => undefined,
  wake: () => ({ ok: false, reason: "unwakeable-session-key" }),
};

export function createLocalGatewayRequestContext(
  params: LocalGatewayRequestContextParams,
): GatewayRequestContext {
  const logGateway = createSubsystemLogger("gateway/local");
  const sessionEvents = new Set<string>();
  const chatRuns = new Map<string, { sessionKey: string; clientRunId: string }>();
  return {
    deps: params.deps,
    cron: unavailableCron,
    cronStorePath: "",
    getRuntimeConfig: params.getRuntimeConfig,
    loadGatewayModelCatalog: async () =>
      loadManifestModelCatalog({ config: params.getRuntimeConfig() }),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () =>
      ({}) as Awaited<ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>>,
    logHealth: { error: (message) => logGateway.error(message) },
    logGateway,
    incrementPresenceVersion: () => 0,
    getHealthVersion: () => 0,
    broadcast: () => {},
    broadcastToConnIds: () => {},
    nodeSendToSession: () => {},
    nodeSendToAllSubscribed: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    nodeUnsubscribeAll: () => {},
    hasConnectedTalkNode: () => false,
    nodeRegistry: new NodeRegistry(),
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    addChatRun: (sessionId, entry) => {
      chatRuns.set(sessionId, entry);
    },
    removeChatRun: (sessionId, clientRunId, sessionKey) => {
      const entry = chatRuns.get(sessionId);
      if (!entry || entry.clientRunId !== clientRunId) {
        return undefined;
      }
      if (sessionKey !== undefined && entry.sessionKey !== sessionKey) {
        return undefined;
      }
      chatRuns.delete(sessionId);
      return entry;
    },
    subscribeSessionEvents: (connId) => {
      sessionEvents.add(connId);
    },
    unsubscribeSessionEvents: (connId) => {
      sessionEvents.delete(connId);
    },
    subscribeSessionMessageEvents: () => {},
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: (connId) => {
      sessionEvents.delete(connId);
    },
    getSessionEventSubscriberConnIds: () => sessionEvents,
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: () => {},
    getRuntimeSnapshot: () => ({}) as ChannelRuntimeSnapshot,
    startChannel: async () => {
      throw new Error("Channel start is unavailable in local embedded agent gateway context.");
    },
    stopChannel: async () => {
      throw new Error("Channel stop is unavailable in local embedded agent gateway context.");
    },
    markChannelLoggedOut: () => {},
    wizardRunner: async () => {
      throw new Error("Onboarding wizard is unavailable in local embedded agent gateway context.");
    },
    broadcastVoiceWakeChanged: () => {},
    broadcastVoiceWakeRoutingChanged: () => {},
    unavailableGatewayMethods: new Set(),
  };
}

export function withLocalGatewayRequestScope<T>(params: LocalGatewayScopeParams, run: () => T): T {
  const existing = getPluginRuntimeGatewayRequestScope();
  if (existing?.context) {
    return run();
  }
  const context = createLocalGatewayRequestContext(params);
  return withPluginRuntimeGatewayRequestScope(
    {
      ...existing,
      context,
      isWebchatConnect: existing?.isWebchatConnect ?? (() => false),
    },
    run,
  );
}
