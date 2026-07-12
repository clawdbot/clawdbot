// Local embedded Gateway request context.
// Lets local agent paths reuse Gateway server methods without starting a server.
import { loadManifestModelCatalog, loadModelCatalogSnapshot } from "../agents/model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { NodeRegistry } from "./node-registry.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import { createChatRunEntry, type ChatRunEntry } from "./server-chat-state.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

// Embedded/local agent calls need enough GatewayRequestContext to reuse server
// methods without starting the full gateway. Unsupported subsystems fail loudly
// so local command paths do not silently enqueue cron/channel work.
type LocalGatewayRequestContextParams = {
  deps: CliDeps;
  getRuntimeConfig: () => OpenClawConfig;
};

function cronUnavailable(): never {
  throw new Error("Cron is unavailable in local embedded agent gateway context.");
}

const unavailableCron: GatewayCronServiceContract = {
  start: async () => {
    cronUnavailable();
  },
  stop: () => {},
  pauseScheduling: () => {},
  resumeScheduling: () => {},
  status: async () => cronUnavailable(),
  list: async () => cronUnavailable(),
  listPage: async () => cronUnavailable(),
  add: async () => cronUnavailable(),
  update: async () => cronUnavailable(),
  updateWithPrecondition: async () => cronUnavailable(),
  remove: async () => cronUnavailable(),
  run: async () => cronUnavailable(),
  enqueueRun: async () => cronUnavailable(),
  getJob: () => undefined,
  readJob: async () => undefined,
  getDefaultAgentId: () => undefined,
  wake: () => ({ ok: false, reason: "unwakeable-session-key" }),
};

/** Creates the minimal gateway context used by embedded local agent execution. */
function createLocalGatewayRequestContext(
  params: LocalGatewayRequestContextParams,
): GatewayRequestContext {
  const logGateway = createSubsystemLogger("gateway/local");
  const sessionEvents = new Set<string>();
  const chatRuns = new Map<string, ChatRunEntry>();
  const chatRunBuffers: GatewayRequestContext["chatRunBuffers"] = new Map();
  const chatDeltaSentAt: GatewayRequestContext["chatDeltaSentAt"] = new Map();
  const chatDeltaLastBroadcastLen: GatewayRequestContext["chatDeltaLastBroadcastLen"] = new Map();
  const chatDeltaLastBroadcastText: GatewayRequestContext["chatDeltaLastBroadcastText"] = new Map();
  const agentDeltaSentAt: GatewayRequestContext["agentDeltaSentAt"] = new Map();
  const bufferedAgentEvents: GatewayRequestContext["bufferedAgentEvents"] = new Map();
  // Clear every per-run buffer variant together; streamed assistant/thinking
  // deltas share the client run id prefix but are tracked under separate keys.
  const clearChatRunState = (runId: string) => {
    chatRunBuffers.delete(runId);
    chatDeltaSentAt.delete(runId);
    chatDeltaLastBroadcastLen.delete(runId);
    chatDeltaLastBroadcastText.delete(runId);
    for (const key of [runId, `${runId}:assistant`, `${runId}:thinking`]) {
      agentDeltaSentAt.delete(key);
      bufferedAgentEvents.delete(key);
    }
  };
  return {
    deps: params.deps,
    cron: unavailableCron,
    cronStorePath: "",
    getRuntimeConfig: params.getRuntimeConfig,
    resolveTerminalLaunchPolicy: () => ({ ok: false, block: { kind: "disabled" } }),
    isTerminalEnabled: () => false,
    loadGatewayModelCatalog: async () =>
      loadManifestModelCatalog({ config: params.getRuntimeConfig() }),
    loadGatewayModelCatalogSnapshot: async ({ readOnly } = {}) =>
      loadModelCatalogSnapshot({ config: params.getRuntimeConfig(), readOnly }),
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
    chatQueuedTurns: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
    chatDeltaLastBroadcastText,
    agentDeltaSentAt,
    bufferedAgentEvents,
    clearChatRunState,
    addChatRun: (sessionId, entry) => {
      chatRuns.set(sessionId, createChatRunEntry(entry));
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
    subscribeSessionMessageEvents: () => undefined,
    unsubscribeSessionMessageEvents: () => {},
    unsubscribeAllSessionEvents: (connId) => {
      sessionEvents.delete(connId);
    },
    getSessionEventSubscriberConnIds: () => sessionEvents,
    registerToolEventRecipient: () => {},
    dedupe: new Map(),
    wizardSessions: new Map(),
    crestodianSessions: new Map(),
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

/** Runs code inside a local gateway request scope unless an outer scope already exists. */
export function withLocalGatewayRequestScope<T>(
  params: LocalGatewayRequestContextParams,
  run: () => T,
): T {
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
