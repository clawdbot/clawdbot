/**
 * Test runtime factory for subagent announce delivery. It wires gateway,
 * session-store, queue, and hook behavior to caller-provided mocks.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway } from "../gateway/call.js";
import type { dispatchGatewayMethodInProcess } from "../gateway/server-plugins.js";
import type { EmbeddedAgentQueueMessageOptions } from "./embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "./embedded-agent-runner/runs.js";

type DeliveryRuntimeMockOptions = {
  callGateway: (request: unknown) => Promise<unknown>;
  getRuntimeConfig: () => OpenClawConfig;
  loadSessionStore: (storePath: string) => unknown;
  resolveAgentIdFromSessionKey: (sessionKey: string) => string;
  resolveMainSessionKey: (cfg: unknown) => string;
  resolveStorePath: (store: unknown, options: unknown) => string;
  isEmbeddedAgentRunActive: (sessionId: string) => boolean;
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => EmbeddedAgentQueueMessageOutcome;
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
    mode:
      (params.channel && params.cfg?.messages?.queue?.byChannel?.[params.channel]) ?? "followup",
  };
}

/** Create a mocked announce delivery runtime for focused subagent tests. */
export function createSubagentAnnounceDeliveryRuntimeMock(options: DeliveryRuntimeMockOptions) {
  return {
    callGateway: (async <T = Record<string, unknown>>(request: Parameters<typeof callGateway>[0]) =>
      (await options.callGateway(request)) as T) as typeof callGateway,
    dispatchGatewayMethodInProcess: (async <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown>,
      callOptions?: { expectFinal?: boolean; timeoutMs?: number },
    ) =>
      (await options.callGateway({
        method,
        params,
        expectFinal: callOptions?.expectFinal,
        timeoutMs: callOptions?.timeoutMs,
      })) as T) as typeof dispatchGatewayMethodInProcess,
    getRuntimeConfig: options.getRuntimeConfig,
    loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
      (options.loadSessionStore(scope.storePath ?? "") as Record<string, unknown>)[
        scope.sessionKey
      ],
    loadSessionStore: options.loadSessionStore,
    resolveAgentIdFromSessionKey: options.resolveAgentIdFromSessionKey,
    resolveMainSessionKey: options.resolveMainSessionKey,
    resolveStorePath: options.resolveStorePath,
    isEmbeddedAgentRunActive: options.isEmbeddedAgentRunActive,
    queueEmbeddedAgentMessageWithOutcome: options.queueEmbeddedAgentMessageWithOutcome,
    formatEmbeddedAgentQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
      outcome.reason && outcome.sessionId
        ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
        : undefined,
    getGlobalHookRunner: () => ({ hasHooks: () => options.hasHooks?.() ?? false }),
    createBoundDeliveryRouter: () => ({
      resolveDestination: () => ({ mode: "none" }),
    }),
    resolveConversationIdFromTargets: () => "",
    resolveExternalBestEffortDeliveryTarget,
    resolveQueueSettings,
  };
}
