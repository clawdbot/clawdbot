/**
 * Subagent completion announcement delivery.
 *
 * Routes completion payloads through gateway/channel/session paths and records delivery evidence.
 */
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { completionRequiresMessageToolDelivery } from "../auto-reply/reply/completion-delivery-policy.js";
import { sanitizePendingFinalDeliveryText } from "../auto-reply/reply/pending-final-delivery.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { isOutboundDeliveryError } from "../infra/outbound/deliver-types.js";
import { sourceDeliveryTargetsMatch } from "../infra/outbound/source-delivery-plan.js";
import { scheduleSessionDelivery } from "../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
} from "../infra/session-delivery-queue.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../runtime.js";
import {
  isAgentMediatedCompletionSourceTool,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { isCronRunSessionKey, isCronSessionKey } from "../sessions/session-key-utils.js";
import { isNonTerminalAgentRunStatus } from "../shared/agent-run-status.js";
import { sessionDeliveryChannel } from "../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { sanitizeAgentRunTerminalReplyText } from "./agent-run-terminal-reply.js";
import { resolveDefaultAgentId } from "./agent-scope-config.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasCommittedOutboundDeliveryEvidence,
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasPayloadOutcomeSendEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "./embedded-agent-runner/delivery-evidence.js";
import {
  hasIntentionalSilentAgentPayload,
  hasVisibleAgentPayload,
} from "./embedded-agent-runner/message-visibility.js";
import type { EmbeddedAgentQueueMessageOptions } from "./embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "./embedded-agent-runner/runs.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  hasGeneratedMediaCompletionEvent,
} from "./internal-event-contract.js";
import { formatAgentInternalEventsForPrompt, type AgentInternalEvent } from "./internal-events.js";
import {
  callGateway,
  dispatchGatewayMethodInProcess,
  isEmbeddedAgentRunActive,
  isEmbeddedRunAbandoned,
  getRuntimeConfig,
  formatEmbeddedAgentQueueFailureSummary,
  loadSessionEntry,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
  resolveAgentIdFromSessionKey,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
  sendMessage,
} from "./subagent-announce-delivery.runtime.js";
import {
  runSubagentAnnounceDispatch,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import type { SubagentCompletionToolHandoffRegistration } from "./subagent-announce-handoff.js";
import {
  inferDeliveryTargetChatType,
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
  type DeliveryContext,
} from "./subagent-announce-origin.js";
import { admitCorrelatedSubagentSessionDelivery } from "./subagent-completion-delivery.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

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
  delegatedToolPolicyHandoff?: SubagentCompletionToolHandoffRegistration;
  expectFinal?: boolean;
  timeoutMs?: number;
}): Promise<unknown> {
  return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess(
    "agent",
    params.agentParams,
    {
      expectFinal: params.expectFinal,
      forceSyntheticClient: shouldPreserveUserFacingSessionStateForInputProvenance(
        params.agentParams.inputProvenance,
      ),
      delegatedToolPolicyHandoff: params.delegatedToolPolicyHandoff,
      timeoutMs: params.timeoutMs,
    },
  );
}

