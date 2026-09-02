// Local embedded Gateway request context.
// Lets local agent paths reuse Gateway server methods without starting a server.
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withLocalAgentCronJobsRemoved } from "../cron/local-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { loadGatewayConfigRevisionProjector } from "./config-revision-token.js";
import { NodeRegistry } from "./node-registry.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import { createChatRunState } from "./server-chat-state.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import {
  loadGatewayModelCatalog,
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
  readPreparedGatewayModelCatalog,
  readPreparedGatewayModelCatalogOwnerSnapshot,
} from "./server-model-catalog.js";

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
  removeStaleJobFamily: async () => cronUnavailable(),
  removeAgentJobsTransactional: async () => cronUnavailable(),
  run: async () => cronUnavailable(),
  enqueueRun: async () => cronUnavailable(),
  getJob: () => undefined,
  readJob: async () => undefined,
  readScratch: async (): Promise<never> => cronUnavailable(),
  writeScratch: async () => cronUnavailable(),
  getDefaultAgentId: () => undefined,
  wake: () => ({ ok: false, reason: "unwakeable-session-key" }),
};

/** Creates the minimal gateway context used by embedded local agent execution. */
function createLocalGatewayRequestContext(
  params: LocalGatewayRequestContextParams,
): GatewayRequestContext {
  const logGateway = createSubsystemLogger("gateway/local");
  const cron: GatewayCronServiceContract = {
    ...unavailableCron,
    removeAgentJobsTransactional: async (agentId, commit) =>
      await withLocalAgentCronJobsRemoved(agentId, params.getRuntimeConfig, commit),
  };
  const sessionEvents = new Set<string>();
  const chatRunState = createChatRunState();
  const loadCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] = (
    loadParams,
  ) => loadGatewayModelCatalogSnapshot({ ...loadParams, getConfig: params.getRuntimeConfig });
  registerGatewayModelCatalogPrivateAccess(loadCatalogSnapshot, {
    loadDeferred: (loadParams) =>
      loadPreparedGatewayModelCatalogSnapshot({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
    readPrepared: (loadParams) =>
      readPreparedGatewayModelCatalogOwnerSnapshot({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
  });
  const context: GatewayRequestContext = {
    localEmbedded: true,
    deps: params.deps,
    configRevisionProjector: loadGatewayConfigRevisionProjector({ env: process.env }),
    cron,
    cronStorePath: "",
    getRuntimeConfig: params.getRuntimeConfig,
    // Embedded calls have no running Gateway application owner.
    isConfigReloadSettled: () => false,
    notifyPluginMetadataChanged: () => {},
    resolveTerminalLaunchPolicy: () => ({ ok: false, block: { kind: "disabled" } }),
    isTerminalEnabled: () => false,
    loadGatewayModelCatalog: (loadParams) =>
      loadGatewayModelCatalog({
        ...loadParams,
        getConfig: params.getRuntimeConfig,
      }),
    loadGatewayModelCatalogSnapshot: loadCatalogSnapshot,
    readPreparedGatewayModelCatalog: (loadParams) =>
      readPreparedGatewayModelCatalog({ ...loadParams, getConfig: params.getRuntimeConfig }),
    readChatMetadata: async () => {
      throw new Error("Chat metadata is unavailable in local embedded agent gateway context.");
    },
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
    hasConnectedTalkNode: async () => false,
    nodeRegistry: new NodeRegistry(),
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState,
    addChatRun: chatRunState.registry.add,
    removeChatRun: chatRunState.registry.remove,
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
    systemAgentSessions: new Map(),
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
    channelWizardRunner: async () => {
      throw new Error(
        "Channel setup wizard is unavailable in local embedded agent gateway context.",
      );
    },
    broadcastVoiceWakeChanged: () => {},
    broadcastVoiceWakeRoutingChanged: () => {},
    unavailableGatewayMethods: new Set(),
  };
  context.createAgentTurnFacade = async (principal) => {
    const { createInternalAgentTurnFacade } =
      await import("./agent-turn/internal-facade.runtime.js");
    return createInternalAgentTurnFacade({ ...principal, getContext: () => context });
  };
  return context;
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
