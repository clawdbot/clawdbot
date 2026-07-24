/**
 * Subagent completion announcement delivery.
 *
 * Routes completion payloads through gateway/channel/session paths and records delivery evidence.
 */
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { completionRequiresMessageToolDelivery } from "../auto-reply/reply/completion-delivery-policy.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { routeFromConversationRef, routeToDeliveryFields } from "../channels/route-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { isOutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue.js";
import { normalizeMediaReferenceForComparison } from "../media/media-reference-comparison.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  isAgentMediatedCompletionSourceTool,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import {
  isCronRunSessionKey,
  isCronSessionKey,
  parseCronRunScopeSuffix,
} from "../sessions/session-key-utils.js";
import { isNonTerminalAgentRunStatus } from "../shared/agent-run-status.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  sessionDeliveryChannel,
} from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { hasAcceptedSessionSpawn } from "./accepted-session-spawn.js";
import {
  collectDeliveredMediaUrls,
  collectMessagingToolDeliveredMediaUrls,
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasMessagingToolDeliveryEvidence,
  hasVisibleAgentPayload,
} from "./embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentQueueMessageOptions } from "./embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "./embedded-agent-runner/runs.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import { wakeSessionForGeneratedMediaDirectDelivery } from "./generated-media-direct-delivery-wake.js";
import { hasGeneratedMediaCompletionEvent } from "./internal-event-contract.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import { isSessionWriteLockAcquireError } from "./session-write-lock-error.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  dispatchGatewayMethodInProcess,
  getGlobalHookRunner,
  isEmbeddedAgentRunActive,
  isEmbeddedRunAbandoned,
  getRuntimeConfig,
  formatEmbeddedAgentQueueFailureSummary,
  loadSessionEntry,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
  resolveAgentIdFromSessionKey,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
  sendMessage,
} from "./subagent-announce-delivery.runtime.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import type { DeliveryContext } from "./subagent-announce-origin.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
type SubagentAnnounceDeliveryDeps = {
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
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

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  dispatchGatewayMethodInProcess,
  getRuntimeConfig,
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    const sessionId =
      resolveActiveEmbeddedRunSessionId(requesterSessionKey) ??
      loadRequesterSessionEntry(requesterSessionKey).entry?.sessionId;
    return {
      sessionId,
      isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
    };
  },
  isRequesterSessionAbandoned: (requesterSessionKey, sessionId) =>
    isEmbeddedRunAbandoned({ sessionKey: requesterSessionKey, sessionId }),
  loadSessionEntry,
  loadRequesterSessionEntry,
  queueEmbeddedAgentMessageWithOutcome: queueEmbeddedAgentMessageWithOutcomeAsync,
  sendMessage,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

async function resolveQueueEmbeddedAgentMessageOutcome(
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

async function runAnnounceAgentCall(params: {
  agentParams: Record<string, unknown>;
  cronRunContinuation?: boolean;
  expectFinal?: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  let accepted = false;
  const inputProvenance = normalizeInputProvenance(params.agentParams.inputProvenance);
  try {
    return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess(
      "agent",
      params.agentParams,
      {
        allowSyntheticCronRunContinuation: params.cronRunContinuation,
        expectFinal: params.expectFinal,
        forceSyntheticClient:
          params.cronRunContinuation === true ||
          shouldPreserveUserFacingSessionStateForInputProvenance(
            params.agentParams.inputProvenance,
          ),
        delegatedToolPolicyHandoff:
          inputProvenance?.kind === "inter_session" &&
          inputProvenance.sourceTool === "subagent_announce" &&
          Boolean(inputProvenance.sourceSessionKey),
        onAccepted: () => {
          accepted = true;
        },
        timeoutMs: params.timeoutMs,
      },
    );
  } catch (error) {
    if (accepted) {
      throw error;
    }
    const wrapped = new Error(summarizeDeliveryError(error), { cause: error });
    Object.assign(wrapped, { announcePreDispatch: true });
    throw wrapped;
  }
}

function formatQueueWakeFailureError(
  fallback: string,
  outcome: EmbeddedAgentQueueMessageOutcome,
): string {
  const summary = formatEmbeddedAgentQueueFailureSummary(outcome);
  return summary ? `${fallback}: ${summary}` : fallback;
}

function resolveBoundConversationOrigin(params: {
  bindingConversation: ConversationRef & { parentConversationId?: string };
  requesterConversation?: ConversationRef;
  requesterOrigin?: DeliveryContext;
}): DeliveryContext {
  const conversation = params.bindingConversation;
  const conversationId = conversation.conversationId?.trim() ?? "";
  const parentConversationId = conversation.parentConversationId?.trim() ?? "";
  const requesterConversationId = params.requesterConversation?.conversationId?.trim() ?? "";
  const requesterTo = params.requesterOrigin?.to?.trim();
  const boundTarget = routeToDeliveryFields(routeFromConversationRef(conversation));
  const inferredThreadId =
    boundTarget.threadId ??
    (parentConversationId && parentConversationId !== conversationId
      ? conversationId
      : undefined) ??
    (params.requesterOrigin?.threadId != null && params.requesterOrigin.threadId !== ""
      ? stringifyRouteThreadId(params.requesterOrigin.threadId)
      : undefined);
  if (
    requesterTo &&
    conversationId &&
    requesterConversationId &&
    conversationId.toLowerCase() === requesterConversationId.toLowerCase()
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      threadId: inferredThreadId,
    };
  }
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    to: boundTarget.to,
    threadId: inferredThreadId,
  };
}

function resolveRequesterSessionActivity(requesterSessionKey: string) {
  const activity = subagentAnnounceDeliveryDeps.getRequesterSessionActivity(requesterSessionKey);
  if (activity.sessionId || activity.isActive) {
    return activity;
  }
  const { entry } = loadRequesterSessionEntry(requesterSessionKey);
  const sessionId = entry?.sessionId;
  return {
    sessionId,
    isActive: Boolean(sessionId && isEmbeddedAgentRunActive(sessionId)),
  };
}

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return isFastTestRuntimeEnv() ? ([8, 16, 32] as const) : ([5_000, 10_000, 20_000] as const);
}

// Backoff schedule for re-attempting an active-requester steer while the run is
// compacting. Compaction is transient and usually finishes quickly, so a denser
// schedule is used than for transient delivery errors. Total wait stays well
// within the announce delivery timeout, and the loop also stops on cancellation.
function resolveCompactionSteerRetryDelaysMs() {
  return isFastTestRuntimeEnv()
    ? ([8, 16, 32, 64] as const)
    : ([1_000, 2_000, 4_000, 8_000] as const);
}

