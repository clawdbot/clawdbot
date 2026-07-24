import { isAgentDeletionBlocked } from "../agents/agent-lifecycle-registry.js";
import { listAgentIds, resolveDefaultAgentId } from "../agents/agent-scope.js";
// Local embedded Gateway request context.
// Lets local agent paths reuse Gateway server methods without starting a server.
import { loadPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { resolveCronJobsStorePath } from "../cron/store.js";
import { getChildLogger } from "../logging/logger.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { NodeRegistry } from "./node-registry.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
import { createChatRunState } from "./server-chat-state.js";
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
    removeAgentJobsTransactional: async (agentId, commit) => {
      const cfg = params.getRuntimeConfig();
      const storePath = resolveCronJobsStorePath();
      const service = new CronService({
        storePath,
        cronEnabled: cfg.cron?.enabled !== false,
        cronConfig: cfg.cron,
        log: getChildLogger({ module: "cron", storePath }),
        defaultAgentId: resolveDefaultAgentId(cfg),
        resolveDefaultAgentId: () => resolveDefaultAgentId(params.getRuntimeConfig()),
        isAgentAvailable: (id) =>
          !isAgentDeletionBlocked(id) &&
          listAgentIds(params.getRuntimeConfig()).some(
            (configuredId) => normalizeAgentId(configuredId) === id,
          ),
        enqueueSystemEvent: () => false,
        requestHeartbeat: () => {},
        runIsolatedAgentJob: async () => {
          throw new Error("Cron execution is unavailable in local embedded agent gateway context.");
        },
      });
      try {
        return await service.removeAgentJobsTransactional(agentId, commit);
      } finally {
        service.stop();
      }
    },
  };
  const sessionEvents = new Set<string>();
  const chatRunState = createChatRunState();
  const loadModelCatalogOwner = async ({
    agentId,
    agentDir,
    readOnly,
    workspaceDir,
  }: NonNullable<Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0]> = {}) =>
    loadPublishedPreparedModelCatalogOwnerSnapshot({
      ...(agentId ? { agentId } : {}),
      ...(agentDir ? { agentDir } : {}),
      config: params.getRuntimeConfig(),
      readOnly: readOnly !== false,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
  return {
    deps: params.deps,
    cron,
    cronStorePath: "",
    getRuntimeConfig: params.getRuntimeConfig,
    notifyPluginMetadataChanged: () => {},
    resolveTerminalLaunchPolicy: () => ({ ok: false, block: { kind: "disabled" } }),
    isTerminalEnabled: () => false,
    loadGatewayModelCatalog: async (loadParams) =>
      (await loadModelCatalogOwner(loadParams)).modelCatalog.entries,
    loadGatewayModelCatalogSnapshot: async (loadParams) => {
      const owner = await loadModelCatalogOwner(loadParams);
      return {
        ...owner.modelCatalog,
        ...(owner.agentId ? { agentId: owner.agentId } : {}),
        agentDir: owner.agentDir,
        ...(owner.workspaceDir ? { workspaceDir: owner.workspaceDir } : {}),
        config: owner.config,
      };
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
