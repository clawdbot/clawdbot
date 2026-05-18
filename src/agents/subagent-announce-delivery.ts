import { completionRequiresMessageToolDelivery } from "../auto-reply/reply/completion-delivery-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { isNonTerminalAgentRunStatus } from "../shared/agent-run-status.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { mediaUrlsFromGeneratedAttachments } from "./generated-attachments.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  getAgentCommandDeliveryFailure,
  getGatewayAgentResult,
  hasDeliveredExpectedMedia,
  hasMessagingToolDeliveryEvidence,
  hasVisibleAgentPayload,
} from "./pi-embedded-runner/delivery-evidence.js";
import type { EmbeddedPiQueueMessageOptions } from "./pi-embedded-runner/run-state.js";
import type { EmbeddedPiQueueMessageOutcome } from "./pi-embedded-runner/runs.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  dispatchGatewayMethodInProcess,
  getGlobalHookRunner,
  isEmbeddedPiRunActive,
  getRuntimeConfig,
  formatEmbeddedPiQueueFailureSummary,
  loadSessionStore,
  queueEmbeddedPiMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
  resolveAgentIdFromSessionKey,
  resolveConversationIdFromTargets,
  resolveExternalBestEffortDeliveryTarget,
  resolveQueueSettings,
  resolveStorePath,
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
const AGENT_MEDIATED_COMPLETION_TOOLS = new Set([
  "image_generate",
  "music_generate",
  "subagent_announce",
  "video_generate",
]);

type SubagentAnnounceDeliveryDeps = {
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
  };
  queueEmbeddedPiMessageWithOutcome: (
    sessionId: string,
    text: string,
    options?: EmbeddedPiQueueMessageOptions,
  ) => EmbeddedPiQueueMessageOutcome | Promise<EmbeddedPiQueueMessageOutcome>;
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
      isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
    };
  },
  queueEmbeddedPiMessageWithOutcome: queueEmbeddedPiMessageWithOutcomeAsync,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

async function resolveQueueEmbeddedPiMessageOutcome(
  sessionId: string,
  text: string,
  options?: EmbeddedPiQueueMessageOptions,
): Promise<EmbeddedPiQueueMessageOutcome> {
  return await subagentAnnounceDeliveryDeps.queueEmbeddedPiMessageWithOutcome(
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
      timeoutMs: params.timeoutMs,
    },
  );
}

function formatQueueWakeFailureError(
  fallback: string,
  outcome: EmbeddedPiQueueMessageOutcome,
): string {
  const summary = formatEmbeddedPiQueueFailureSummary(outcome);
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

  const boundTarget = resolveConversationDeliveryTarget({
    channel: conversation.channel,
    conversationId,
    parentConversationId,
  });
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
    isActive: Boolean(sessionId && isEmbeddedPiRunActive(sessionId)),
  };
}

function resolveDirectAnnounceTransientRetryDelaysMs() {
  return process.env.OPENCLAW_TEST_FAST === "1"
    ? ([8, 16, 32] as const)
    : ([5_000, 10_000, 20_000] as const);
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
      ? stringifyRouteThreadId(requesterOrigin.threadId)
      : undefined;
  const conversationId =
    threadId ||
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
  const { sessionId } = resolveRequesterSessionActivity(canonicalKey);
  if (!sessionId) {
    return { status: "none" };
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
    sessionEntry: entry,
  });

  // Subagent announcements are internal handoffs into an active requester turn.
  // Queue modes such as followup/collect apply to user prompts, not this path.
  const queueOptions: EmbeddedPiQueueMessageOptions = {
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    steeringMode: "all",
    ...(queueSettings.debounceMs !== undefined ? { debounceMs: queueSettings.debounceMs } : {}),
    waitForTranscriptCommit: true,
  };
  let queueOutcome = await resolveQueueEmbeddedPiMessageOutcome(
    sessionId,
    params.steerMessage,
    queueOptions,
  );
  if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
    const bestEffortQueueOptions = { ...queueOptions };
    delete bestEffortQueueOptions.waitForTranscriptCommit;
    queueOutcome = await resolveQueueEmbeddedPiMessageOutcome(
      sessionId,
      params.steerMessage,
      bestEffortQueueOptions,
    );
  }
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

function requiresAgentMediatedCompletionDelivery(params: {
  expectsCompletionMessage: boolean;
  sourceTool?: string;
}): boolean {
  return (
    params.expectsCompletionMessage &&
    AGENT_MEDIATED_COMPLETION_TOOLS.has(normalizeOptionalLowercaseString(params.sourceTool) ?? "")
  );
}

function hasGatewayAgentMessagingToolDelivery(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(result && hasMessagingToolDeliveryEvidence(result));
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
    const agentMediatedCompletion = requiresAgentMediatedCompletionDelivery({
      expectsCompletionMessage: params.expectsCompletionMessage,
      sourceTool: params.sourceTool,
    });
    const expectedMediaUrls = collectExpectedMediaFromInternalEvents(params.internalEvents);
    const requiresMessageToolDelivery =
      agentMediatedCompletion &&
      (expectedMediaUrls.length > 0 ||
        completionRequiresMessageToolDelivery({
          cfg,
          requesterSessionKey: params.requesterSessionKey,
          targetRequesterSessionKey: canonicalRequesterSessionKey,
          requesterEntry,
          directOrigin: effectiveDirectOrigin,
          requesterSessionOrigin,
        }));
    const completionSourceReplyDeliveryMode = requiresMessageToolDelivery
      ? "message_tool_only"
      : undefined;
    const shouldDeliverAgentFinal = deliveryTarget.deliver && !requiresMessageToolDelivery;
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
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
    if (params.expectsCompletionMessage && requesterActivity.sessionId) {
      const wakeOutcome = await resolveQueueEmbeddedPiMessageOutcome(
        requesterActivity.sessionId,
        params.triggerMessage,
        {
          deliveryTimeoutMs: announceTimeoutMs,
          steeringMode: "all",
          ...(completionSourceReplyDeliveryMode
            ? { sourceReplyDeliveryMode: completionSourceReplyDeliveryMode }
            : {}),
          ...(requesterQueueSettings.debounceMs !== undefined
            ? { debounceMs: requesterQueueSettings.debounceMs }
            : {}),
          waitForTranscriptCommit: true,
        },
      );
      if (wakeOutcome.queued) {
        return {
          delivered: true,
          deliveredAt: wakeOutcome.deliveredAtMs,
          enqueuedAt: wakeOutcome.enqueuedAtMs,
          path: "steered",
        };
      }
      if (requesterActivity.isActive) {
        defaultRuntime.log(
          `[warn] Active requester session could not be woken for subagent completion; falling back to requester-agent handoff: ${formatQueueWakeFailureError(
            "active requester session could not be woken",
            wakeOutcome,
          )}`,
        );
      }
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
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
      threadId: shouldDeliverAgentFinal
        ? deliveryTarget.threadId
        : sessionOnlyOriginChannel
          ? sessionOnlyOrigin?.threadId
          : undefined,
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

    if (
      requiresMessageToolDelivery &&
      !hasGatewayAgentMessagingToolDelivery(directAnnounceResponse)
    ) {
      return {
        delivered: false,
        path: "direct",
        error: "completion agent did not deliver through the message tool",
      };
    }
    if (
      agentMediatedCompletion &&
      expectedMediaUrls.length > 0 &&
      !hasGatewayAgentDeliveredExpectedMedia(directAnnounceResponse, expectedMediaUrls)
    ) {
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

export const __testing = {
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