// Wake an active requester run through transient compacting and transcript-wait
// outcomes. Both active-wake call sites use one loop so delivery deadlines and
// best-effort transcript retry stay consistent.
async function resolveActiveWakeWithRetries(
  sessionId: string,
  message: string,
  wakeOptions: EmbeddedAgentQueueMessageOptions,
  signal?: AbortSignal,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  // Bound the whole active wake by the caller's delivery window. Each retry
  // passes only the remaining window into transcript-commit waiting so a
  // near-deadline retry cannot add another full timeout.
  const compactionDeadlineMs =
    typeof wakeOptions.deliveryTimeoutMs === "number" && wakeOptions.deliveryTimeoutMs > 0
      ? Date.now() + wakeOptions.deliveryTimeoutMs
      : undefined;
  let currentOptions = wakeOptions;
  const resolveRetryOptions = (): EmbeddedAgentQueueMessageOptions | undefined => {
    if (compactionDeadlineMs === undefined) {
      return currentOptions;
    }
    const remainingDeliveryTimeoutMs = compactionDeadlineMs - Date.now();
    if (remainingDeliveryTimeoutMs <= 0) {
      return undefined;
    }
    return {
      ...currentOptions,
      deliveryTimeoutMs: remainingDeliveryTimeoutMs,
    };
  };
  let outcome = await resolveQueueEmbeddedAgentMessageOutcome(sessionId, message, currentOptions);
  const compactionRetryDelaysMs = resolveCompactionSteerRetryDelaysMs();
  let compactionRetryIndex = 0;
  for (;;) {
    if (outcome.queued || signal?.aborted) {
      break;
    }
    if (
      outcome.reason === "transcript_commit_wait_unsupported" &&
      currentOptions.waitForTranscriptCommit === true
    ) {
      const bestEffortOptions = { ...currentOptions };
      delete bestEffortOptions.waitForTranscriptCommit;
      currentOptions = bestEffortOptions;
      outcome = await resolveQueueEmbeddedAgentMessageOutcome(sessionId, message, currentOptions);
      continue;
    }
    if (
      outcome.reason === "source_reply_delivery_mode_mismatch" &&
      currentOptions.sourceReplyDeliveryMode !== undefined
    ) {
      // Active requester runs own their final delivery mode. Direct-completion
      // policy must not make an already-running automatic parent unreachable.
      const activeRunOptions = { ...currentOptions };
      delete activeRunOptions.sourceReplyDeliveryMode;
      currentOptions = activeRunOptions;
      outcome = await resolveQueueEmbeddedAgentMessageOutcome(sessionId, message, currentOptions);
      continue;
    }
    if (outcome.reason === "compacting") {
      const remainingDeliveryTimeoutMs =
        compactionDeadlineMs === undefined ? undefined : compactionDeadlineMs - Date.now();
      const canRetry =
        remainingDeliveryTimeoutMs === undefined
          ? compactionRetryIndex < compactionRetryDelaysMs.length
          : remainingDeliveryTimeoutMs > 0;
      if (!canRetry) {
        break;
      }
      // Use the next scheduled backoff delay; once the schedule is exhausted,
      // keep using its last entry until the deadline is reached.
      const scheduledDelayMs =
        compactionRetryDelaysMs[
          Math.min(compactionRetryIndex, compactionRetryDelaysMs.length - 1)
        ] ?? 0;
      // Clamp the wait to the remaining delivery window so the final retry does
      // not sleep past the deadline (which would overrun the delivery timeout).
      // If no time remains, stop retrying and let the fallback handle it.
      const delayMs =
        remainingDeliveryTimeoutMs === undefined
          ? scheduledDelayMs
          : Math.min(scheduledDelayMs, remainingDeliveryTimeoutMs);
      if (delayMs <= 0 && remainingDeliveryTimeoutMs !== undefined) {
        break;
      }
      await waitForAnnounceRetryDelay(delayMs, signal);
      if (signal?.aborted) {
        break;
      }
      compactionRetryIndex += 1;
      const retryOptions = resolveRetryOptions();
      if (!retryOptions) {
        break;
      }
      outcome = await resolveQueueEmbeddedAgentMessageOutcome(sessionId, message, retryOptions);
      continue;
    }
    break;
  }
  return outcome;
}

export function resolveSubagentAnnounceTimeoutMs(cfg: OpenClawConfig): number {
  const configured = cfg.agents?.defaults?.subagents?.announceTimeoutMs;
  return clampTimerTimeoutMs(configured) ?? DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
}

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function summarizeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined || error === null) {
    return "unknown error";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "error";
  }
}

const TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /\berrorcode=unavailable\b/i,
  /\bstatus\s*[:=]\s*"?unavailable\b/i,
  /\bUNAVAILABLE\b/,
  /no active .* listener/i,
  /gateway not connected/i,
  /gateway closed \(1006/i,
  /gateway timeout/i,
  /\ball models failed\b/i,
  /\ball profiles unavailable\b/i,
  /\boverloaded\b/i,
  /\b(econnreset|econnrefused|etimedout|enotfound|ehostunreach|network error)\b/i,
];

const SESSION_FILE_CHANGED_ANNOUNCE_RE =
  /session file changed while embedded prompt lock was released/i;

const PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS: readonly RegExp[] = [
  /unsupported channel/i,
  /unknown channel/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  SESSION_FILE_CHANGED_ANNOUNCE_RE,
];

function isSessionFileChangedAnnounceError(message: string): boolean {
  return SESSION_FILE_CHANGED_ANNOUNCE_RE.test(message);
}

const ANNOUNCE_ERROR_CHAIN_KEYS = [
  "cause",
  "cleanupError",
  "error",
  "promptError",
  "reason",
] as const;
type AnnounceErrorChainKey = (typeof ANNOUNCE_ERROR_CHAIN_KEYS)[number];
type AnnounceErrorRecord = Partial<Record<AnnounceErrorChainKey, unknown>> & {
  sentBeforeError?: unknown;
  visibleReplySent?: unknown;
};

function isAnnounceErrorRecord(error: unknown): error is AnnounceErrorRecord {
  return Boolean(error && typeof error === "object");
}

function hasAnnounceErrorMatch(
  error: unknown,
  matches: (candidate: unknown) => boolean,
  seen: Set<object> = new Set(),
): boolean {
  if (matches(error)) {
    return true;
  }
  if (!isAnnounceErrorRecord(error)) {
    return false;
  }
  if (seen.has(error)) {
    return false;
  }
  seen.add(error);

  return ANNOUNCE_ERROR_CHAIN_KEYS.some((key) => hasAnnounceErrorMatch(error[key], matches, seen));
}

function hasSessionFileChangedAnnounceError(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, (candidate) =>
    isSessionFileChangedAnnounceError(summarizeDeliveryError(candidate)),
  );
}

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  const topLevelPermanent = Boolean(
    message && PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message)),
  );
  if (topLevelPermanent && !isSessionFileChangedAnnounceError(message)) {
    return false;
  }

  const sessionFileChanged = hasSessionFileChangedAnnounceError(error);
  if (sessionFileChanged) {
    return !hasAnnounceSendEvidence(error);
  }

  if (
    hasAnnounceErrorMatch(
      error,
      (candidate) =>
        Boolean(candidate && typeof candidate === "object") &&
        (candidate as { gatewayCode?: unknown }).gatewayCode === "UNAVAILABLE" &&
        /cron run continuation/i.test(summarizeDeliveryError(candidate)),
    )
  ) {
    return true;
  }

  if (!message) {
    return false;
  }
  if (topLevelPermanent) {
    return false;
  }
  return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function isPermanentAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return (
    (message && PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) ||
    hasSessionFileChangedAnnounceError(error)
  );
}

function isIncompleteAnnounceAgentResultError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return /(?:incomplete terminal response|code=incomplete_result)\b/i.test(message);
}

function isSessionWriteLockAnnounceAgentError(error: unknown): boolean {
  if (isSessionWriteLockAcquireError(error)) {
    return true;
  }
  const message = summarizeDeliveryError(error);
  return (
    /\bSessionWriteLock(?:Timeout|Stale)Error\b/.test(message) ||
    /\bsession file lock(?:ed| stale)\b/i.test(message)
  );
}

function isAnnounceAgentPreDispatchError(error: unknown): boolean {
  return hasAnnounceErrorMatch(
    error,
    (candidate) =>
      Boolean(candidate && typeof candidate === "object") &&
      (candidate as { announcePreDispatch?: unknown }).announcePreDispatch === true,
  );
}

function hasDirectAnnounceSendEvidence(error: unknown): boolean {
  if (isOutboundDeliveryError(error) && error.sentBeforeError) {
    return true;
  }
  if (!isAnnounceErrorRecord(error)) {
    return false;
  }
  return error.sentBeforeError === true || error.visibleReplySent === true;
}

function hasAnnounceSendEvidence(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, hasDirectAnnounceSendEvidence);
}

async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readCronRunContinuation(params: {
  sessionKey: string;
  expectedLifecycleRevision?: string;
}): { lifecycleRevision: string; sessionId: string } | undefined {
  const entry = subagentAnnounceDeliveryDeps.loadRequesterSessionEntry(params.sessionKey).entry;
  const lifecycleRevision = entry?.cronRunContinuation?.lifecycleRevision;
  if (
    !lifecycleRevision ||
    (params.expectedLifecycleRevision !== undefined &&
      lifecycleRevision !== params.expectedLifecycleRevision)
  ) {
    return undefined;
  }
  const sessionId = entry?.sessionId?.trim();
  return sessionId ? { lifecycleRevision, sessionId } : undefined;
}

function cronRunContinuationLostError(message: string): Error & {
  cronRunContinuationLost: true;
} {
  const error = new Error(message) as Error & { cronRunContinuationLost: true };
  error.cronRunContinuationLost = true;
  return error;
}

