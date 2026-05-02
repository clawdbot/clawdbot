import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
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
import { buildAnnounceIdempotencyKey, resolveQueueAnnounceId } from "./announce-idempotency.js";
import type { AgentInternalEvent } from "./internal-events.js";
import {
  getGatewayAgentResult,
  hasMessagingToolDeliveryEvidence,
  hasVisibleAgentPayload,
} from "./pi-embedded-runner/delivery-evidence.js";
import {
  callGateway,
  createBoundDeliveryRouter,
  getGlobalHookRunner,
  isEmbeddedPiRunActive,
  getRuntimeConfig,
  isSteeringQueueMode,
  loadSessionStore,
  queueEmbeddedPiMessage,
  resolvePiSteeringModeForQueueMode,
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
import { resolveAnnounceOrigin, type DeliveryContext } from "./subagent-announce-origin.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "./subagent-announce-queue.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

const DEFAULT_SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const MAX_TIMER_SAFE_TIMEOUT_MS = 2_147_000_000;

type SubagentAnnounceDeliveryDeps = {
  callGateway: typeof callGateway;
  getRuntimeConfig: typeof getRuntimeConfig;
  getRequesterSessionActivity: (requesterSessionKey: string) => {
    sessionId?: string;
    isActive: boolean;
  };
  queueEmbeddedPiMessage: typeof queueEmbeddedPiMessage;
  sendMessage: typeof sendMessage;
};

const defaultSubagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps = {
  callGateway,
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
  queueEmbeddedPiMessage,
  sendMessage,
};

let subagentAnnounceDeliveryDeps: SubagentAnnounceDeliveryDeps =
  defaultSubagentAnnounceDeliveryDeps;

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

  const route = router.resolveDestination({
    eventKind: "task_completion",
    targetSessionKey: params.requesterSessionKey,
    requester: requesterConversation,
    failClosed: true,
  });
  if (route.mode === "bound" && route.binding) {
    return mergeDeliveryContext(
      resolveBoundConversationOrigin({
        bindingConversation: route.binding.conversation,
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

async function sendAnnounce(item: AnnounceQueueItem) {
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const announceTimeoutMs = resolveSubagentAnnounceTimeoutMs(cfg);
  const requesterIsSubagent = isInternalAnnounceRequesterSession(item.sessionKey);
  const origin = item.origin;
  const threadId =
    origin?.threadId != null && origin.threadId !== ""
      ? stringifyRouteThreadId(origin.threadId)
      : undefined;
  const deliveryTarget = !requesterIsSubagent
    ? resolveExternalBestEffortDeliveryTarget({
        channel: origin?.channel,
        to: origin?.to,
        accountId: origin?.accountId,
        threadId,
      })
    : { deliver: false };
  const idempotencyKey = buildAnnounceIdempotencyKey(
    resolveQueueAnnounceId({
      announceId: item.announceId,
      sessionKey: item.sessionKey,
      enqueuedAt: item.enqueuedAt,
    }),
  );
  await subagentAnnounceDeliveryDeps.callGateway({
    method: "agent",
    params: {
      sessionKey: item.sessionKey,
      message: item.prompt,
      channel: deliveryTarget.deliver ? deliveryTarget.channel : undefined,
      accountId: deliveryTarget.deliver ? deliveryTarget.accountId : undefined,
      to: deliveryTarget.deliver ? deliveryTarget.to : undefined,
      threadId: deliveryTarget.deliver ? deliveryTarget.threadId : undefined,
      deliver: deliveryTarget.deliver,
      internalEvents: item.internalEvents,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: item.sourceSessionKey,
        sourceChannel: item.sourceChannel ?? INTERNAL_MESSAGE_CHANNEL,
        sourceTool: item.sourceTool ?? "subagent_announce",
      },
      idempotencyKey,
    },
    timeoutMs: announceTimeoutMs,
  });
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

function buildAnnounceQueueKey(sessionKey: string, origin?: DeliveryContext): string {
  const accountId = normalizeAccountId(origin?.accountId);
  if (!accountId) {
    return sessionKey;
  }
  return `${sessionKey}:acct:${accountId}`;
}

async function maybeQueueSubagentAnnounce(params: {
  requesterSessionKey: string;
  announceId?: string;
  triggerMessage: string;
  steerMessage: string;
  summaryLine?: string;
  requesterOrigin?: DeliveryContext;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
  internalEvents?: AgentInternalEvent[];
  signal?: AbortSignal;
}): Promise<"steered" | "queued" | "none" | "dropped"> {
  if (params.signal?.aborted) {
    return "none";
  }
  const { cfg, entry } = loadRequesterSessionEntry(params.requesterSessionKey);
  const canonicalKey = resolveRequesterStoreKey(cfg, params.requesterSessionKey);
  const { sessionId, isActive } = resolveRequesterSessionActivity(canonicalKey);
  if (!sessionId) {
    return "none";
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: entry?.channel ?? entry?.lastChannel ?? entry?.origin?.provider,
    sessionEntry: entry,
  });

  const shouldSteer = isSteeringQueueMode(queueSettings.mode);
  if (shouldSteer) {
    const steered = subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
      sessionId,
      params.steerMessage,
      {
        steeringMode: resolvePiSteeringModeForQueueMode(queueSettings.mode),
        ...(queueSettings.debounceMs !== undefined ? { debounceMs: queueSettings.debounceMs } : {}),
      },
    );
    if (steered) {
      return "steered";
    }
  }

  const shouldFollowup =
    queueSettings.mode === "followup" ||
    queueSettings.mode === "collect" ||
    queueSettings.mode === "steer-backlog" ||
    queueSettings.mode === "interrupt";
  if (
    isActive &&
    (shouldFollowup || queueSettings.mode === "steer" || queueSettings.mode === "queue")
  ) {
    const origin = resolveAnnounceOrigin(entry, params.requesterOrigin);
    const didQueue = enqueueAnnounce({
      key: buildAnnounceQueueKey(canonicalKey, origin),
      item: {
        announceId: params.announceId,
        prompt: params.triggerMessage,
        summaryLine: params.summaryLine,
        internalEvents: params.internalEvents,
        enqueuedAt: Date.now(),
        sessionKey: canonicalKey,
        origin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
      },
      settings: queueSettings,
      send: sendAnnounce,
      shouldDefer: (item) => resolveRequesterSessionActivity(item.sessionKey).isActive,
    });
    return didQueue ? "queued" : "dropped";
  }

  return "none";
}

export function extractThreadCompletionFallbackText(internalEvents?: AgentInternalEvent[]): string {
  if (!internalEvents || internalEvents.length === 0) {
    return "";
  }
  for (const event of internalEvents) {
    if (event.type !== "task_completion") {
      continue;
    }
    const result = event.result.trim();
    if (result) {
      return result;
    }
    const statusLabel = event.statusLabel.trim();
    const taskLabel = event.taskLabel.trim();
    if (statusLabel && taskLabel) {
      return `${taskLabel}: ${statusLabel}`;
    }
    if (statusLabel) {
      return statusLabel;
    }
    if (taskLabel) {
      return taskLabel;
    }
  }
  return "";
}

function hasVisibleGatewayAgentPayload(response: unknown): boolean {
  const result = getGatewayAgentResult(response);
  return Boolean(
    result && (hasVisibleAgentPayload(result) || hasMessagingToolDeliveryEvidence(result)),
  );
}

async function sendCompletionFallback(params: {
  cfg: OpenClawConfig;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
  content: string;
  requesterSessionKey: string;
  bestEffortDeliver?: boolean;
  idempotencyKey: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const channel = params.channel?.trim();
  const to = params.to?.trim();
  const content = params.content.trim();
  if (!channel || !to || !content) {
    return false;
  }
  await runAnnounceDeliveryWithRetry({
    operation: params.threadId
      ? "completion direct thread fallback send"
      : "completion direct fallback send",
    signal: params.signal,
    run: async () =>
      await subagentAnnounceDeliveryDeps.sendMessage({
        cfg: params.cfg,
        channel,
        to,
        accountId: params.accountId,
        threadId: params.threadId,
        content,
        requesterSessionKey: params.requesterSessionKey,
        bestEffort: params.bestEffortDeliver,
        idempotencyKey: params.idempotencyKey,
        abortSignal: params.signal,
      }),
  });
  return true;
}

function resolveCompletionFallbackPath(threadId: string | undefined) {
  return threadId ? ("direct-thread-fallback" as const) : ("direct-fallback" as const);
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
    const completionFallbackText =
      params.expectsCompletionMessage && deliveryTarget.deliver
        ? extractThreadCompletionFallbackText(params.internalEvents)
        : "";
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    const requesterEntry = loadRequesterSessionEntry(params.targetRequesterSessionKey).entry;
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
      const woke = requesterActivity.sessionId
        ? subagentAnnounceDeliveryDeps.queueEmbeddedPiMessage(
            requesterActivity.sessionId,
            params.triggerMessage,
            {
              steeringMode: "all",
              ...(requesterQueueSettings.debounceMs !== undefined
                ? { debounceMs: requesterQueueSettings.debounceMs }
                : {}),
            },
          )
        : false;
      if (woke) {
        return {
          delivered: true,
          path: "steered",
        };
      }
      if (requesterActivity.isActive) {
        try {
          const didFallback = await sendCompletionFallback({
            cfg,
            channel: deliveryTarget.channel,
            to: deliveryTarget.to,
            accountId: deliveryTarget.accountId,
            threadId: deliveryTarget.threadId,
            content: completionFallbackText,
            requesterSessionKey: canonicalRequesterSessionKey,
            bestEffortDeliver: params.bestEffortDeliver,
            idempotencyKey: params.directIdempotencyKey,
            signal: params.signal,
          });
          if (didFallback) {
            return {
              delivered: true,
              path: resolveCompletionFallbackPath(deliveryTarget.threadId),
            };
          }
        } catch (err) {
          return {
            delivered: false,
            path: "direct",
            error: `active requester session could not be woken; fallback send failed: ${summarizeDeliveryError(err)}`,
          };
        }
        return {
          delivered: false,
          path: "direct",
          error: "active requester session could not be woken",
        };
      }
    }
    if (params.signal?.aborted) {
      return {
        delivered: false,
        path: "none",
      };
    }
    let directAnnounceResponse: unknown;
    try {
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: params.expectsCompletionMessage
          ? "completion direct announce agent call"
          : "direct announce agent call",
        signal: params.signal,
        run: async () =>
          await subagentAnnounceDeliveryDeps.callGateway({
            method: "agent",
            params: {
              sessionKey: canonicalRequesterSessionKey,
              message: params.triggerMessage,
              deliver: deliveryTarget.deliver,
              bestEffortDeliver: params.bestEffortDeliver,
              internalEvents: params.internalEvents,
              channel: deliveryTarget.deliver ? deliveryTarget.channel : sessionOnlyOriginChannel,
              accountId: deliveryTarget.deliver
                ? deliveryTarget.accountId
                : sessionOnlyOriginChannel
                  ? sessionOnlyOrigin?.accountId
                  : undefined,
              to: deliveryTarget.deliver
                ? deliveryTarget.to
                : sessionOnlyOriginChannel
                  ? sessionOnlyOrigin?.to
                  : undefined,
              threadId: deliveryTarget.deliver
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
              idempotencyKey: params.directIdempotencyKey,
            },
            expectFinal: true,
            timeoutMs: announceTimeoutMs,
          }),
      });
    } catch (err) {
      if (isPermanentAnnounceDeliveryError(err)) {
        throw err;
      }
      let didFallback = false;
      try {
        didFallback = await sendCompletionFallback({
          cfg,
          channel: deliveryTarget.channel,
          to: deliveryTarget.to,
          accountId: deliveryTarget.accountId,
          threadId: deliveryTarget.threadId,
          content: completionFallbackText,
          requesterSessionKey: canonicalRequesterSessionKey,
          bestEffortDeliver: params.bestEffortDeliver,
          idempotencyKey: params.directIdempotencyKey,
          signal: params.signal,
        });
      } catch (fallbackErr) {
        throw new Error(
          `${summarizeDeliveryError(err)}; fallback send failed: ${summarizeDeliveryError(fallbackErr)}`,
          { cause: fallbackErr },
        );
      }
      if (didFallback) {
        return {
          delivered: true,
          path: resolveCompletionFallbackPath(deliveryTarget.threadId),
        };
      }
      throw err;
    }

    if (completionFallbackText && !hasVisibleGatewayAgentPayload(directAnnounceResponse)) {
      const didFallback = await sendCompletionFallback({
        cfg,
        channel: deliveryTarget.channel,
        to: deliveryTarget.to,
        accountId: deliveryTarget.accountId,
        threadId: deliveryTarget.threadId,
        content: completionFallbackText,
        requesterSessionKey: canonicalRequesterSessionKey,
        bestEffortDeliver: params.bestEffortDeliver,
        idempotencyKey: params.directIdempotencyKey,
        signal: params.signal,
      });
      if (didFallback) {
        return {
          delivered: true,
          path: resolveCompletionFallbackPath(deliveryTarget.threadId),
        };
      }
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
    queue: async () =>
      await maybeQueueSubagentAnnounce({
        requesterSessionKey: params.requesterSessionKey,
        announceId: params.announceId,
        triggerMessage: params.triggerMessage,
        steerMessage: params.steerMessage,
        summaryLine: params.summaryLine,
        requesterOrigin: params.requesterOrigin,
        sourceSessionKey: params.sourceSessionKey,
        sourceChannel: params.sourceChannel,
        sourceTool: params.sourceTool,
        internalEvents: params.internalEvents,
        signal: params.signal,
      }),
    direct: async () =>
      await sendSubagentAnnounceDirectly({
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
  setDepsForTest(overrides?: Partial<SubagentAnnounceDeliveryDeps>) {
    subagentAnnounceDeliveryDeps = overrides
      ? {
          ...defaultSubagentAnnounceDeliveryDeps,
          ...overrides,
        }
      : defaultSubagentAnnounceDeliveryDeps;
  },
};
