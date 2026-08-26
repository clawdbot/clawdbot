/**
 * Runtime dependency owner for subagent announcement delivery.
 *
 * Tests override this module's delivery capabilities while origin routing keeps
 * using the direct runtime exports below.
 */
import { resolveQueueSettings } from "../../../auto-reply/reply/queue.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { loadSessionEntryReadOnly as loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { callGateway } from "../../../gateway/call.js";
import { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
import { createBoundDeliveryRouter } from "../../../infra/outbound/bound-delivery-router.js";
import { resolveConversationIdFromTargets } from "../../../infra/outbound/conversation-id.js";
import { sendMessage } from "../../../infra/outbound/message.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../../routing/session-key.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  formatEmbeddedAgentQueueFailureSummary,
  isEmbeddedAgentRunActive,
  isEmbeddedRunAbandoned,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
  type EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import { dispatchGatewayMethodInProcess } from "./subagent-announce.runtime.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

export {
  createBoundDeliveryRouter,
  formatEmbeddedAgentQueueFailureSummary,
  getGlobalHookRunner,
  isEmbeddedAgentRunActive,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
};

export type SubagentAnnounceDeliveryDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (
    requesterSessionKey: string,
    requesterAgentId?: string,
  ) => {
    sessionId?: string;
    isActive: boolean;
  };
  isRequesterSessionAbandoned: (requesterSessionKey: string, sessionId?: string) => boolean;
  loadSessionEntry: typeof loadSessionEntry;
  loadRequesterSessionEntry: typeof loadRequesterSessionEntry;
  queueEmbeddedAgentMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedAgentQueueMessageOptions,
  ) => EmbeddedAgentQueueMessageOutcome | Promise<EmbeddedAgentQueueMessageOutcome>;
  sendMessage: typeof sendMessage;
};

type RequesterSessionEntryResult = {
  cfg: ReturnType<typeof getRuntimeConfig>;
  entry: ReturnType<typeof loadSessionEntry>;
  canonicalKey: string;
};

export function tryResolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string | undefined {
  const requestedAgentId = explicitAgentId?.trim() ? normalizeAgentId(explicitAgentId) : undefined;
  const parsedAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (requestedAgentId && parsedAgentId && requestedAgentId !== parsedAgentId) {
    return undefined;
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, requesterSessionKey);
  if (persistedStoreOwner.kind === "retired") {
    return undefined;
  }
  if (
    requestedAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedAgentId !== persistedStoreOwner.agentId
  ) {
    return undefined;
  }
  const resolvedAgentId = requestedAgentId ?? parsedAgentId;
  if (resolvedAgentId) {
    return resolvedAgentId;
  }
  return (
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg)
  );
}

function loadDefaultRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): RequesterSessionEntryResult {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const rawStorageKey = requesterSessionKey.trim();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey, explicitAgentId);
  const configuredMainKey = normalizeMainKey(cfg.session?.mainKey);
  const storageKey =
    rawStorageKey === "main" || rawStorageKey === configuredMainKey ? canonicalKey : rawStorageKey;
  const agentId = tryResolveSubagentRequesterAgentId(cfg, rawStorageKey, explicitAgentId);
  if (!agentId) {
    return { cfg, entry: undefined, canonicalKey };
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  const entry = subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath,
    sessionKey: storageKey,
    agentId,
    clone: false,
  });
  return { cfg, entry, canonicalKey };
}

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway: ((...args) => callGateway(...args)) as typeof callGateway,
  dispatchGatewayMethodInProcess: ((...args) =>
    dispatchGatewayMethodInProcess(...args)) as typeof dispatchGatewayMethodInProcess,
  getRuntimeConfig: () => getRuntimeConfig(),
  getRequesterSessionActivity: (requesterSessionKey: string, requesterAgentId?: string) => {
    const cfg = getRuntimeConfig();
    const resolvedAgentId = tryResolveSubagentRequesterAgentId(
      cfg,
      requesterSessionKey,
      requesterAgentId,
    );
    if (!resolvedAgentId) {
      return { isActive: false };
    }
    const storedSessionId = loadRequesterSessionEntry(requesterSessionKey, resolvedAgentId).entry
      ?.sessionId;
    // Unscoped active-run keys are ambiguous across agents. An explicit owner
    // must use its logical store entry instead of accepting another agent's run.
    const activeSessionId = parseAgentSessionKey(requesterSessionKey)
      ? resolveActiveEmbeddedRunSessionId(requesterSessionKey)
      : undefined;
    const sessionId = activeSessionId ?? storedSessionId;
    return {
      sessionId,
      isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
    };
  },
  isRequesterSessionAbandoned: (requesterSessionKey, sessionId) =>
    isEmbeddedRunAbandoned({ sessionKey: requesterSessionKey, sessionId }),
  loadSessionEntry: (...args) => loadSessionEntry(...args),
  loadRequesterSessionEntry: loadDefaultRequesterSessionEntry,
  queueEmbeddedAgentMessageWithOutcome: (...args) =>
    queueEmbeddedAgentMessageWithOutcomeAsync(...args),
  sendMessage: (...args) => sendMessage(...args),
};