function isCronRunContinuationLostError(error: unknown): boolean {
  return hasAnnounceErrorMatch(error, (candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    if ((candidate as { cronRunContinuationLost?: unknown }).cronRunContinuationLost === true) {
      return true;
    }
    return (
      (candidate as { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
      /cron run continuation (?:owner was lost|base session was not persisted)/i.test(
        summarizeDeliveryError(candidate),
      )
    );
  });
}

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  for (const [retryIndex, delayMs] of retryDelaysMs.entries()) {
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      if (!isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDeliveryError(err)}`,
      );
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
  if (params.signal?.aborted) {
    throw new Error("announce delivery aborted");
  }
  return await params.run();
}

export async function resolveSubagentCompletionOrigin(params: {
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  childRunId?: string;
  spawnMode?: SpawnSubagentMode;
  expectsCompletionMessage: boolean;
}): Promise<DeliveryContext | undefined> {
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const channel = normalizeOptionalLowercaseString(requesterOrigin?.channel);
  const to = requesterOrigin?.to?.trim();
  const accountId = normalizeAccountId(requesterOrigin?.accountId);
  const threadId =
    requesterOrigin?.threadId != null && requesterOrigin.threadId !== ""
      ? requesterOrigin.threadId
      : undefined;
  const conversationId =
    stringifyRouteThreadId(threadId) ||
    resolveConversationIdFromTargets({
      targets: [to],
    }) ||
    "";
  const requesterConversation: ConversationRef | undefined =
    channel && conversationId ? { channel, accountId, conversationId } : undefined;

  const router = createBoundDeliveryRouter();
  const requesterRoute = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.requesterSessionKey,
    requester: requesterConversation,
    failClosed: true,
  });
  if (requesterRoute.mode === "bound" && requesterRoute.binding) {
    return mergeDeliveryContext(
      resolveBoundConversationOrigin({
        bindingConversation: requesterRoute.binding.conversation,
        requesterConversation,
        requesterOrigin,
      }),
      requesterOrigin,
    );
  }

  const childRoute = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.childSessionKey,
    requester: requesterConversation,
    failClosed: true,
  });
  if (childRoute.mode === "bound" && childRoute.binding) {
    return mergeDeliveryContext(
      resolveBoundConversationOrigin({
        bindingConversation: childRoute.binding.conversation,
        requesterConversation,
        requesterOrigin,
      }),
      requesterOrigin,
    );
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("subagent_delivery_target")) {
    return requesterOrigin;
  }
  try {
    const result = await hookRunner.runSubagentDeliveryTarget(
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
        requesterOrigin,
        childRunId: params.childRunId,
        spawnMode: params.spawnMode,
        expectsCompletionMessage: params.expectsCompletionMessage,
      },
      {
        runId: params.childRunId,
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    const hookOrigin = normalizeDeliveryContext(result?.origin);
    if (!hookOrigin) {
      return requesterOrigin;
    }
    if (hookOrigin.channel && isInternalMessageChannel(hookOrigin.channel)) {
      return requesterOrigin;
    }
    return mergeDeliveryContext(hookOrigin, requesterOrigin);
  } catch {
    return requesterOrigin;
  }
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const entry = subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath,
    sessionKey: canonicalKey,
    clone: false,
  });
  return { cfg, entry, canonicalKey };
}

export function loadSessionEntryByKey(sessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  return subagentAnnounceDeliveryDeps.loadSessionEntry({
    storePath,
    sessionKey,
    clone: false,
  });
}

async function maybeSteerSubagentAnnounce(params: {
  deliveryTimeoutMs?: number;
  requesterSessionKey: string;
  steerMessage: string;
  signal?: AbortSignal;
}): Promise<
  { status: "steered"; deliveredAt?: number; enqueuedAt?: number } | { status: "none" | "dropped" }
> {
  if (params.signal?.aborted) {
    return { status: "none" };
  }
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const { sessionId, isActive } = resolveRequesterSessionActivity(canonicalKey);
  if (subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalKey, sessionId)) {
    return { status: "none" };
  }
  if (!sessionId || !isActive) {
    return { status: "none" };
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: sessionDeliveryChannel(entry),
    sessionEntry: entry,
  });

  // Subagent announcements are internal handoffs into an active requester turn.
  // Queue modes such as followup/collect apply to user prompts, not this path.
  const queueOptions: EmbeddedAgentQueueMessageOptions = {
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    steeringMode: "all",
    ...(queueSettings.debounceMs !== undefined ? { debounceMs: queueSettings.debounceMs } : {}),
    waitForTranscriptCommit: true,
  };
  const queueOutcome = await resolveActiveWakeWithRetries(
    sessionId,
    params.steerMessage,
    queueOptions,
    params.signal,
  );
  if (queueOutcome.queued) {
    return {
      status: "steered",
      deliveredAt: queueOutcome.deliveredAtMs,
      enqueuedAt: queueOutcome.enqueuedAtMs,
    };
  }

  // A stale_run refusal means the requester run is evidence-dead: it will not
  // drain its steer queue, so "dropped" would discard the handoff. Report
  // not-active so dispatch takes the direct fallback instead.
  if (queueOutcome.reason === "stale_run") {
    return { status: "none" };
  }
  const currentActivity = resolveRequesterSessionActivity(canonicalKey);
  return { status: currentActivity.isActive ? "dropped" : "none" };
}

function hasVisibleGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(
    result && (hasVisibleAgentPayload(result) || hasMessagingToolDeliveryEvidence(result)),
  );
}

function hasVisibleNonSilentGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result) {
    return false;
  }
  if (hasMessagingToolDeliveryEvidence(result)) {
    return true;
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  return payloads.some(isVisibleNonSilentGatewayAgentPayload);
}

function isVisibleNonSilentGatewayAgentPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as {
    text?: unknown;
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    presentation?: unknown;
    interactive?: unknown;
    channelData?: unknown;
  };
  if (
    record.mediaUrl ||
    (Array.isArray(record.mediaUrls) && record.mediaUrls.length > 0) ||
    record.presentation ||
    record.interactive ||
    record.channelData
  ) {
    return true;
  }
  return (
    typeof record.text === "string" &&
    record.text.trim() !== "" &&
    !isSilentReplyPayloadText(record.text, SILENT_REPLY_TOKEN)
  );
}

function hasGatewayAgentMessagingToolDeliveryEvidence(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(result && hasMessagingToolDeliveryEvidence(result));
}

function hasGatewayAgentCompletionSideEffectEvidence(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result) {
    return false;
  }
  return (
    hasMessagingToolDeliveryEvidence(result) ||
    (Array.isArray(result.acceptedSessionSpawns) &&
      hasAcceptedSessionSpawn(result.acceptedSessionSpawns)) ||
    hasPositiveDeliveryCount(result.successfulCronAdds)
  );
}

function hasIntentionalSilentGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result || !Array.isArray(result.payloads)) {
    return false;
  }
  return result.payloads.some(isIntentionalSilentGatewayAgentPayload);
}

function isIntentionalSilentGatewayAgentPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as {
    text?: unknown;
    mediaUrl?: unknown;
    mediaUrls?: unknown;
    presentation?: unknown;
    interactive?: unknown;
    channelData?: unknown;
  };
  if (
    typeof record.text !== "string" ||
    !isSilentReplyPayloadText(record.text, SILENT_REPLY_TOKEN)
  ) {
    return false;
  }
  return !(
    record.mediaUrl ||
    (Array.isArray(record.mediaUrls) && record.mediaUrls.length > 0) ||
    record.presentation ||
    record.interactive ||
    record.channelData
  );
}

function hasPositiveDeliveryCount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function requiresAgentMediatedCompletionDelivery(params: {
  expectsCompletionMessage: boolean;
  sourceTool?: string;
}): boolean {
  return params.expectsCompletionMessage && isAgentMediatedCompletionSourceTool(params.sourceTool);
}

function collectExpectedMediaFromInternalEvents(
  events: AgentInternalEvent[] | undefined,
): string[] {
  if (!events?.length) {
    return [];
  }
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const values = [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ];
    for (const value of values) {
      const normalized = typeof value === "string" ? value.trim() : "";
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      mediaUrls.push(normalized);
    }
  }
  return mediaUrls;
}

function getGatewayAgentCommandDeliveryFailure(response: unknown): string | undefined {
  const result = getGatewayAgentResult(response);
  return result ? getAgentCommandDeliveryFailure(result) : undefined;
}

function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
}

function resolveGeneratedMediaCompletionLabel(params: {
  sourceTool?: string;
  internalEvents?: readonly AgentInternalEvent[];
}): string {
  const sourceTool = params.sourceTool?.trim();
  if (sourceTool === "image_generate") {
    return "image";
  }
  if (sourceTool === "music_generate") {
    return "music";
  }
  if (sourceTool === "video_generate") {
    return "video";
  }
  const announceType = params.internalEvents
    ?.find((event) => event.type === "task_completion")
    ?.announceType?.trim()
    .toLowerCase();
  if (announceType?.includes("image")) {
    return "image";
  }
  if (announceType?.includes("music") || announceType?.includes("audio")) {
    return "music";
  }
  if (announceType?.includes("video")) {
    return "video";
  }
  return "media";
}

function resolveGeneratedMediaFailureNotice(params: {
  internalEvents?: readonly AgentInternalEvent[];
  mediaLabel: string;
}): string | undefined {
  const failure = params.internalEvents
    ?.toReversed()
    .find(
      (event) =>
        event.type === "task_completion" &&
        event.source !== "subagent" &&
        event.source !== "cron" &&
        event.status !== "ok",
    );
  return failure
    ? `${params.mediaLabel[0]?.toUpperCase() ?? "M"}${params.mediaLabel.slice(1)} generation failed: ${failure.result}`
    : undefined;
}

async function deliverGeneratedMediaCompletionDirect(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  directIdempotencyKey: string;
  deliveryTarget: {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  mediaUrls: readonly string[];
  internalEvents?: readonly AgentInternalEvent[];
  sourceTool?: string;
  wakeAfterDelivery: boolean;
  content?: string;
  status?: "ok" | "error";
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  if (
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    (params.mediaUrls.length === 0 && !params.content)
  ) {
    return undefined;
  }
  const mediaLabel = resolveGeneratedMediaCompletionLabel({
    sourceTool: params.sourceTool,
    internalEvents: params.internalEvents,
  });
  const agentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const idempotencyKey = `${params.directIdempotencyKey}:generated-media-direct`;
  try {
    await subagentAnnounceDeliveryDeps.sendMessage({
      cfg: params.cfg,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      accountId: params.deliveryTarget.accountId,
      threadId: params.deliveryTarget.threadId,
      requesterSessionKey: params.requesterSessionKey,
      agentId,
      content: params.content ?? `The generated ${mediaLabel} is ready.`,
      mediaUrls: Array.from(params.mediaUrls),
      idempotencyKey,
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    if (params.wakeAfterDelivery) {
      wakeSessionForGeneratedMediaDirectDelivery({
        cfg: params.cfg,
        sessionKey: params.requesterSessionKey,
        mediaLabel,
        status: params.status ?? "ok",
        deliveryContext: {
          channel: params.deliveryTarget.channel,
          to: params.deliveryTarget.to,
          accountId: params.deliveryTarget.accountId,
          threadId: params.deliveryTarget.threadId,
        },
        contextKey: idempotencyKey,
      });
    }
    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    const terminal = hasAnnounceSendEvidence(err);
    return {
      delivered: false,
      path: "direct",
      error: `generated media direct delivery failed: ${summarizeDeliveryError(err)}`,
      ...(terminal
        ? { terminal: true }
        : params.mediaUrls.length > 0
          ? { missingMediaUrls: Array.from(params.mediaUrls) }
          : {}),
    };
  }
}

function inferDeliveryTargetChatType(target: {
  channel?: string;
  to?: string;
}): "direct" | "group" | "channel" | undefined {
  const normalizedTo = normalizeOptionalLowercaseString(target.to);
  if (!normalizedTo) {
    return undefined;
  }
  if (
    normalizedTo.startsWith("dm:") ||
    normalizedTo.startsWith("direct:") ||
    normalizedTo.startsWith("user:") ||
    normalizedTo.includes(":dm:") ||
    normalizedTo.includes(":direct:")
  ) {
    return "direct";
  }
  if (normalizedTo.startsWith("channel:") || normalizedTo.startsWith("thread:")) {
    return "channel";
  }
  if (normalizedTo.startsWith("group:")) {
    return "group";
  }
  const channel = normalizeMessageChannel(target.channel);
  return channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging?.inferTargetChatType?.({
        to: target.to ?? "",
      })
    : undefined;
}

function isDirectMessageDeliveryTarget(
  target: { channel?: string; to?: string; threadId?: string },
  requesterSessionKey: string,
): boolean {
  if (target.threadId) {
    return false;
  }
  const targetChatType = inferDeliveryTargetChatType(target);
  if (targetChatType) {
    return targetChatType === "direct";
  }
  return deriveSessionChatTypeFromKey(requesterSessionKey) === "direct";
}

function resolveTextCompletionDirectFallback(events: readonly AgentInternalEvent[] | undefined) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    if (event?.type !== "task_completion" || event.source !== "subagent") {
      continue;
    }
    if (event.status !== "ok") {
      continue;
    }
    const result = typeof event.result === "string" ? event.result.trim() : "";
    if (result && result !== "(no output)") {
      return result;
    }
  }
  return undefined;
}

function hasFailedSubagentNoOutputCompletion(events: readonly AgentInternalEvent[] | undefined) {
  return (
    events?.some(
      (event) =>
        event.type === "task_completion" &&
        event.source === "subagent" &&
        event.status !== "ok" &&
        event.result.trim() === "(no output)",
    ) === true
  );
}

async function deliverTextCompletionDirect(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  directIdempotencyKey: string;
  deliveryTarget: {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  internalEvents?: readonly AgentInternalEvent[];
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  const content = resolveTextCompletionDirectFallback(params.internalEvents);
  if (
    !content ||
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    !isDirectMessageDeliveryTarget(params.deliveryTarget, params.requesterSessionKey)
  ) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(params.requesterSessionKey);
  const idempotencyKey = `${params.directIdempotencyKey}:text-direct`;
  try {
    await subagentAnnounceDeliveryDeps.sendMessage({
      cfg: params.cfg,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      accountId: params.deliveryTarget.accountId,
      threadId: params.deliveryTarget.threadId,
      requesterSessionKey: params.requesterSessionKey,
      agentId,
      conversationType: "direct",
      content,
      idempotencyKey,
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    return {
      delivered: false,
      path: "direct",
      error: `text completion direct delivery failed: ${summarizeDeliveryError(err)}`,
    };
  }
}

function resolveGeneratedMediaDirectFallbackUrls(params: {
  expectedMediaUrls: readonly string[];
  announceResponse?: unknown;
  requiresMessageToolDelivery: boolean;
  automaticDeliveryRequested: boolean;
  automaticDeliveryFailed?: boolean;
  deliveryTarget: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): string[] {
  const expected = uniqueStrings(normalizeStringEntries(params.expectedMediaUrls));
  const result = getGatewayAgentResult(params.announceResponse);
  if (!result) {
    return expected;
  }
  const delivered = new Set(
    (params.requiresMessageToolDelivery
      ? collectMessagingToolDeliveredMediaUrlsForTarget(result, params.deliveryTarget)
      : collectAutomaticCompletionDeliveredMediaUrls({
          result,
          deliveryTarget: params.deliveryTarget,
          automaticDeliveryRequested: params.automaticDeliveryRequested,
          automaticDeliveryFailed: params.automaticDeliveryFailed === true,
          expectedMediaCount: expected.length,
        })
    ).map(normalizeMediaReferenceForComparison),
  );
  return expected.filter((url) => !delivered.has(normalizeMediaReferenceForComparison(url)));
}

function collectAutomaticCompletionDeliveredMediaUrls(params: {
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>;
  deliveryTarget: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  automaticDeliveryRequested: boolean;
  automaticDeliveryFailed: boolean;
  expectedMediaCount: number;
}): string[] {
  const urls = new Set<string>();
  const addUrls = (values: Iterable<string>) => {
    for (const value of values) {
      if (value.trim()) {
        urls.add(value);
      }
    }
  };
  if (params.automaticDeliveryRequested) {
    if (params.automaticDeliveryFailed) {
      addUrls(
        collectPayloadOutcomeDeliveredMediaUrls(params.result, {
          countAmbiguousSinglePayloadFailure: params.expectedMediaCount === 1,
        }),
      );
    } else if (hasPayloadDeliveryOutcomes(params.result)) {
      addUrls(
        collectPayloadOutcomeDeliveredMediaUrls(params.result, {
          countAmbiguousSinglePayloadFailure: false,
        }),
      );
    } else if (!hasSuppressedPayloadDeliveryStatus(params.result)) {
      addUrls(collectPayloadMediaUrls(params.result));
    }
  }
  addUrls(collectMessagingToolDeliveredMediaUrlsForTarget(params.result, params.deliveryTarget));
  return Array.from(urls);
}

function collectPayloadMediaUrls(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
): string[] {
  return collectDeliveredMediaUrls({
    payloads: Array.isArray(result.payloads) ? result.payloads : [],
  });
}

function getPayloadDeliveryStatusRecord(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
): Record<string, unknown> | undefined {
  return result.deliveryStatus && typeof result.deliveryStatus === "object"
    ? (result.deliveryStatus as Record<string, unknown>)
    : undefined;
}

function hasPayloadDeliveryOutcomes(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
): boolean {
  return Array.isArray(getPayloadDeliveryStatusRecord(result)?.payloadOutcomes);
}

function hasPayloadOutcomeSendEvidence(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result) {
    return false;
  }
  const outcomes = getPayloadDeliveryStatusRecord(result)?.payloadOutcomes;
  return (
    Array.isArray(outcomes) &&
    outcomes.some(
      (outcome) =>
        Boolean(outcome && typeof outcome === "object") &&
        (normalizeOptionalLowercaseString((outcome as Record<string, unknown>).status) === "sent" ||
          (outcome as Record<string, unknown>).sentBeforeError === true),
    )
  );
}

function hasAmbiguousPayloadSendBeforeError(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  const outcomes = result ? getPayloadDeliveryStatusRecord(result)?.payloadOutcomes : undefined;
  return (
    Array.isArray(outcomes) &&
    outcomes.some(
      (outcome) =>
        Boolean(outcome && typeof outcome === "object") &&
        normalizeOptionalLowercaseString((outcome as Record<string, unknown>).status) ===
          "failed" &&
        (outcome as Record<string, unknown>).sentBeforeError === true,
    )
  );
}

function hasIncompletePartialPayloadOutcomeEvidence(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result) {
    return false;
  }
  const deliveryStatus = getPayloadDeliveryStatusRecord(result);
  if (normalizeOptionalLowercaseString(deliveryStatus?.status) !== "partial_failed") {
    return false;
  }
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const outcomes = deliveryStatus?.payloadOutcomes;
  if (!Array.isArray(outcomes) || payloads.length === 0 || outcomes.length !== payloads.length) {
    return true;
  }
  const seenIndexes = new Set<number>();
  for (const outcome of outcomes) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      return true;
    }
    const record = outcome as Record<string, unknown>;
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    const status = normalizeOptionalLowercaseString(record.status);
    if (
      index === undefined ||
      index < 0 ||
      index >= payloads.length ||
      seenIndexes.has(index) ||
      (status !== "sent" && status !== "suppressed" && status !== "failed") ||
      (status === "failed" && typeof record.sentBeforeError !== "boolean")
    ) {
      return true;
    }
    seenIndexes.add(index);
  }
  return seenIndexes.size !== payloads.length;
}

function hasSuppressedPayloadDeliveryStatus(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
): boolean {
  return (
    normalizeOptionalLowercaseString(getPayloadDeliveryStatusRecord(result)?.status) ===
    "suppressed"
  );
}

function collectPayloadOutcomeDeliveredMediaUrls(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
  options: { countAmbiguousSinglePayloadFailure: boolean },
): string[] {
  const payloads = Array.isArray(result.payloads) ? result.payloads : [];
  const deliveryStatus = getPayloadDeliveryStatusRecord(result);
  const payloadOutcomes = Array.isArray(deliveryStatus?.payloadOutcomes)
    ? deliveryStatus.payloadOutcomes
    : [];
  const urls = new Set<string>();
  for (const outcome of payloadOutcomes) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      continue;
    }
    const record = outcome as Record<string, unknown>;
    const status = normalizeOptionalLowercaseString(record.status);
    const ambiguousSinglePayloadFailure =
      status === "failed" &&
      record.sentBeforeError === true &&
      options.countAmbiguousSinglePayloadFailure &&
      payloadOutcomes.length === 1 &&
      payloads.length === 1;
    if (status !== "sent" && !ambiguousSinglePayloadFailure) {
      continue;
    }
    const index =
      typeof record.index === "number" && Number.isInteger(record.index) ? record.index : undefined;
    const payload = index === undefined ? undefined : payloads[index];
    if (!payload) {
      continue;
    }
    for (const url of collectDeliveredMediaUrls({ payloads: [payload] })) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function collectMessagingToolDeliveredMediaUrlsForTarget(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>>,
  deliveryTarget: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  },
): string[] {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const urls = new Set<string>();
  const targetedUrls = new Set<string>();
  for (const target of targets) {
    const targetMediaUrls = collectMessagingToolDeliveredMediaUrls({
      messagingToolSentTargets: [target],
    });
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const targetRecord = target as Record<string, unknown>;
    const targetTo = typeof targetRecord.to === "string" ? targetRecord.to.trim() : "";
    if (!targetTo) {
      if (
        !deliveryTarget.to ||
        !sourceDeliveryTargetsMatch({ ...targetRecord, to: deliveryTarget.to }, deliveryTarget)
      ) {
        for (const url of targetMediaUrls) {
          targetedUrls.add(url);
        }
        continue;
      }
      for (const url of targetMediaUrls) {
        urls.add(url);
      }
      continue;
    }
    for (const url of targetMediaUrls) {
      targetedUrls.add(url);
    }
    if (!sourceDeliveryTargetsMatch(targetRecord, deliveryTarget)) {
      continue;
    }
    for (const url of targetMediaUrls) {
      urls.add(url);
    }
  }
  for (const url of collectMessagingToolDeliveredMediaUrls({
    messagingToolSentMediaUrls: result.messagingToolSentMediaUrls,
  })) {
    if (!targetedUrls.has(url)) {
      urls.add(url);
    }
  }
  return Array.from(urls);
}

function stripNonDeliverableChannelForCompletionOrigin(
  context?: DeliveryContext,
): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(context);
  if (!normalized?.channel) {
    return normalized;
  }
  const channel = normalizeMessageChannel(normalized.channel);
  if (!channel || isDeliverableMessageChannel(channel)) {
    return normalized;
  }
  const { channel: _channel, ...rest } = normalized;
  return normalizeDeliveryContext(rest);
}

function resolveCompletionDeliveryOrigins(params: {
  expectsCompletionMessage: boolean;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}) {
  const directOrigin = normalizeDeliveryContext(params.directOrigin);
  const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
  const externalCompletionDirectOrigin = stripNonDeliverableChannelForCompletionOrigin(
    params.completionDirectOrigin,
  );
  const completionExternalFallbackOrigin = mergeDeliveryContext(
    directOrigin,
    requesterSessionOrigin,
  );
  return {
    directOrigin,
    requesterSessionOrigin,
    effectiveDirectOrigin: params.expectsCompletionMessage
      ? mergeDeliveryContext(externalCompletionDirectOrigin, completionExternalFallbackOrigin)
      : directOrigin,
  };
}

function resolveGeneratedMediaSessionDeliveryRoute(params: {
  sessionKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
}): { route: SessionDeliveryRoute; deliveryContext?: DeliveryContext } {
  const externalCompletionOrigin = stripNonDeliverableChannelForCompletionOrigin(
    params.completionDirectOrigin,
  );
  const fallbackOrigin = mergeDeliveryContext(params.directOrigin, params.requesterSessionOrigin);
  const deliveryContext = normalizeDeliveryContext(
    mergeDeliveryContext(externalCompletionOrigin, fallbackOrigin),
  );
  const channel = normalizeMessageChannel(deliveryContext?.channel);
  const to = deliveryContext?.to?.trim();
  const inferredRouteChatType = inferDeliveryTargetChatType({ channel, to });
  const derivedChatType = deriveSessionChatTypeFromKey(params.sessionKey);
  const chatType =
    inferredRouteChatType ??
    (!derivedChatType || derivedChatType === "unknown" ? "direct" : derivedChatType);
  if (channel && isGatewayMessageChannel(channel) && to) {
    return {
      route: {
        channel,
        to,
        ...(deliveryContext?.accountId ? { accountId: deliveryContext.accountId } : {}),
        ...(deliveryContext?.threadId != null
          ? { threadId: stringifyRouteThreadId(deliveryContext.threadId) }
          : {}),
        chatType,
      },
      deliveryContext,
    };
  }
  return {
    route: {
      channel: INTERNAL_MESSAGE_CHANNEL,
      to: params.sessionKey,
      chatType,
    },
    deliveryContext,
  };
}

async function sendSubagentAnnounceDirectly(params: {
  requesterSessionKey: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  durableGeneratedMediaHandoff?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
  allowGeneratedMediaDirectFallback: boolean;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  if (params.signal?.aborted) {
    return {
      delivered: false,
      path: "none",
    };
  }
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const canonicalRequesterSessionKey = resolveRequesterStoreKey(
    cfg,
    params.targetRequesterSessionKey,
  );
  try {
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // lastChannel / lastTo. Without this, a completion origin that carries a
    // channel but not a `to` would prevent external delivery.
    const { directOrigin, requesterSessionOrigin, effectiveDirectOrigin } =
      resolveCompletionDeliveryOrigins(params);
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const requesterEntry = subagentAnnounceDeliveryDeps.loadRequesterSessionEntry(
      params.targetRequesterSessionKey,
    ).entry;
    const deliveryTarget = !params.requesterIsSubagent
      ? resolveExternalBestEffortDeliveryTarget({
          channel: effectiveDirectOrigin?.channel,
          to: effectiveDirectOrigin?.to,
          accountId: effectiveDirectOrigin?.accountId,
          threadId: effectiveDirectOrigin?.threadId,
        })
      : { deliver: false };
    const normalizedSessionOnlyOriginChannel = !params.requesterIsSubagent
      ? normalizeMessageChannel(sessionOnlyOrigin?.channel)
      : undefined;
    const sessionOnlyOriginChannel =
      normalizedSessionOnlyOriginChannel &&
      isGatewayMessageChannel(normalizedSessionOnlyOriginChannel)
        ? normalizedSessionOnlyOriginChannel
        : undefined;
    const sourceToolId =
      normalizeOptionalLowercaseString(params.sourceTool) ??
      (params.expectsCompletionMessage ? "subagent_announce" : "");
    const isSubagentCompletion = sourceToolId === "subagent_announce";
    const agentMediatedCompletion = requiresAgentMediatedCompletionDelivery({
      expectsCompletionMessage: params.expectsCompletionMessage,
      sourceTool: sourceToolId,
    });
    const expectedMediaUrls = collectExpectedMediaFromInternalEvents(params.internalEvents);
    const completionRouteRequiresMessageToolDelivery =
      params.expectsCompletionMessage &&
      completionRequiresMessageToolDelivery({
        cfg,
        requesterSessionKey: params.requesterSessionKey,
        targetRequesterSessionKey: canonicalRequesterSessionKey,
        requesterEntry,
        directOrigin: effectiveDirectOrigin,
        requesterSessionOrigin,
      });
    const subagentDirectMessageCompletionRequiresMessageTool =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      deliveryTarget.deliver &&
      isDirectMessageDeliveryTarget(deliveryTarget, canonicalRequesterSessionKey);
    const requiresMessageToolDelivery =
      completionRouteRequiresMessageToolDelivery ||
      subagentDirectMessageCompletionRequiresMessageTool;
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    if (
      params.expectsCompletionMessage &&
      subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(
        canonicalRequesterSessionKey,
        requesterActivity.sessionId,
      )
    ) {
      return {
        delivered: false,
        path: "none",
        reason: "requester_abandoned",
        error: "requester session abandoned after timeout",
      };
    }
    let activeRequesterWakeFailed = false;
    let cronContinuation:
      | {
          sessionId: string;
          lifecycleRevision: string;
        }
      | undefined;
    const tryGeneratedMediaDirectDelivery = async (
      announceResponse?: unknown,
      knownMissingMediaUrls?: readonly string[],
    ) => {
      const mediaLabel = resolveGeneratedMediaCompletionLabel({
        sourceTool: params.sourceTool,
        internalEvents: params.internalEvents,
      });
      const failureNotice = resolveGeneratedMediaFailureNotice({
        internalEvents: params.internalEvents,
        mediaLabel,
      });
      const completionNotice =
        failureNotice ??
        (params.allowGeneratedMediaDirectFallback &&
        agentMediatedCompletion &&
        expectedMediaUrls.length === 0
          ? `${mediaLabel[0]?.toUpperCase() ?? "M"}${mediaLabel.slice(1)} generation completed, but the generated media could not be attached here.`
          : undefined);
      const agentAlreadyProducedDeliverySideEffects =
        announceResponse !== undefined &&
        (hasGatewayAgentCompletionSideEffectEvidence(announceResponse) ||
          hasPayloadOutcomeSendEvidence(announceResponse) ||
          (shouldDeliverAgentFinal &&
            !getGatewayAgentCommandDeliveryFailure(announceResponse) &&
            hasVisibleGatewayAgentPayload(announceResponse)));
      // Accepted work still owns the idempotency key even before delivery
      // evidence exists. Raw fallback here could race the eventual agent final.
      if (isGatewayAgentRunPending(announceResponse)) {
        return undefined;
      }
      // A durable handoff owns retries until the session agent has actually
      // delivered something. Direct repair may then send only missing media.
      if (!params.allowGeneratedMediaDirectFallback && !agentAlreadyProducedDeliverySideEffects) {
        return undefined;
      }
      if (
        params.allowGeneratedMediaDirectFallback &&
        agentAlreadyProducedDeliverySideEffects &&
        !knownMissingMediaUrls
      ) {
        return undefined;
      }
      if (
        knownMissingMediaUrls &&
        knownMissingMediaUrls.length > 1 &&
        hasAmbiguousPayloadSendBeforeError(announceResponse)
      ) {
        return undefined;
      }
      if (requesterActivity.isActive && !activeRequesterWakeFailed) {
        return undefined;
      }
      const missingMediaUrls =
        knownMissingMediaUrls ??
        resolveGeneratedMediaDirectFallbackUrls({
          expectedMediaUrls,
          announceResponse,
          requiresMessageToolDelivery,
          automaticDeliveryRequested: shouldDeliverAgentFinal,
          automaticDeliveryFailed:
            !requiresMessageToolDelivery &&
            Boolean(getGatewayAgentCommandDeliveryFailure(announceResponse)),
          deliveryTarget,
        });
      return await deliverGeneratedMediaCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        mediaUrls: missingMediaUrls,
        internalEvents: params.internalEvents,
        sourceTool: params.sourceTool,
        wakeAfterDelivery: params.allowGeneratedMediaDirectFallback,
        ...(completionNotice ? { content: completionNotice } : {}),
        ...(failureNotice ? { status: "error" as const } : {}),
      });
    };
    const completionSourceReplyDeliveryMode = requiresMessageToolDelivery
      ? "message_tool_only"
      : undefined;
    const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
    const requesterQueueSettings = resolveQueueSettings({
      cfg,
      channel:
        sessionDeliveryChannel(requesterEntry) ??
        requesterSessionOrigin?.channel ??
        directOrigin?.channel,
      sessionEntry: requesterEntry,
    });
    if (
      params.expectsCompletionMessage &&
      requesterActivity.sessionId &&
      requesterActivity.isActive
    ) {
      const wakeOptions: EmbeddedAgentQueueMessageOptions = {
        deliveryTimeoutMs: announceTimeoutMs,
        steeringMode: "all",
        ...(completionSourceReplyDeliveryMode
          ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
          : {}),
        ...(requesterQueueSettings.debounceMs !== undefined
          ? { debounceMs: requesterQueueSettings.debounceMs }
          : {}),
        waitForTranscriptCommit: true,
      };
      // Reuse the shared active-wake retry helper so the generated-completion
      // wake also waits through compaction (and best-effort transcript retry)
      // instead of treating a compacting run as a terminal wake failure.
      const wakeOutcome = await resolveActiveWakeWithRetries(
        requesterActivity.sessionId,
        params.triggerMessage,
        wakeOptions,
        params.signal,
      );
      if (wakeOutcome.queued) {
        return {
          delivered: true,
          deliveredAt: wakeOutcome.deliveredAtMs,
          enqueuedAt: wakeOutcome.enqueuedAtMs,
          path: "steered",
        };
      }
      activeRequesterWakeFailed = true;
      defaultRuntime.log(
        `[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: ${formatQueueWakeFailureError(
          "active requester session could not be woken",
          wakeOutcome,
        )}`,
      );
    }
    if (
      params.expectsCompletionMessage &&
      isCronRunSessionKey(canonicalRequesterSessionKey) &&
      !resolveRequesterSessionActivity(canonicalRequesterSessionKey).isActive &&
      !agentMediatedCompletion
    ) {
      const generatedMediaDelivery = await tryGeneratedMediaDirectDelivery();
      if (generatedMediaDelivery) {
        return generatedMediaDelivery;
      }
      if (!agentMediatedCompletion) {
        return {
          delivered: true,
          path: "none",
        };
      }
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    if (
      params.expectsCompletionMessage &&
      parseCronRunScopeSuffix(canonicalRequesterSessionKey).runId !== undefined &&
      hasGeneratedMediaCompletionEvent(params.internalEvents)
    ) {
      const continuation = readCronRunContinuation({
        sessionKey: canonicalRequesterSessionKey,
      });
      if (!continuation) {
        return {
          delivered: false,
          path: "none",
          reason: "completion_handoff_unavailable",
          error: "cron run continuation is unavailable",
        };
      }
      cronContinuation = continuation;
    }
    const directAgentThreadId = shouldDeliverAgentFinal
      ? stringifyRouteThreadId(deliveryTarget.threadId)
      : sessionOnlyOriginChannel
        ? stringifyRouteThreadId(sessionOnlyOrigin?.threadId)
        : undefined;
    const directAgentParams: Record<string, unknown> = {
      sessionKey: canonicalRequesterSessionKey,
      message: params.triggerMessage,
      deliver: shouldDeliverAgentFinal,
      bestEffortDeliver: params.bestEffortDeliver,
      internalEvents: params.internalEvents,
      channel: shouldDeliverAgentFinal ? deliveryTarget.channel : sessionOnlyOriginChannel,
      accountId: shouldDeliverAgentFinal
        ? deliveryTarget.accountId
        : sessionOnlyOriginChannel
          ? sessionOnlyOrigin?.accountId
          : undefined,
      to: shouldDeliverAgentFinal
        ? deliveryTarget.to
        : sessionOnlyOriginChannel
          ? sessionOnlyOrigin?.to
          : undefined,
      threadId: directAgentThreadId,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceTool: params.sourceTool ?? "subagent_announce",
      },
      ...(completionSourceReplyDeliveryMode
        ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
        : {}),
      idempotencyKey: params.directIdempotencyKey,
    };
    let directAnnounceResponse: unknown;
    try {
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: params.expectsCompletionMessage
          ? "completion direct announce agent call"
          : "direct announce agent call",
        signal: params.signal,
        run: async () => {
          let agentParams = directAgentParams;
          if (cronContinuation) {
            const continuation = readCronRunContinuation({
              sessionKey: canonicalRequesterSessionKey,
              expectedLifecycleRevision: cronContinuation.lifecycleRevision,
            });
            if (!continuation) {
              throw cronRunContinuationLostError("cron run continuation changed before delivery");
            }
            cronContinuation = continuation;
            agentParams = { ...directAgentParams, sessionId: continuation.sessionId };
          }
          return await runAnnounceAgentCall({
            agentParams,
            cronRunContinuation: cronContinuation !== undefined,
            expectFinal: true,
            timeoutMs: announceTimeoutMs,
          });
        },
      });
    } catch (err) {
      if (isPermanentAnnounceDeliveryError(err) && hasAnnounceSendEvidence(err)) {
        throw err;
      }
      if (
        params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal || subagentDirectMessageCompletionRequiresMessageTool) &&
        isSubagentCompletion &&
        isIncompleteAnnounceAgentResultError(err)
      ) {
        const textDelivery = await deliverTextCompletionDirect({
          cfg,
          requesterSessionKey: canonicalRequesterSessionKey,
          directIdempotencyKey: params.directIdempotencyKey,
          deliveryTarget,
          internalEvents: params.internalEvents,
        });
        if (textDelivery) {
          return textDelivery;
        }
      }
      if (
        params.allowGeneratedMediaDirectFallback &&
        agentMediatedCompletion &&
        (isSessionWriteLockAnnounceAgentError(err) || isAnnounceAgentPreDispatchError(err))
      ) {
        const emergencyDelivery = await tryGeneratedMediaDirectDelivery();
        if (emergencyDelivery) {
          return emergencyDelivery;
        }
      }
      // The requester-agent handoff is the delivery contract for background
      // completions. A failed handoff should retry/fail visibly instead
      // of sending the child result directly to the external channel.
      throw err;
    }

    const directAnnounceStillPending = isGatewayAgentRunPending(directAnnounceResponse);
    if (directAnnounceStillPending) {
      return {
        delivered: true,
        path: "direct",
      };
    }

    const directDeliveryFailure =
      shouldDeliverAgentFinal || requiresMessageToolDelivery
        ? getGatewayAgentCommandDeliveryFailure(directAnnounceResponse)
        : undefined;
    const shouldRequireGeneratedMediaDelivery =
      agentMediatedCompletion &&
      expectedMediaUrls.length > 0 &&
      (params.requesterIsSubagent || shouldDeliverAgentFinal || requiresMessageToolDelivery);
    const missingExpectedMediaUrls = shouldRequireGeneratedMediaDelivery
      ? resolveGeneratedMediaDirectFallbackUrls({
          expectedMediaUrls,
          announceResponse: directAnnounceResponse,
          requiresMessageToolDelivery,
          automaticDeliveryRequested: shouldDeliverAgentFinal,
          automaticDeliveryFailed: !requiresMessageToolDelivery && Boolean(directDeliveryFailure),
          deliveryTarget,
        })
      : [];
    if (shouldRequireGeneratedMediaDelivery && missingExpectedMediaUrls.length > 0) {
      if (
        hasAmbiguousPayloadSendBeforeError(directAnnounceResponse) ||
        hasIncompletePartialPayloadOutcomeEvidence(directAnnounceResponse)
      ) {
        return {
          delivered: false,
          path: "direct",
          error:
            directDeliveryFailure ??
            "generated media delivery may have partially completed before failing",
          terminal: true,
        };
      }
      const generatedMediaDelivery = await tryGeneratedMediaDirectDelivery(
        directAnnounceResponse,
        missingExpectedMediaUrls,
      );
      if (generatedMediaDelivery) {
        return generatedMediaDelivery;
      }
      return {
        delivered: false,
        path: "direct",
        reason: "generated_media_missing",
        error: "completion agent did not deliver generated media",
        missingMediaUrls: missingExpectedMediaUrls,
      };
    }
    const generatedMediaFailureNotice = resolveGeneratedMediaFailureNotice({
      internalEvents: params.internalEvents,
      mediaLabel: resolveGeneratedMediaCompletionLabel({
        sourceTool: params.sourceTool,
        internalEvents: params.internalEvents,
      }),
    });
    if (
      params.allowGeneratedMediaDirectFallback &&
      agentMediatedCompletion &&
      (generatedMediaFailureNotice || expectedMediaUrls.length === 0)
    ) {
      const emergencyDelivery = await tryGeneratedMediaDirectDelivery(directAnnounceResponse);
      if (emergencyDelivery) {
        return emergencyDelivery;
      }
    }
    if (directDeliveryFailure) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
        ...(hasPayloadOutcomeSendEvidence(directAnnounceResponse) ? { terminal: true } : {}),
      };
    }
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleGatewayAgentPayload(directAnnounceResponse) &&
      !hasGatewayAgentMessagingToolDeliveryEvidence(directAnnounceResponse)
    ) {
      const textDelivery = await deliverTextCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
      });
      if (textDelivery) {
        return textDelivery;
      }
      if (hasFailedSubagentNoOutputCompletion(params.internalEvents)) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasGatewayAgentMessagingToolDeliveryEvidence(directAnnounceResponse) &&
      (!hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse) ||
        subagentDirectMessageCompletionRequiresMessageTool)
    ) {
      if (hasFailedSubagentNoOutputCompletion(params.internalEvents)) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
      if (subagentDirectMessageCompletionRequiresMessageTool) {
        const textDelivery = await deliverTextCompletionDirect({
          cfg,
          requesterSessionKey: canonicalRequesterSessionKey,
          directIdempotencyKey: params.directIdempotencyKey,
          deliveryTarget,
          internalEvents: params.internalEvents,
        });
        if (textDelivery) {
          return textDelivery;
        }
      }
      return {
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        error: "completion agent did not use the message tool for message-tool-only delivery",
      };
    }
    const hasVisibleCompletionReply =
      hasVisibleNonSilentGatewayAgentPayload(directAnnounceResponse);
    const hasCompletionSideEffect =
      hasGatewayAgentCompletionSideEffectEvidence(directAnnounceResponse);
    const hasIntentionalSilentCompletionReply =
      hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);
    const acceptsIntentionalSilentCompletion =
      hasIntentionalSilentCompletionReply && !isSubagentCompletion;
    if (
      params.expectsCompletionMessage &&
      !shouldDeliverAgentFinal &&
      !requiresMessageToolDelivery &&
      !hasVisibleCompletionReply &&
      !hasCompletionSideEffect &&
      !acceptsIntentionalSilentCompletion
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      !isSubagentCompletion &&
      !hasVisibleGatewayAgentPayload(directAnnounceResponse)
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
      };
    }

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    const terminal = isPermanentAnnounceDeliveryError(err) && hasAnnounceSendEvidence(err);
    const continuationUnavailable = isCronRunContinuationLostError(err);
    const continuationPending =
      !terminal &&
      !continuationUnavailable &&
      params.expectsCompletionMessage &&
      parseCronRunScopeSuffix(canonicalRequesterSessionKey).runId !== undefined &&
      hasGeneratedMediaCompletionEvent(params.internalEvents);
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
      ...(terminal ? { terminal: true } : {}),
      ...(continuationUnavailable ? { reason: "completion_handoff_unavailable" as const } : {}),
      ...(continuationPending ? { reason: "completion_handoff_pending" as const } : {}),
    };
  }
}

export async function deliverSubagentAnnouncement(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  internalEvents?: AgentInternalEvent[];
  summaryLine?: string;
  requesterSessionOrigin?: DeliveryContext;
  requesterOrigin?: DeliveryContext;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  durableGeneratedMediaHandoff?: boolean;
  directIdempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  const durableGeneratedMediaHandoff =
    params.durableGeneratedMediaHandoff === true &&
    params.expectsCompletionMessage &&
    isAgentMediatedCompletionSourceTool(params.sourceTool) &&
    hasGeneratedMediaCompletionEvent(params.internalEvents);
  let durableQueueId: string | undefined;
  let durableQueueClaimed = false;
  let durableQueueStatusUnknown = false;
  if (durableGeneratedMediaHandoff) {
    try {
      const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
      const canonicalSessionKey = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
      const queuedRoute = resolveGeneratedMediaSessionDeliveryRoute({
        sessionKey: canonicalSessionKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
      });
      const { requesterSessionOrigin, effectiveDirectOrigin } = resolveCompletionDeliveryOrigins({
        expectsCompletionMessage: params.expectsCompletionMessage,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
      });
      const requesterEntry = subagentAnnounceDeliveryDeps.loadRequesterSessionEntry(
        params.targetRequesterSessionKey,
      ).entry;
      // No external route exists for an internal-only handoff. Let the normal
      // agent final enter the owning transcript instead of requiring a message tool target.
      const sourceReplyDeliveryMode =
        queuedRoute.route.channel === INTERNAL_MESSAGE_CHANNEL
          ? "automatic"
          : completionRequiresMessageToolDelivery({
                cfg,
                requesterSessionKey: params.requesterSessionKey,
                targetRequesterSessionKey: canonicalSessionKey,
                requesterEntry,
                directOrigin: effectiveDirectOrigin,
                requesterSessionOrigin,
              })
            ? "message_tool_only"
            : "automatic";
      const queued = await enqueueClaimedSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: canonicalSessionKey,
          message:
            formatAgentInternalEventsForPrompt(params.internalEvents) || params.triggerMessage,
          messageId: `${params.directIdempotencyKey}:agent-loop`,
          route: queuedRoute.route,
          ...(queuedRoute.deliveryContext ? { deliveryContext: queuedRoute.deliveryContext } : {}),
          inputProvenance: {
            kind: "inter_session",
            ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
            sourceChannel: params.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
            sourceTool: params.sourceTool ?? "subagent_announce",
          },
          sourceReplyDeliveryMode,
          expectedMediaUrls: collectExpectedMediaFromInternalEvents(params.internalEvents),
          idempotencyKey: `${params.directIdempotencyKey}:agent-loop`,
        },
        resolveSubagentAnnounceTimeoutMs(cfg) + 5_000,
      );
      if (queued.status === "failed") {
        return {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_unavailable",
          error: "generated media session handoff was already dead-lettered",
          terminal: true,
        };
      }
      if (queued.status === "completed") {
        return { delivered: true, path: "queued" };
      }
      durableQueueId = queued.id;
      durableQueueClaimed = queued.claimed;
      durableQueueStatusUnknown = queued.status === "unknown";
    } catch (error) {
      defaultRuntime.log(
        `[warn] Generated media session handoff could not be persisted; refusing ambiguous fallback: ${summarizeDeliveryError(error)}`,
      );
      return {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        error: "generated media session handoff could not be persisted",
        terminal: true,
      };
    }
  }

  if (durableQueueId) {
    if (durableQueueClaimed) {
      await releaseSessionDeliveryClaim(durableQueueId).catch((error: unknown) => {
        defaultRuntime.log(
          `[warn] Generated media session handoff lease release failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
        );
      });
    }
    await scheduleSessionDelivery(durableQueueId).catch((error: unknown) => {
      defaultRuntime.log(
        `[warn] Generated media session handoff retry scheduling failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
      );
    });
    return durableQueueStatusUnknown
      ? {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_pending",
          error: "generated media session handoff state could not be verified",
        }
      : { delivered: true, path: "queued" };
  }

  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    signal: params.signal,
    steer: async () =>
      await maybeSteerSubagentAnnounce({
        deliveryTimeoutMs: resolveSubagentAnnounceTimeoutMs(
          subagentAnnounceDeliveryDeps.getRuntimeConfig(),
        ),
        requesterSessionKey: params.requesterSessionKey,
        steerMessage: params.steerMessage,
        signal: params.signal,
      }),
    direct: async () =>
      await sendSubagentAnnounceDirectly({
        requesterSessionKey: params.requesterSessionKey,
        targetRequesterSessionKey: params.targetRequesterSessionKey,
        triggerMessage: params.triggerMessage,
        internalEvents: params.internalEvents,
        directIdempotencyKey: params.directIdempotencyKey,
        completionDirectOrigin: params.completionDirectOrigin,
        directOrigin: params.directOrigin,
        requesterSessionOrigin: params.requesterSessionOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        requesterIsSubagent: params.requesterIsSubagent,
        expectsCompletionMessage: params.expectsCompletionMessage,
        allowGeneratedMediaDirectFallback: true,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      }),
  });
}

const testing = {
  setDepsForTest(
    overrides?: Partial<SubagentAnnounceDeliveryDeps> & {
      callGateway?: typeof callGateway;
    },
  ) {
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
  },
  hasAnnounceSendEvidence,
  hasSessionFileChangedAnnounceError,
  isSessionFileChangedAnnounceError,
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.subagentAnnounceDeliveryTestApi")
  ] = testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
