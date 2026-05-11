import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway } from "../gateway/call.js";
import type { EmbeddedPiQueueMessageOptions } from "./pi-embedded-runner/run-state.js";
import type { EmbeddedPiQueueMessageOutcome } from "./pi-embedded-runner/runs.js";

type DeliveryRuntimeMockOptions = {
  callGateway: (request: unknown) => Promise<unknown>;
  getRuntimeConfig: () => OpenClawConfig;
  loadSessionStore: (storePath: string) => unknown;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
  resolveMainSessionKey: (cfg: unknown) => string;
  resolveStorePath: (store: unknown, options: unknown) => string;
  isEmbeddedPiRunActive: (sessionId: string) => boolean;
  queueEmbeddedPiMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedPiQueueMessageOptions,
  ) => EmbeddedPiQueueMessageOutcome;
  hasHooks?: () => boolean;
};

function resolveExternalBestEffortDeliveryTarget(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
}) {
  return {
    deliver: Boolean(params.channel && params.to),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  };
}

function resolveQueueSettings(params: {
  cfg?: {
    messages?: {
      queue?: {
        byChannel?: Record<string, string>;
      };
    };
  };
  channel?: string;
}) {
  return {
    mode: (params.channel && params.cfg?.messages?.queue?.byChannel?.[params.channel]) ?? "none",
  };
}

export function createSubagentAnnounceDeliveryRuntimeMock(options: DeliveryRuntimeMockOptions) {
  return {
    callGateway: (async <T = Record<string, unknown>>(request: Parameters<typeof callGateway>[0]) =>
      (await options.callGateway(request)) as T) as typeof callGateway,
    getRuntimeConfig: options.getRuntimeConfig,
    loadSessionStore: options.loadSessionStore,
    resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
    resolveMainSessionKey: options.resolveMainSessionKey,
    resolveStorePath: options.resolveStorePath,
    isEmbeddedPiRunActive: options.isEmbeddedPiRunActive,
    queueEmbeddedPiMessageWithOutcome: options.queueEmbeddedPiMessageWithOutcome,
    formatEmbeddedPiQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
      outcome.reason && outcome.sessionId
        ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
        : undefined,
    isSteeringQueueMode: (mode: string) =>
      mode === "steer" || mode === "queue" || mode === "steer-backlog",
    resolvePiSteeringModeForQueueMode: (mode: string) =>
      mode === "queue" ? "one-at-a-time" : "all",
    getGlobalHookRunner: () => ({ hasHooks: () => options.hasHooks?.() ?? false }),
    createBoundDeliveryRouter: () => ({
      resolveDestination: () => ({ mode: "none" }),
    }),
    resolveConversationIdFromTargets: () => "",
    resolveExternalBestEffortDeliveryTarget,
    resolveQueueSettings,
  };
}