function formatQueueWakeFailureError(
  fallback: string,
  outcome: EmbeddedAgentQueueMessageOutcome,
): string {
  const summary = formatEmbeddedAgentQueueFailureSummary(outcome);
  return summary ? `${fallback}: ${summary}` : fallback;
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

const SOURCE_OWNER_CHANGED = Symbol("source_owner_changed");

function sourceOwnerChangedResult(): SubagentAnnounceDeliveryResult {
  return {
    delivered: false,
    path: "none",
    reason: "source_owner_changed",
    error: "subagent source lifecycle changed before completion delivery",
    terminal: true,
    disposition: "intentional_non_delivery",
  };
}

class SourceOwnerChangedError extends Error {
  constructor() {
    super("subagent source lifecycle changed before completion delivery");
    this.name = "SourceOwnerChangedError";
  }
}

// Wake an active requester run through transient compacting and transcript-wait
// outcomes. Both active-wake call sites use one loop so delivery deadlines and
// best-effort transcript retry stay consistent.
async function resolveActiveWakeWithRetries(
  sessionId: string,
  message: string,
  wakeOptions: EmbeddedAgentQueueMessageOptions,
  signal?: AbortSignal,
  isAttemptAllowed?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome | typeof SOURCE_OWNER_CHANGED> {
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
  const attemptWake = async (options: EmbeddedAgentQueueMessageOptions) => {
    if (isAttemptAllowed?.() === false) {
      return SOURCE_OWNER_CHANGED;
    }
    const result = await resolveQueueEmbeddedAgentMessageOutcome(sessionId, message, options);
    return isAttemptAllowed?.() === false ? SOURCE_OWNER_CHANGED : result;
  };
  let outcome = await attemptWake(currentOptions);
  const compactionRetryDelaysMs = resolveCompactionSteerRetryDelaysMs();
  let compactionRetryIndex = 0;
  for (;;) {
    if (outcome === SOURCE_OWNER_CHANGED) {
      break;
    }
    if (outcome.queued || signal?.aborted) {
      break;
    }
    if (isAttemptAllowed?.() === false) {
      outcome = SOURCE_OWNER_CHANGED;
      break;
    }
    if (
      outcome.reason === "transcript_commit_wait_unsupported" &&
      currentOptions.waitForTranscriptCommit === true
    ) {
      const bestEffortOptions = { ...currentOptions };
      delete bestEffortOptions.waitForTranscriptCommit;
      currentOptions = bestEffortOptions;
      outcome = await attemptWake(currentOptions);
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
      outcome = await attemptWake(currentOptions);
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
      outcome = await attemptWake(retryOptions);
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

export async function runAnnounceDeliveryWithRetry<T>(params: {
  operation: string;
  signal?: AbortSignal;
  isAttemptAllowed?: () => boolean;
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  for (const [retryIndex, delayMs] of retryDelaysMs.entries()) {
    if (params.isAttemptAllowed?.() === false) {
      throw new SourceOwnerChangedError();
    }
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      if (!isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      if (params.isAttemptAllowed?.() === false) {
        throw new SourceOwnerChangedError();
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
  if (params.isAttemptAllowed?.() === false) {
    throw new SourceOwnerChangedError();
  }
  return await params.run();
}

export function loadRequesterSessionEntry(requesterSessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const canonicalKey = resolveRequesterStoreKey(cfg, requesterSessionKey);
  const agentId = resolveAgentIdFromSessionKey(canonicalKey, resolveDefaultAgentId(cfg));
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
  const agentId = resolveAgentIdFromSessionKey(sessionKey, resolveDefaultAgentId(cfg));
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
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" | "source_owner_changed" }
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
    params.isSourceSessionEffectsAllowed,
  );
  if (queueOutcome === SOURCE_OWNER_CHANGED) {
    return { status: "source_owner_changed" };
  }
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

function collectExpectedMediaFromInternalEvents(
  events: AgentInternalEvent[] | undefined,
): string[] {
  return normalizeUniqueTrimmedStringList(
    events?.flatMap((event) => [
      ...(Array.isArray(event.mediaUrls) ? event.mediaUrls : []),
      ...mediaUrlsFromGeneratedAttachments(event.attachments),
    ]),
  );
}

function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
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
    const result =
      typeof event.result === "string"
        ? sanitizeAgentRunTerminalReplyText(sanitizePendingFinalDeliveryText(event.result))
        : "";
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

async function deliverCompletionDirect(params: {
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
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  isSourceSessionEffectsAllowed?: () => boolean;
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
  const agentId = resolveAgentIdFromSessionKey(
    params.requesterSessionKey,
    resolveDefaultAgentId(params.cfg),
  );
  const idempotencyKey = `${params.directIdempotencyKey}:text-direct`;
  let committedDelivery: SubagentAnnounceDeliveryResult | undefined;
  try {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return sourceOwnerChangedResult();
    }
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
      onDeliveryResult: () => {
        if (committedDelivery) {
          return;
        }
        // Platform identity is committed before transcript mirroring, which
        // may wait behind the requester's still-active SQLite writer.
        committedDelivery = { delivered: true, path: "direct", deliveredAt: Date.now() };
        params.onDeliveryResult?.(committedDelivery);
      },
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    return committedDelivery ?? { delivered: true, path: "direct" };
  } catch (err) {
    if (committedDelivery) {
      // Post-send bookkeeping must never turn an identified delivery into a
      // retryable failure and send the same completion twice.
      return committedDelivery;
    }
    return {
      delivered: false,
      path: "direct",
      error: `text completion direct delivery failed: ${summarizeDeliveryError(err)}`,
    };
  }
}

function hasMessagingToolDeliveryToSource(
  result: NonNullable<ReturnType<typeof getGatewayAgentResult>> & {
    didDeliverSourceReplyViaMessageTool?: unknown;
    messagingToolSourceReplyPayloads?: unknown;
  },
  deliveryTarget: Parameters<typeof sourceDeliveryTargetsMatch>[1],
  options?: { requireFinalReply?: boolean },
): boolean {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets = targets.filter((target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      return false;
    }
    const record = target as Parameters<typeof sourceDeliveryTargetsMatch>[0];
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    return sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget);
  });
  if (options?.requireFinalReply) {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  }
  if (
    hasCommittedSourceReplyDeliveryEvidence(result) ||
    hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
  ) {
    return true;
  }

  if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
    return hasMessagingToolDeliveryEvidence(result);
  }

  return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
}

async function sendSubagentAnnounceDirectly(params: {
  requesterSessionKey: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  requesterIsSubagent: boolean;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
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
    const subagentCompletionEvents = params.internalEvents?.filter(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    );
    const trustedCompletionEvent =
      subagentCompletionEvents?.length === 1 &&
      subagentCompletionEvents[0]?.childSessionKey === params.sourceSessionKey
        ? subagentCompletionEvents[0]
        : undefined;
    const hasRequiredSubagentNoOutputCompletion =
      params.expectsCompletionMessage &&
      isSubagentCompletion &&
      (trustedCompletionEvent?.result.trim() === "(no output)" ||
        hasFailedSubagentNoOutputCompletion(params.internalEvents));
    const agentMediatedCompletion =
      params.expectsCompletionMessage && isAgentMediatedCompletionSourceTool(sourceToolId);
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
    const isCompletionDeliveryAllowed = () =>
      params.isSourceSessionEffectsAllowed?.() !== false &&
      !(params.expectsCompletionMessage && params.isCompletionOwnedByRequesterYield?.());
    if (!isCompletionDeliveryAllowed()) {
      // sessions_yield owns the post-turn synthesis. Starting or steering a
      // requester turn here would replay the original fanout during handoff.
      return {
        delivered: false,
        path: "none",
        reason: "completion_handoff_pending",
        terminal: true,
        disposition: "intentional_non_delivery",
      };
    }
    const tryTextCompletionDirectDelivery = () =>
      deliverCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        internalEvents: params.internalEvents,
        onDeliveryResult: params.onDeliveryResult,
        isSourceSessionEffectsAllowed: isCompletionDeliveryAllowed,
      });
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
      // Ordinary subagent and harness handoffs must wait through compaction
      // and transcript retries before treating an active wake as failed.
      const wakeOutcome = await resolveActiveWakeWithRetries(
        requesterActivity.sessionId,
        params.triggerMessage,
        wakeOptions,
        params.signal,
        isCompletionDeliveryAllowed,
      );
      if (wakeOutcome === SOURCE_OWNER_CHANGED) {
        return sourceOwnerChangedResult();
      }
      if (wakeOutcome.queued) {
        return {
          delivered: true,
          deliveredAt: wakeOutcome.deliveredAtMs,
          enqueuedAt: wakeOutcome.enqueuedAtMs,
          path: "steered",
        };
      }
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
      return {
        delivered: true,
        path: "none",
      };
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
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
        isAttemptAllowed: isCompletionDeliveryAllowed,
        run: async () => {
          if (!isCompletionDeliveryAllowed()) {
            throw new SourceOwnerChangedError();
          }
          return await runAnnounceAgentCall({
            agentParams: directAgentParams,
            delegatedToolPolicyHandoff:
              isSubagentCompletion &&
              trustedCompletionEvent &&
              params.sourceSessionKey &&
              requesterActivity.sessionId &&
              params.isSourceSessionEffectsAllowed?.() !== false
                ? {
                    sourceSessionKey: params.sourceSessionKey,
                    ...(trustedCompletionEvent.childSessionId
                      ? { sourceSessionId: trustedCompletionEvent.childSessionId }
                      : {}),
                    targetSessionKey: canonicalRequesterSessionKey,
                    targetSessionId: requesterActivity.sessionId,
                    idempotencyKey: params.directIdempotencyKey,
                  }
                : undefined,
            expectFinal: true,
            timeoutMs: announceTimeoutMs,
          });
        },
      });
      if (!isCompletionDeliveryAllowed()) {
        return sourceOwnerChangedResult();
      }
    } catch (err) {
      if (err instanceof SourceOwnerChangedError) {
        return sourceOwnerChangedResult();
      }
      if (isPermanentAnnounceDeliveryError(err) && hasAnnounceSendEvidence(err)) {
        throw err;
      }
      if (
        params.expectsCompletionMessage &&
        (shouldDeliverAgentFinal || subagentDirectMessageCompletionRequiresMessageTool) &&
        isSubagentCompletion &&
        isIncompleteAnnounceAgentResultError(err)
      ) {
        const textDelivery = await tryTextCompletionDirectDelivery();
        if (textDelivery) {
          return textDelivery;
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

    const directAnnounceResult = getGatewayAgentResult(directAnnounceResponse);
    const directDeliveryFailure =
      (shouldDeliverAgentFinal || requiresMessageToolDelivery) && directAnnounceResult
        ? getAgentCommandDeliveryFailure(directAnnounceResult)
        : undefined;
    if (directDeliveryFailure) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
        ...(directAnnounceResult && hasPayloadOutcomeSendEvidence(directAnnounceResult)
          ? { disposition: "ambiguous" as const }
          : {}),
      };
    }
    const hasMessagingToolDelivery = Boolean(
      directAnnounceResult &&
      hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget),
    );
    const completionPayloadVisibility = {
      includeErrorPayloads: false,
      includeReasoningPayloads: false,
    };
    const hasVisibleGatewayPayload = Boolean(
      directAnnounceResult &&
      (hasVisibleAgentPayload(directAnnounceResult, completionPayloadVisibility) ||
        hasMessagingToolDelivery),
    );
    const hasVisibleNonSilentGatewayPayload = Boolean(
      directAnnounceResult &&
      hasVisibleAgentPayload(directAnnounceResult, {
        ...completionPayloadVisibility,
        includeSilentReplyPayloads: false,
      }),
    );
    const hasIntentionalSilentCompletionReply = Boolean(
      directAnnounceResult && hasIntentionalSilentAgentPayload(directAnnounceResult),
    );
    const hasCompletionSideEffect = Boolean(
      directAnnounceResult && hasCommittedOutboundDeliveryEvidence(directAnnounceResult),
    );
    const hasVisibleRequiredCompletionReply =
      hasMessagingToolDelivery ||
      (!requiresMessageToolDelivery && hasVisibleNonSilentGatewayPayload);
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleNonSilentGatewayPayload &&
      !hasMessagingToolDelivery
    ) {
      const textDelivery = await tryTextCompletionDirectDelivery();
      if (textDelivery) {
        return textDelivery;
      }
      if (hasRequiredSubagentNoOutputCompletion && !hasCompletionSideEffect) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      hasRequiredSubagentNoOutputCompletion &&
      !hasVisibleRequiredCompletionReply &&
      hasCompletionSideEffect
    ) {
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
        error: "completion agent did not produce a visible reply",
        disposition: "permanent_failure",
      };
    }
    if (
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasMessagingToolDelivery &&
      (!hasIntentionalSilentCompletionReply ||
        subagentDirectMessageCompletionRequiresMessageTool ||
        hasRequiredSubagentNoOutputCompletion)
    ) {
      if (hasRequiredSubagentNoOutputCompletion) {
        return {
          delivered: false,
          path: "direct",
          reason: "visible_reply_missing",
          error: "completion agent did not produce a visible reply",
        };
      }
      if (subagentDirectMessageCompletionRequiresMessageTool) {
        const textDelivery = await tryTextCompletionDirectDelivery();
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
    const hasVisibleCompletionReply = Boolean(
      directAnnounceResult &&
      ((params.requireVisibleReply
        ? hasMessagingToolDeliveryToSource(directAnnounceResult, deliveryTarget, {
            requireFinalReply: true,
          })
        : hasMessagingToolDelivery) ||
        (hasVisibleAgentPayload(
          params.requireVisibleReply
            ? {
                payloads: Array.isArray(directAnnounceResult.payloads)
                  ? directAnnounceResult.payloads.filter((payload) => {
                      const flags = payload as Record<string, unknown>;
                      return (
                        flags?.isCommentary !== true &&
                        flags?.isCompactionNotice !== true &&
                        flags?.isFallbackNotice !== true &&
                        flags?.isStatusNotice !== true &&
                        flags?.visible !== false
                      );
                    })
                  : [],
              }
            : directAnnounceResult,
          { ...completionPayloadVisibility, includeSilentReplyPayloads: false },
        ) &&
          (!params.requireVisibleReply ||
            directAnnounceResult.deliveryStatus?.status !== "suppressed"))),
    );
    const acceptsIntentionalSilentCompletion =
      hasIntentionalSilentCompletionReply && !isSubagentCompletion;
    if (
      !hasVisibleCompletionReply &&
      (params.requireVisibleReply ||
        (params.expectsCompletionMessage &&
          !shouldDeliverAgentFinal &&
          !requiresMessageToolDelivery &&
          !hasCompletionSideEffect &&
          !acceptsIntentionalSilentCompletion))
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
      !hasVisibleGatewayPayload
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
    const permanent = isPermanentAnnounceDeliveryError(err);
    const disposition = permanent
      ? hasAnnounceSendEvidence(err)
        ? "ambiguous"
        : "permanent_failure"
      : "retryable";
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
      disposition,
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
  sourceRunId?: string;
  sourceChannel?: string;
  sourceTool?: string;
  isSourceSessionEffectsAllowed?: () => boolean;
  isCompletionOwnedByRequesterYield?: () => boolean;
  targetRequesterSessionKey: string;
  requesterIsSubagent: boolean;
  expectsCompletionMessage: boolean;
  requireDirectDelivery?: boolean;
  requireVisibleReply?: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
  const sourceOwnerChanged = () => params.isSourceSessionEffectsAllowed?.() === false;
  if (sourceOwnerChanged()) {
    return sourceOwnerChangedResult();
  }
  const durableGeneratedMediaHandoff =
    params.expectsCompletionMessage &&
    isAgentMediatedCompletionSourceTool(params.sourceTool) &&
    hasGeneratedMediaCompletionEvent(params.internalEvents);
  let durableQueueId: string | undefined;
  let durableQueueClaimed = false;
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
      const queuePayload = {
        kind: "agentTurn",
        sessionKey: canonicalSessionKey,
        message: formatAgentInternalEventsForPrompt(params.internalEvents) || params.triggerMessage,
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
      } as const;
      const queued = params.sourceRunId
        ? admitCorrelatedSubagentSessionDelivery({
            runId: params.sourceRunId,
            payload: queuePayload,
          })
        : await enqueueClaimedSessionDelivery(queuePayload, resolveSubagentAnnounceTimeoutMs(cfg));
      if (queued.status === "failed") {
        return {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_unavailable",
          error: "generated media session handoff was already dead-lettered",
          disposition: "permanent_failure",
        };
      }
      if (queued.status === "completed") {
        return { delivered: true, path: "queued", disposition: "delivered" };
      }
      durableQueueId = queued.id;
      durableQueueClaimed = queued.claimed;
    } catch (error) {
      defaultRuntime.log(
        `[warn] Generated media session handoff could not be persisted; refusing ambiguous fallback: ${summarizeDeliveryError(error)}`,
      );
      return {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        error: "generated media session handoff could not be persisted",
        disposition: "retryable",
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
    return { delivered: false, path: "queued", disposition: "session_queued" };
  }

  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    requireDirectDelivery: params.requireDirectDelivery,
    signal: params.signal,
    steer: async () => {
      if (sourceOwnerChanged()) {
        return { status: "source_owner_changed" };
      }
      return await maybeSteerSubagentAnnounce({
        deliveryTimeoutMs: resolveSubagentAnnounceTimeoutMs(
          subagentAnnounceDeliveryDeps.getRuntimeConfig(),
        ),
        requesterSessionKey: params.requesterSessionKey,
        steerMessage: params.steerMessage,
        signal: params.signal,
        isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
      });
    },
    direct: async () => {
      if (sourceOwnerChanged()) {
        return sourceOwnerChangedResult();
      }
      return await sendSubagentAnnounceDirectly({
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
        isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
        isCompletionOwnedByRequesterYield: params.isCompletionOwnedByRequesterYield,
        requesterIsSubagent: params.requesterIsSubagent,
        expectsCompletionMessage: params.expectsCompletionMessage,
        requireVisibleReply: params.requireVisibleReply,
        onDeliveryResult: params.onDeliveryResult,
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      });
    },
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
