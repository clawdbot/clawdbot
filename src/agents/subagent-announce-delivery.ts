import { completionRequiresMessageToolDelivery } from "../auto-reply/reply/completion-delivery-policy.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded-read.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { routeFromConversationRef, routeToDeliveryFields } from "../channels/route-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import {
  isAgentMediatedCompletionSourceTool,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../sessions/input-provenance.js";
import { deriveSessionChatTypeFromKey } from "../sessions/session-chat-type-shared.js";
import { isCronRunSessionKey, isCronSessionKey } from "../sessions/session-key-utils.js";
import { isNonTerminalAgentRunStatus } from "../shared/agent-run-status.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeStringEntries, uniqueStrings } from "../shared/string-normalization.js";
import { mergeDeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import {
  collectMessagingToolDeliveredMediaUrls,
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasDeliveredExpectedMedia,
  hasMessagingToolDeliveryEvidence,
  hasVisibleAgentPayload,
} from "./embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentQueueMessageOptions } from "./embedded-agent-runner/run-state.js";
import type { EmbeddedAgentQueueMessageOutcome } from "./embedded-agent-runner/runs.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import type { AgentInternalEvent } from "./internal-events.js";
import { isSessionWriteLockTimeoutError } from "./session-write-lock-error.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  dispatchGatewayMethodInProcess,
  getGlobalHookRunner,
  isEmbeddedAgentRunActive,
  isEmbeddedRunAbandoned,
  getRuntimeConfig,
  formatEmbeddedAgentQueueFailureSummary,
  loadSessionStore,
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
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;
type SubagentAnnounceDeliveryDeps = {
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
  };
  isRequesterSessionAbandoned: (requesterSessionKey: string, sessionId?: string) => boolean;
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
  if (
    conversation.channel === "matrix" &&
    parentConversationId &&
    requesterConversationId &&
    parentConversationId === requesterConversationId &&
    requesterTo
  ) {
    return {
      channel: conversation.channel,
      accountId: conversation.accountId,
      to: requesterTo,
      ...(conversationId ? { threadId: conversationId } : {}),
    };
  }

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
  return process.env.OPENCLAW_TEST_FAST === "1"
    ? ([8, 16, 32] as const)
    : ([5_000, 10_000, 20_000] as const);
}

// Backoff schedule for re-attempting an active-requester steer while the run is
// compacting. Compaction is transient and usually finishes quickly, so a denser
// schedule is used than for transient delivery errors. Total wait stays well
// within the announce delivery timeout, and the loop also stops on cancellation.
function resolveCompactionSteerRetryDelaysMs() {
  return process.env.OPENCLAW_TEST_FAST === "1"
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
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(configured)), MAX_TIMER_SAFE_TIMEOUT_MS);
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
];

function isTransientAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  if (!message) {
    return false;
  }
  if (PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message))) {
    return false;
  }
  return TRANSIENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message));
}

function isPermanentAnnounceDeliveryError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return Boolean(
    message && PERMANENT_ANNOUNCE_DELIVERY_ERROR_PATTERNS.some((re) => re.test(message)),
  );
}

function isIncompleteAnnounceAgentResultError(error: unknown): boolean {
  const message = summarizeDeliveryError(error);
  return /(?:incomplete terminal response|code=incomplete_result)\b/i.test(message);
}

function isSessionWriteLockAnnounceAgentError(error: unknown): boolean {
  if (isSessionWriteLockTimeoutError(error)) {
    return true;
  }
  const message = summarizeDeliveryError(error);
  return (
    /\bSessionWriteLockTimeoutError\b/.test(message) || /\bsession file locked\b/i.test(message)
  );
}

async function waitForAnnounceRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
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
  run: () => Promise<T>;
}): Promise<T> {
  const retryDelaysMs = resolveDirectAnnounceTransientRetryDelaysMs();
  let retryIndex = 0;
  for (;;) {
    if (params.signal?.aborted) {
      throw new Error("announce delivery aborted");
    }
    try {
      return await params.run();
    } catch (err) {
      const delayMs = retryDelaysMs[retryIndex];
      if (delayMs == null || !isTransientAnnounceDeliveryError(err) || params.signal?.aborted) {
        throw err;
      }
      const nextAttempt = retryIndex + 2;
      const maxAttempts = retryDelaysMs.length + 1;
      defaultRuntime.log(
        `[warn] Subagent announce ${params.operation} transient failure, retrying ${nextAttempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s: ${summarizeDeliveryError(err)}`,
      );
      retryIndex += 1;
      await waitForAnnounceRetryDelay(delayMs, params.signal);
    }
  }
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
  const store = loadSessionStore(storePath);
  const entry = store[canonicalKey];
  return { cfg, entry, canonicalKey };
}