let subagentAnnounceDeliveryDeps = defaultSubagentAnnounceDeliveryDeps;

export function setSubagentAnnounceDeliveryDepsForTest(
  overrides?: Partial<SubagentAnnounceDeliveryDeps>,
): void {
  const callGatewayOverride = overrides?.callGateway;
  const dispatchGatewayMethodInProcessOverride =
    overrides?.dispatchGatewayMethodInProcess ??
    (callGatewayOverride
      ? ((async (method, agentParams, options) =>
          await callGatewayOverride({
            method,
            params: agentParams,
            expectFinal: options?.expectFinal,
            onAccepted: options?.onAccepted,
            timeoutMs: options?.timeoutMs,
          })) satisfies typeof dispatchGatewayMethodInProcess)
      : undefined);
  subagentAnnounceDeliveryDeps = overrides
    ? {
        ...defaultSubagentAnnounceDeliveryDeps,
        ...overrides,
        ...(dispatchGatewayMethodInProcessOverride
          ? { dispatchGatewayMethodInProcess: dispatchGatewayMethodInProcessOverride }
          : {}),
      }
    : defaultSubagentAnnounceDeliveryDeps;
}

export function getSubagentAnnounceRuntimeConfig() {
  return subagentAnnounceDeliveryDeps.getRuntimeConfig();
}

export function getSubagentRequesterSessionActivity(
  requesterSessionKey: string,
  requesterAgentId?: string,
) {
  return subagentAnnounceDeliveryDeps.getRequesterSessionActivity(
    requesterSessionKey,
    requesterAgentId,
  );
}

export function isSubagentRequesterSessionAbandoned(
  requesterSessionKey: string,
  sessionId?: string,
) {
  return subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(requesterSessionKey, sessionId);
}

export function loadRequesterSessionEntry(
  requesterSessionKey: string,
  explicitAgentId?: string,
): RequesterSessionEntryResult {
  return subagentAnnounceDeliveryDeps.loadRequesterSessionEntry(
    requesterSessionKey,
    explicitAgentId,
  );
}

export function loadSessionEntryByKey(sessionKey: string, explicitAgentId?: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const agentId = tryResolveSubagentRequesterAgentId(cfg, sessionKey, explicitAgentId);
  if (!agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath,
    sessionKey,
    agentId,
    clone: false,
  });
}

export async function queueSubagentAnnounceMessage(
  sessionId: string,
  text: string,
  options?: EmbeddedAgentQueueMessageOptions,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  return await subagentAnnounceDeliveryDeps.queueEmbeddedAgentMessageWithOutcome(
    sessionId,
    text,
    options,
  );
}

export async function dispatchSubagentAnnounceAgent(
  agentParams: Record<string, unknown>,
  options: Parameters<typeof dispatchGatewayMethodInProcess>[2],
): Promise<unknown> {
  return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess(
    "agent",
    agentParams,
    options,
  );
}

export async function sendSubagentAnnounceMessage(
  params: Parameters<typeof sendMessage>[0],
): ReturnType<typeof sendMessage> {
  return await subagentAnnounceDeliveryDeps.sendMessage(params);
}