export function loadSessionEntryByKey(sessionKey: string) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  return store[sessionKey];
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
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
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

  const currentActivity = resolveRequesterSessionActivity(canonicalKey);
  return { status: currentActivity.isActive ? "dropped" : "none" };
}

function hasVisibleGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(
    result && (hasVisibleAgentPayload(result) || hasMessagingToolDeliveryEvidence(result)),
  );
}

function hasGatewayAgentMessagingToolDeliveryEvidence(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(result && hasMessagingToolDeliveryEvidence(result));
}

function hasIntentionalSilentGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  if (!result || !Array.isArray(result.payloads)) {
    return false;
  }
  return result.payloads.some((payload) => {
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
  });
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

function hasGatewayAgentDeliveredExpectedMedia(
  response: unknown,
  expectedMediaUrls: readonly string[],
): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(result && hasDeliveredExpectedMedia(result, expectedMediaUrls));
}

function hasGatewayAgentMessagingToolDeliveredExpectedMedia(
  response: unknown,
  expectedMediaUrls: readonly string[],
): boolean {
  const expected = uniqueStrings(normalizeStringEntries(expectedMediaUrls));
  if (expected.length === 0) {
    return true;
  }
  const result = getGatewayAgentResult(response);
  if (!result) {
    return false;
  }
  const delivered = new Set(collectMessagingToolDeliveredMediaUrls(result));
  return expected.every((url) => delivered.has(url));
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
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  if (
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    params.mediaUrls.length === 0
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
      content: `The generated ${mediaLabel} is ready.`,
      mediaUrls: Array.from(params.mediaUrls),
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
      error: `generated media direct delivery failed: ${summarizeDeliveryError(err)}`,
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
}): string[] {
  const expected = uniqueStrings(normalizeStringEntries(params.expectedMediaUrls));
  const result = getGatewayAgentResult(params.announceResponse);
  if (!result) {
    return expected;
  }
  const delivered = new Set(collectMessagingToolDeliveredMediaUrls(result));
  return expected.filter((url) => !delivered.has(url));
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

async function sendSubagentAnnounceDirectly(params: {
  requesterSessionKey: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
  internalEvents?: AgentInternalEvent[];
  expectsCompletionMessage: boolean;
  bestEffortDeliver?: boolean;
  directIdempotencyKey: string;
  completionDirectOrigin?: DeliveryContext;
  directOrigin?: DeliveryContext;
  requesterSessionOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  requesterIsSubagent: boolean;
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
    const completionDirectOrigin = normalizeDeliveryContext(params.completionDirectOrigin);
    const directOrigin = normalizeDeliveryContext(params.directOrigin);
    const requesterSessionOrigin = normalizeDeliveryContext(params.requesterSessionOrigin);
    // Merge completionDirectOrigin with directOrigin so that missing fields
    // (channel, to, accountId) fall back to the originating session's
    // lastChannel / lastTo. Without this, a completion origin that carries a
    // channel but not a `to` would prevent external delivery.
    const externalCompletionDirectOrigin =
      stripNonDeliverableChannelForCompletionOrigin(completionDirectOrigin);
    const completionExternalFallbackOrigin = mergeDeliveryContext(
      directOrigin,
      requesterSessionOrigin,
    );
    const effectiveDirectOrigin = params.expectsCompletionMessage
      ? mergeDeliveryContext(externalCompletionDirectOrigin, completionExternalFallbackOrigin)
      : directOrigin;
    const sessionOnlyOrigin = effectiveDirectOrigin?.channel
      ? effectiveDirectOrigin
      : requesterSessionOrigin;
    const requesterEntry = loadRequesterSessionEntry(params.targetRequesterSessionKey).entry;
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
    const requiresMessageToolDelivery =
      completionRouteRequiresMessageToolDelivery ||
      (agentMediatedCompletion && expectedMediaUrls.length > 0);
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
        error: "requester session abandoned after timeout",
      };
    }
    let activeRequesterWakeFailed = false;
    const tryGeneratedMediaDirectDelivery = async (announceResponse?: unknown) => {
      if (requesterActivity.isActive && !activeRequesterWakeFailed) {
        return undefined;
      }
      const missingMediaUrls = resolveGeneratedMediaDirectFallbackUrls({
        expectedMediaUrls,
        announceResponse,
      });
      return await deliverGeneratedMediaCompletionDirect({
        cfg,
        requesterSessionKey: canonicalRequesterSessionKey,
        directIdempotencyKey: params.directIdempotencyKey,
        deliveryTarget,
        mediaUrls: missingMediaUrls,
        internalEvents: params.internalEvents,
        sourceTool: params.sourceTool,
      });
    };
    const completionSourceReplyDeliveryMode = requiresMessageToolDelivery
      ? "message_tool_only"
      : undefined;
    const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
    const requesterQueueSettings = resolveQueueSettings({
      cfg,
      channel:
        requesterEntry?.channel ??
        requesterEntry?.lastChannel ??
        requesterEntry?.origin?.provider ??
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
      !resolveRequesterSessionActivity(canonicalRequesterSessionKey).isActive
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
        run: async () =>
          await runAnnounceAgentCall({
            agentParams: directAgentParams,
            expectFinal: true,
            timeoutMs: announceTimeoutMs,
          }),
      });
    } catch (err) {
      if (isPermanentAnnounceDeliveryError(err)) {
        throw err;
      }
      if (
        params.expectsCompletionMessage &&
        shouldDeliverAgentFinal &&
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
        activeRequesterWakeFailed &&
        agentMediatedCompletion &&
        expectedMediaUrls.length > 0 &&
        isSessionWriteLockAnnounceAgentError(err)
      ) {
        const generatedMediaDelivery = await tryGeneratedMediaDirectDelivery();
        if (generatedMediaDelivery) {
          return generatedMediaDelivery;
        }
      }
      // The requester-agent handoff is the delivery contract for background
      // completions. A failed handoff should retry/fail visibly instead
      // of sending the child result directly to the external channel.
      throw err;
    }

    const directAnnounceStillPending = isGatewayAgentRunPending(directAnnounceResponse);
    if (directAnnounceStillPending) {
      if (
        params.expectsCompletionMessage &&
        expectedMediaUrls.length === 0 &&
        !requiresMessageToolDelivery
      ) {
        return {
          delivered: false,
          path: "direct",
          error: "completion agent handoff is still pending",
        };
      }
      return {
        delivered: true,
        path: "direct",
      };
    }

    if (
      agentMediatedCompletion &&
      expectedMediaUrls.length > 0 &&
      !(requiresMessageToolDelivery
        ? hasGatewayAgentMessagingToolDeliveredExpectedMedia(
            directAnnounceResponse,
            expectedMediaUrls,
          )
        : hasGatewayAgentDeliveredExpectedMedia(directAnnounceResponse, expectedMediaUrls))
    ) {
      const generatedMediaDelivery = await tryGeneratedMediaDirectDelivery(directAnnounceResponse);
      if (generatedMediaDelivery) {
        return generatedMediaDelivery;
      }
      return {
        delivered: false,
        path: "direct",
        error: "completion agent did not deliver generated media",
      };
    }
    const directDeliveryFailure = shouldDeliverAgentFinal
      ? getGatewayAgentCommandDeliveryFailure(directAnnounceResponse)
      : undefined;
    if (directDeliveryFailure) {
      return {
        delivered: false,
        path: "direct",
        error: directDeliveryFailure,
      };
    }
    if (
      params.expectsCompletionMessage &&
      shouldDeliverAgentFinal &&
      isSubagentCompletion &&
      !hasVisibleGatewayAgentPayload(directAnnounceResponse) &&
      !hasGatewayAgentMessagingToolDeliveryEvidence(directAnnounceResponse) &&
      !hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse)
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
          error: "completion agent did not produce a visible reply",
        };
      }
    }
    if (
      params.expectsCompletionMessage &&
      requiresMessageToolDelivery &&
      !hasGatewayAgentMessagingToolDeliveryEvidence(directAnnounceResponse) &&
      !hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse)
    ) {
      return {
        delivered: false,
        path: "direct",
        error: "completion agent did not use the message tool for message-tool-only delivery",
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
        error: "completion agent did not produce a visible reply",
      };
    }

    return {
      delivered: true,
      path: "direct",
    };
  } catch (err) {
    return {
      delivered: false,
      path: "direct",
      error: summarizeDeliveryError(err),
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
  directIdempotencyKey: string;
  signal?: AbortSignal;
}): Promise<SubagentAnnounceDeliveryResult> {
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
        signal: params.signal,
        bestEffortDeliver: params.bestEffortDeliver,
      }),
  });
}

export const testing = {
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
};
export { testing as __testing };
