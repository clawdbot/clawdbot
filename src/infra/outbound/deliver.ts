import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendAttemptContext,
  ChannelMessageSendAttemptKind,
  ChannelMessageSendLifecycleAdapter,
  ChannelMessageSendResult,
} from "../../channels/message/types.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type {
  ChannelDeliveryCapabilities,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ChannelOutboundTargetRef,
} from "../../channels/plugins/types.adapters.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { ReplyToMode } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import {
  hasReplyPayloadContent,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type ReplyPayloadDeliveryPin,
} from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import { emitDiagnosticEvent, type DiagnosticMessageDeliveryKind } from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import {
  attachOutboundDeliveryCommitHook,
  runOutboundDeliveryCommitHooks,
  type OutboundDeliveryCommitHook,
} from "./delivery-commit-hooks.js";
import {
  ackDelivery,
  enqueueDelivery,
  failDelivery,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  type QueuedRenderedMessageBatchPlan,
  withActiveDeliveryClaim,
} from "./delivery-queue.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import {
  planOutboundMediaMessageUnits,
  planOutboundTextMessageUnits,
  type OutboundMessageSendOverrides,
} from "./message-plan.js";
import type { DeliveryMirror } from "./mirror.js";
import {
  createOutboundPayloadPlan,
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
  type OutboundPayloadPlan,
} from "./payloads.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";
import { stripInternalRuntimeScaffolding } from "./sanitize-text.js";
import { type OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type { OutboundDeliveryResult } from "./deliver-types.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";

export type OutboundDeliveryQueuePolicy = "required" | "best_effort";

export type OutboundDeliveryIntent = {
  id: string;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
};

export type DurableFinalDeliveryRequirement = keyof NonNullable<
  ChannelDeliveryCapabilities["durableFinal"]
>;

export type DurableFinalDeliveryRequirements = Partial<
  Record<DurableFinalDeliveryRequirement, boolean>
>;

export type OutboundDurableDeliverySupport =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_outbound_handler" | "capability_mismatch";
      capability?: DurableFinalDeliveryRequirement;
    };

const log = createSubsystemLogger("outbound/deliver");
let transcriptRuntimePromise:
  | Promise<typeof import("../../config/sessions/transcript.runtime.js")>
  | undefined;

async function loadTranscriptRuntime() {
  transcriptRuntimePromise ??= import("../../config/sessions/transcript.runtime.js");
  return await transcriptRuntimePromise;
}

let channelBootstrapRuntimePromise:
  | Promise<typeof import("./channel-bootstrap.runtime.js")>
  | undefined;

async function loadChannelBootstrapRuntime() {
  channelBootstrapRuntimePromise ??= import("./channel-bootstrap.runtime.js");
  return await channelBootstrapRuntimePromise;
}

type ChannelHandler = {
  chunker: ChannelOutboundAdapter["chunker"] | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  supportsMedia: boolean;
  sanitizeText?: (payload: ReplyPayload) => string;
  normalizePayload?: (payload: ReplyPayload) => ReplyPayload | null;
  sendTextOnlyErrorPayloads?: boolean;
  renderPresentation?: (payload: ReplyPayload) => Promise<ReplyPayload | null>;
  pinDeliveredMessage?: (params: {
    target: ChannelOutboundTargetRef;
    messageId: string;
    pin: ReplyPayloadDeliveryPin;
  }) => Promise<void>;
  afterDeliverPayload?: (params: {
    target: ChannelOutboundTargetRef;
    payload: ReplyPayload;
    results: readonly OutboundDeliveryResult[];
  }) => Promise<void>;
  buildTargetRef: (overrides?: { threadId?: string | number | null }) => ChannelOutboundTargetRef;
  shouldSkipPlainTextSanitization?: (payload: ReplyPayload) => boolean;
  resolveEffectiveTextChunkLimit?: (fallbackLimit?: number) => number | undefined;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (
    text: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    caption: string,
    mediaUrl: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: OutboundMessageSendOverrides,
  ) => Promise<OutboundDeliveryResult>;
};

type ChannelMessageLifecycleContext = ChannelMessageSendAttemptContext;

type ChannelHandlerParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mediaAccess?: OutboundMediaAccess;
  gatewayClientScopes?: readonly string[];
  onPlatformSendStart?: () => Promise<void>;
};

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function resolveChannelOutboundDirectiveOptions(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
}): Promise<{ extractMarkdownImages?: boolean }> {
  const outbound = await loadBootstrappedOutboundAdapter(params);
  return {
    extractMarkdownImages: outbound?.extractMarkdownImages === true ? true : undefined,
  };
}

async function createChannelHandler(params: ChannelHandlerParams): Promise<ChannelHandler> {
  const outbound = await loadBootstrappedOutboundAdapter(params);
  const message = resolveOutboundChannelMessageAdapter(params);
  const handler = createPluginHandler({ ...params, outbound, message });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

async function loadBootstrappedOutboundAdapter(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
}): Promise<ChannelOutboundAdapter | undefined> {
  let outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound) {
    const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
    bootstrapOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.cfg,
    });
    outbound = await loadChannelOutboundAdapter(params.channel);
  }
  return outbound;
}

async function runChannelMessageSendWithLifecycle<
  TResult extends ChannelMessageSendResult,
>(params: {
  lifecycle?: ChannelMessageSendLifecycleAdapter;
  ctx: ChannelMessageLifecycleContext;
  send: () => Promise<TResult>;
}): Promise<{ result: TResult; afterCommit?: OutboundDeliveryCommitHook }> {
  if (!params.lifecycle) {
    return { result: await params.send() };
  }
  let attemptToken: unknown;
  try {
    attemptToken = await params.lifecycle.beforeSendAttempt?.(params.ctx);
    const result = await params.send();
    const successCtx = {
      ...params.ctx,
      result,
      ...(attemptToken !== undefined ? { attemptToken } : {}),
    };
    try {
      await params.lifecycle.afterSendSuccess?.(successCtx);
    } catch (successHookError: unknown) {
      log.warn(
        `channel message send success hook failed after platform send; preserving send result: ${formatErrorMessage(successHookError)}`,
      );
    }
    return {
      result,
      ...(params.lifecycle.afterCommit
        ? {
            afterCommit: async () => {
              await params.lifecycle?.afterCommit?.(successCtx);
            },
          }
        : {}),
    };
  } catch (error: unknown) {
    try {
      await params.lifecycle.afterSendFailure?.({
        ...params.ctx,
        error,
        ...(attemptToken !== undefined ? { attemptToken } : {}),
      });
    } catch (cleanupError: unknown) {
      log.warn(
        `channel message send failure cleanup failed; preserving original send error: ${formatErrorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export async function resolveOutboundDurableFinalDeliverySupport(params: {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  requirements?: DurableFinalDeliveryRequirements;
}): Promise<OutboundDurableDeliverySupport> {
  const outbound = await loadBootstrappedOutboundAdapter(params);
  const message = resolveOutboundChannelMessageAdapter(params);
  if (!message?.send?.text && !outbound?.sendText) {
    return { ok: false, reason: "missing_outbound_handler" };
  }

  const messageDurableFinal = message?.durableFinal;
  const durableFinal =
    messageDurableFinal?.capabilities ?? outbound?.deliveryCapabilities?.durableFinal;
  for (const [capability, required] of Object.entries(params.requirements ?? {}) as Array<
    [DurableFinalDeliveryRequirement, boolean | undefined]
  >) {
    if (required === true && durableFinal?.[capability] !== true) {
      return { ok: false, reason: "capability_mismatch", capability };
    }
    if (
      required === true &&
      capability === "reconcileUnknownSend" &&
      typeof messageDurableFinal?.reconcileUnknownSend !== "function"
    ) {
      return { ok: false, reason: "capability_mismatch", capability };
    }
  }

  return { ok: true };
}

function createPluginHandler(
  params: ChannelHandlerParams & {
    outbound?: ChannelOutboundAdapter;
    message?: ChannelMessageAdapterShape;
  },
): ChannelHandler | null {
  const outbound = params.outbound;
  const messageText = params.message?.send?.text;
  const messageMedia = params.message?.send?.media;
  const messagePayload = params.message?.send?.payload;
  const messageLifecycle = params.message?.send?.lifecycle;
  if (!messageText && !outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound?.sendText;
  const sendMedia = outbound?.sendMedia;
  const chunker = outbound?.chunker ?? null;
  const chunkerMode = outbound?.chunkerMode;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    replyToIdSource?: "explicit" | "implicit";
    threadId?: string | number | null;
    audioAsVoice?: boolean;
  }): Omit<ChannelOutboundContext, "text" | "mediaUrl"> => ({
    ...baseCtx,
    replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
    replyToIdSource:
      overrides && "replyToIdSource" in overrides
        ? overrides.replyToIdSource
        : baseCtx.replyToIdSource,
    threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
    audioAsVoice: overrides?.audioAsVoice,
  });
  const buildTargetRef = (overrides?: {
    threadId?: string | number | null;
  }): ChannelOutboundTargetRef => ({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId ?? undefined,
    threadId: overrides?.threadId ?? baseCtx.threadId,
  });
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound?.textChunkLimit,
    supportsMedia: Boolean(messageMedia ?? sendMedia),
    sanitizeText: outbound?.sanitizeText
      ? (payload) => outbound.sanitizeText!({ text: payload.text ?? "", payload })
      : undefined,
    normalizePayload: outbound?.normalizePayload
      ? (payload) => outbound.normalizePayload!({ payload })
      : undefined,
    sendTextOnlyErrorPayloads: outbound?.sendTextOnlyErrorPayloads === true,
    renderPresentation: outbound?.renderPresentation
      ? async (payload) => {
          const presentation = normalizeMessagePresentation(payload.presentation);
          if (!presentation) {
            return payload;
          }
          const ctx: ChannelOutboundPayloadContext = {
            ...resolveCtx({
              replyToId: payload.replyToId ?? baseCtx.replyToId,
              threadId: baseCtx.threadId,
              audioAsVoice: payload.audioAsVoice,
            }),
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            payload,
          };
          return await outbound.renderPresentation!({ payload, presentation, ctx });
        }
      : undefined,
    pinDeliveredMessage: outbound?.pinDeliveredMessage
      ? async ({ target, messageId, pin }) =>
          outbound.pinDeliveredMessage!({
            cfg: params.cfg,
            target,
            messageId,
            pin,
          })
      : undefined,
    afterDeliverPayload: outbound?.afterDeliverPayload
      ? async ({ target, payload, results }) =>
          outbound.afterDeliverPayload!({
            cfg: params.cfg,
            target,
            payload,
            results,
          })
      : undefined,
    shouldSkipPlainTextSanitization: outbound?.shouldSkipPlainTextSanitization
      ? (payload) => outbound.shouldSkipPlainTextSanitization!({ payload })
      : undefined,
    resolveEffectiveTextChunkLimit: outbound?.resolveEffectiveTextChunkLimit
      ? (fallbackLimit) =>
          outbound.resolveEffectiveTextChunkLimit!({
            cfg: params.cfg,
            accountId: params.accountId ?? undefined,
            fallbackLimit,
          })
      : undefined,
    sendPayload:
      messagePayload || outbound?.sendPayload
        ? async (payload, overrides) => {
            const payloadCtx = {
              ...resolveCtx(overrides),
              kind: "payload" as const satisfies ChannelMessageSendAttemptKind,
              text: payload.text ?? "",
              mediaUrl: payload.mediaUrl,
              payload,
            };
            if (messagePayload) {
              const sent = await runChannelMessageSendWithLifecycle({
                lifecycle: messageLifecycle,
                ctx: payloadCtx,
                send: async () => {
                  await params.onPlatformSendStart?.();
                  return await messagePayload(payloadCtx);
                },
              });
              return attachOutboundDeliveryCommitHook(
                normalizeChannelMessageSendResult(params.channel, sent.result),
                sent.afterCommit,
              );
            }
            await params.onPlatformSendStart?.();
            return outbound!.sendPayload!(payloadCtx);
          }
        : undefined,
    sendFormattedText: outbound?.sendFormattedText
      ? async (text, overrides) => {
          await params.onPlatformSendStart?.();
          return await outbound.sendFormattedText!({
            ...resolveCtx(overrides),
            text,
          });
        }
      : undefined,
    sendFormattedMedia: outbound?.sendFormattedMedia
      ? async (caption, mediaUrl, overrides) => {
          await params.onPlatformSendStart?.();
          return await outbound.sendFormattedMedia!({
            ...resolveCtx(overrides),
            text: caption,
            mediaUrl,
          });
        }
      : undefined,
    sendText: async (text, overrides) => {
      const textCtx = {
        ...resolveCtx(overrides),
        kind: "text" as const satisfies ChannelMessageSendAttemptKind,
        text,
      };
      if (messageText) {
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: textCtx,
          send: async () => {
            await params.onPlatformSendStart?.();
            return await messageText(textCtx);
          },
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      await params.onPlatformSendStart?.();
      return sendText!(textCtx);
    },
    buildTargetRef,
    sendMedia: async (caption, mediaUrl, overrides) => {
      const mediaCtx = {
        ...resolveCtx(overrides),
        kind: "media" as const satisfies ChannelMessageSendAttemptKind,
        text: caption,
        mediaUrl,
      };
      if (messageMedia) {
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: mediaCtx,
          send: async () => {
            await params.onPlatformSendStart?.();
            return await messageMedia(mediaCtx);
          },
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      if (sendMedia) {
        await params.onPlatformSendStart?.();
        return sendMedia(mediaCtx);
      }
      await params.onPlatformSendStart?.();
      return sendText!(mediaCtx);
    },
  };
}

function normalizeChannelMessageSendResult(
  channel: Exclude<OutboundChannel, "none">,
  result: ChannelMessageSendResult,
): OutboundDeliveryResult {
  const source = result as ChannelMessageSendResult & Partial<OutboundDeliveryResult>;
  return {
    ...source,
    channel,
    messageId:
      source.messageId ??
      source.receipt.primaryPlatformMessageId ??
      source.receipt.platformMessageIds[0] ??
      "",
    receipt: source.receipt,
  };
}

function createChannelOutboundContextBase(
  params: ChannelHandlerParams,
): Omit<ChannelOutboundContext, "text" | "mediaUrl"> {
  return {
    cfg: params.cfg,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    deps: params.deps,
    silent: params.silent,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaAccess?.localRoots,
    mediaReadFile: params.mediaAccess?.readFile,
    gatewayClientScopes: params.gatewayClientScopes,
  };
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

const isDeliveryAbortError = (err: unknown): boolean =>
  isAbortError(err) ||
  (err instanceof OutboundDeliveryError &&
    isAbortError((err as Error & { cause?: unknown }).cause));

async function markQueuedPlatformSendAttemptStarted(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
}): Promise<boolean> {
  try {
    await markDeliveryPlatformSendAttemptStarted(params.queueId);
    return true;
  } catch (err: unknown) {
    if (params.queuePolicy === "required") {
      throw err;
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-send-attempt-started; continuing best-effort delivery: ${formatErrorMessage(err)}`,
    );
    return false;
  }
}

async function markQueuedPlatformOutcomeUnknown(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
}): Promise<void> {
  try {
    await markDeliveryPlatformOutcomeUnknown(params.queueId);
  } catch (err: unknown) {
    if (params.queuePolicy === "required") {
      throw err;
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; continuing best-effort delivery: ${formatErrorMessage(err)}`,
    );
  }
}

type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  mediaAccess?: OutboundMediaAccess;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};

type DeliverOutboundPayloadsCoreRuntimeParams = DeliverOutboundPayloadsCoreParams & {
  onPlatformSendStart?: () => Promise<void>;
};

function collectPayloadMediaSources(plan: readonly OutboundPayloadPlan[]): string[] {
  return plan.flatMap((entry) => entry.parts.mediaUrls);
}

/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` from
 * `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
 * from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
 * outbound substrate, recovery, and compatibility paths.
 */
export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
  /** @internal Let recovery run commit hooks after it has acked the recovered queue entry. */
  deferCommitHooks?: boolean;
  queuePolicy?: OutboundDeliveryQueuePolicy;
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  onDeliveryIntent?: (intent: OutboundDeliveryIntent) => void;
};

type MessageSentEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
};

function sessionKeyForDeliveryDiagnostics(params: {
  mirror?: DeliveryMirror;
  session?: OutboundSessionContext;
}): string | undefined {
  return params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
}

function deliveryKindForPayload(
  payload: ReplyPayload,
  payloadSummary: NormalizedOutboundPayload,
): DiagnosticMessageDeliveryKind {
  if (payloadSummary.mediaUrls.length > 0 || payload.mediaUrl || payload.mediaUrls?.length) {
    return "media";
  }
  if (payload.presentation || payload.interactive || payload.channelData || payload.audioAsVoice) {
    return "other";
  }
  return "text";
}

function emitMessageDeliveryStarted(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.started",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

function emitMessageDeliveryCompleted(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  durationMs: number;
  resultCount: number;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.completed",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    durationMs: params.durationMs,
    resultCount: params.resultCount,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

function emitMessageDeliveryError(params: {
  channel: Exclude<OutboundChannel, "none">;
  deliveryKind: DiagnosticMessageDeliveryKind;
  durationMs: number;
  error: unknown;
  sessionKey?: string;
}): void {
  emitDiagnosticEvent({
    type: "message.delivery.error",
    channel: params.channel,
    deliveryKind: params.deliveryKind,
    durationMs: params.durationMs,
    errorCategory: diagnosticErrorCategory(params.error),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

function normalizeEmptyPayloadForDelivery(payload: ReplyPayload): ReplyPayload | null {
  const text = typeof payload.text === "string" ? payload.text : "";
  if (!text.trim()) {
    if (!hasReplyPayloadContent({ ...payload, text })) {
      return null;
    }
    if (text) {
      return {
        ...payload,
        text: "",
      };
    }
  }
  return payload;
}

type NormalizedPayloadForChannelDelivery = {
  index: number;
  payload: ReplyPayload;
};

function normalizePayloadsForChannelDelivery(
  plan: readonly OutboundPayloadPlan[],
  handler: ChannelHandler,
): NormalizedPayloadForChannelDelivery[] {
  const normalizedPayloads: NormalizedPayloadForChannelDelivery[] = [];
  for (const entry of plan) {
    let sanitizedPayload = stripInternalRuntimeScaffoldingFromPayload(entry.payload);
    if (handler.sanitizeText && sanitizedPayload.text) {
      if (!handler.shouldSkipPlainTextSanitization?.(sanitizedPayload)) {
        sanitizedPayload = {
          ...sanitizedPayload,
          text: handler.sanitizeText(sanitizedPayload),
        };
      }
    }
    const normalizedPayload = handler.normalizePayload
      ? handler.normalizePayload(sanitizedPayload)
      : sanitizedPayload;
    const normalized = normalizedPayload
      ? normalizeEmptyPayloadForDelivery(
          stripInternalRuntimeScaffoldingFromPayload(normalizedPayload),
        )
      : null;
    if (normalized) {
      normalizedPayloads.push({ index: entry.sourceIndex, payload: normalized });
    }
  }
  return normalizedPayloads;
}

function stripInternalRuntimeScaffoldingFromValue(value: unknown): unknown {
  if (typeof value === "string") {
    return stripInternalRuntimeScaffolding(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
      changed ||= stripped !== entry;
      return stripped;
    });
    return changed ? next : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const stripped = stripInternalRuntimeScaffoldingFromValue(entry);
    changed ||= stripped !== entry;
    next[key] = stripped;
  }
  return changed ? next : value;
}

function stripInternalRuntimeScaffoldingFromPayload(payload: ReplyPayload): ReplyPayload {
  const stripped = stripInternalRuntimeScaffoldingFromValue(payload);
  return stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? (stripped as ReplyPayload)
    : payload;
}

function buildPayloadSummary(payload: ReplyPayload): NormalizedOutboundPayload {
  return summarizeOutboundPayloadForTransport(payload);
}

function hasDeliveryResultIdentity(result: OutboundDeliveryResult): boolean {
  return Boolean(
    result.messageId ||
    result.chatId ||
    result.channelId ||
    result.roomId ||
    result.conversationId ||
    result.toJid ||
    result.pollId,
  );
}

function normalizeDeliveryPin(payload: ReplyPayload): ReplyPayloadDeliveryPin | undefined {
  const pin = payload.delivery?.pin;
  if (pin === true) {
    return { enabled: true };
  }
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) {
    return undefined;
  }
  if (!pin.enabled) {
    return undefined;
  }
  const normalized: ReplyPayloadDeliveryPin = { enabled: true };
  if (pin.notify === true) {
    normalized.notify = true;
  }
  if (pin.required === true) {
    normalized.required = true;
  }
  return normalized;
}

async function maybePinDeliveredMessage(params: {
  handler: ChannelHandler;
  payload: ReplyPayload;
  target: ChannelOutboundTargetRef;
  messageId?: string;
}): Promise<void> {
  const pin = normalizeDeliveryPin(params.payload);
  if (!pin) {
    return;
  }
  if (!params.messageId) {
    if (pin.required) {
      throw new Error("Delivery pin requested, but no delivered message id was returned.");
    }
    log.warn("Delivery pin requested, but no delivered message id was returned.", {
      channel: params.target.channel,
      to: params.target.to,
    });
    return;
  }
  if (!params.handler.pinDeliveredMessage) {
    if (pin.required) {
      throw new Error(`Delivery pin is not supported by channel: ${params.target.channel}`);
    }
    log.warn("Delivery pin requested, but channel does not support pinning delivered messages.", {
      channel: params.target.channel,
      to: params.target.to,
    });
    return;
  }
  try {
    await params.handler.pinDeliveredMessage({
      target: params.target,
      messageId: params.messageId,
      pin,
    });
  } catch (err) {
    if (pin.required) {
      throw err;
    }
    log.warn("Delivery pin requested, but channel failed to pin delivered message.", {
      channel: params.target.channel,
      to: params.target.to,
      messageId: params.messageId,
      error: formatErrorMessage(err),
    });
  }
}

async function maybeNotifyAfterDeliveredPayload(params: {
  handler: ChannelHandler;
  payload: ReplyPayload;
  target: ChannelOutboundTargetRef;
  results: readonly OutboundDeliveryResult[];
}): Promise<void> {
  if (!params.handler.afterDeliverPayload || params.results.length === 0) {
    return;
  }
  try {
    await params.handler.afterDeliverPayload({
      target: params.target,
      payload: params.payload,
      results: params.results,
    });
  } catch (err) {
    log.warn("Plugin outbound adapter after-delivery hook failed.", {
      channel: params.target.channel,
      to: params.target.to,
      error: formatErrorMessage(err),
    });
  }
}

async function renderPresentationForDelivery(
  handler: ChannelHandler,
  payload: ReplyPayload,
): Promise<ReplyPayload> {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const rendered = handler.renderPresentation ? await handler.renderPresentation(payload) : null;
  if (rendered) {
    const { presentation: _presentation, ...withoutPresentation } = rendered;
    return withoutPresentation;
  }
  const { presentation: _presentation, ...withoutPresentation } = payload;
  return {
    ...withoutPresentation,
    text: renderMessagePresentationFallbackText({
      text: payload.text,
      presentation,
    }),
  };
}

function createMessageSentEmitter(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  mirrorIsGroup?: boolean;
  mirrorGroupId?: string;
}): { emitMessageSent: (event: MessageSentEvent) => void; hasMessageSentHooks: boolean } {
  const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  const emitMessageSent = (event: MessageSentEvent) => {
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: event.content,
      success: event.success,
      error: event.error,
      channelId: params.channel,
      accountId: params.accountId ?? undefined,
      conversationId: params.to,
      messageId: event.messageId,
      isGroup: params.mirrorIsGroup,
      groupId: params.mirrorGroupId,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        "deliverOutboundPayloads: message_sent plugin hook failed",
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKeyForInternalHooks!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      "deliverOutboundPayloads: message:sent internal hook failed",
      (message) => {
        log.warn(message);
      },
    );
  };
  return { emitMessageSent, hasMessageSentHooks };
}

async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: Exclude<OutboundChannel, "none">;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
}): Promise<{
  cancelled: boolean;
  cancelReason?: string;
  hookMetadata?: Record<string, unknown>;
  contentRewritten: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  if (!params.enabled) {
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
        replyToId: params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
        conversationId: params.to,
      },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        ...(sendingResult.cancelReason ? { cancelReason: sendingResult.cancelReason } : {}),
        ...(sendingResult.metadata ? { hookMetadata: sendingResult.metadata } : {}),
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
      const spokenText = sendingResult.content;
      return {
        cancelled: false,
        contentRewritten: true,
        payload: {
          ...params.payload,
          spokenText,
        },
        payloadSummary: {
          ...params.payloadSummary,
          hookContent: spokenText,
        },
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
      contentRewritten: true,
      payload,
      payloadSummary: {
        ...params.payloadSummary,
        text: sendingResult.content,
      },
    };
  } catch {
    // Don't block delivery on hook failure.
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

function toOutboundDeliveryError(params: {
  error: unknown;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  stage: OutboundDeliveryFailureStage;
}): OutboundDeliveryError {
  if (params.error instanceof OutboundDeliveryError) {
    return params.error;
  }
  return new OutboundDeliveryError(formatErrorMessage(params.error), {
    cause: params.error,
    results: params.results,
    payloadOutcomes: params.payloadOutcomes,
    stage: params.stage,
  });
}

function suppressedPayloadOutcome(params: {
  index: number;
  reason: OutboundPayloadDeliverySuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
}): OutboundPayloadDeliveryOutcome {
  return {
    index: params.index,
    status: "suppressed",
    reason: params.reason,
    ...(params.hookEffect ? { hookEffect: params.hookEffect } : {}),
  };
}

/**
 * @deprecated Direct outbound delivery is compatibility/runtime substrate.
 * New message lifecycle code should use `sendDurableMessageBatch` from
 * `src/channels/message/send.ts` or `deliverInboundReplyWithMessageSendContext`
 * from `src/channels/turn/durable-delivery.ts`. Keep direct use only for
 * outbound substrate, recovery, and compatibility paths.
 */
export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  return await deliverOutboundPayloadsInternal(params);
}

export async function deliverOutboundPayloadsInternal(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const { channel, to, payloads } = params;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const queuePayloads = payloads.map(stripInternalRuntimeScaffoldingFromPayload);
  const queuePayloadsChanged = queuePayloads.some((payload, index) => payload !== payloads[index]);
  const renderedBatchPlan =
    params.renderedBatchPlan ?? createRenderedMessageBatchPlan(params.payloads);
  const queueRenderedBatchPlan = queuePayloadsChanged
    ? createRenderedMessageBatchPlan(queuePayloads)
    : renderedBatchPlan;

  // Write-ahead delivery queue: persist before sending, remove after success.
  const queueId = params.skipQueue
    ? null
    : await enqueueDelivery({
        channel,
        to,
        accountId: params.accountId,
        payloads: queuePayloads,
        renderedBatchPlan: queueRenderedBatchPlan,
        threadId: params.threadId,
        replyToId: params.replyToId,
        replyToMode: params.replyToMode,
        formatting: params.formatting,
        identity: params.identity,
        bestEffort: params.bestEffort,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        silent: params.silent,
        mirror: params.mirror,
        session: params.session,
        gatewayClientScopes: params.gatewayClientScopes,
      }).catch((err: unknown) => {
        if (queuePolicy === "required") {
          throw err;
        }
        return null;
      }); // Best-effort delivery falls back to direct send if the queue write fails.

  if (queueId) {
    params.onDeliveryIntent?.({
      id: queueId,
      channel,
      to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      queuePolicy,
    });
  }

  if (!queueId) {
    return await deliverOutboundPayloadsWithQueueCleanup(params, null);
  }

  // Hold the same in-process claim used by recovery/drain while the live send
  // owns this queue entry.
  const claimResult = await withActiveDeliveryClaim(queueId, () =>
    deliverOutboundPayloadsWithQueueCleanup(params, queueId),
  );
  if (claimResult.status === "claimed-by-other-owner") {
    return [];
  }
  return claimResult.value;
}

async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
): Promise<OutboundDeliveryResult[]> {
  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // without throwing — so the outer try/catch never fires. We track whether any
  // payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  const wrappedParams = {
    ...params,
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
      hadPartialFailure = true;
      params.onError?.(err, payload);
    },
  };
  const queuePolicy = params.queuePolicy ?? "best_effort";
  let platformResultsReturned = false;

  try {
    let platformSendStarted = false;
    const results = await deliverOutboundPayloadsCore({
      ...wrappedParams,
      ...(queueId
        ? {
            onPlatformSendStart: async () => {
              if (platformSendStarted) {
                return;
              }
              platformSendStarted = await markQueuedPlatformSendAttemptStarted({
                queueId,
                queuePolicy,
              });
            },
          }
        : {}),
    });
    platformResultsReturned = true;
    if (!queueId) {
      if (!params.deferCommitHooks) {
        await runOutboundDeliveryCommitHooks(results);
      }
      return results;
    }
    if (queueId) {
      if (hadPartialFailure) {
        await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
      } else {
        if (platformSendStarted) {
          await markQueuedPlatformOutcomeUnknown({
            queueId,
            queuePolicy,
          });
        }
        const acked = await ackDelivery(queueId)
          .then(() => true)
          .catch((err: unknown) => {
            if (queuePolicy === "required") {
              throw err;
            }
            log.warn(
              `failed to ack queued delivery ${queueId}; continuing best-effort delivery: ${formatErrorMessage(err)}`,
            );
            return false;
          });
        if (acked) {
          await runOutboundDeliveryCommitHooks(results);
        }
      }
    }
    return results;
  } catch (err) {
    if (queueId) {
      if (isDeliveryAbortError(err)) {
        await ackDelivery(queueId).catch(() => {});
      } else if (!platformResultsReturned) {
        await failDelivery(queueId, formatErrorMessage(err)).catch(() => {});
      }
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreRuntimeParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const directiveOptions = await resolveChannelOutboundDirectiveOptions({ cfg, channel });
  const outboundPayloadPlan = createOutboundPayloadPlan(payloads, {
    cfg,
    sessionKey: params.session?.policyKey ?? params.session?.key,
    surface: channel,
    conversationType: params.session?.conversationType,
    extractMarkdownImages: directiveOptions.extractMarkdownImages,
  });
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const mediaSources = collectPayloadMediaSources(outboundPayloadPlan);
  const mediaAccess =
    mediaSources.length > 0
      ? resolveAgentScopedOutboundMediaAccess({
          cfg,
          agentId: params.session?.agentId ?? params.mirror?.agentId,
          mediaSources,
          mediaAccess: params.mediaAccess,
          sessionKey: params.session?.key,
          messageProvider: params.session?.key ? undefined : channel,
          accountId: params.session?.requesterAccountId ?? accountId,
          requesterSenderId: params.session?.requesterSenderId,
          requesterSenderName: params.session?.requesterSenderName,
          requesterSenderUsername: params.session?.requesterSenderUsername,
          requesterSenderE164: params.session?.requesterSenderE164,
        })
      : (params.mediaAccess ?? {});
  const results: OutboundDeliveryResult[] = [];
  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mediaAccess,
    gatewayClientScopes: params.gatewayClientScopes,
    ...(params.onPlatformSendStart ? { onPlatformSendStart: params.onPlatformSendStart } : {}),
  });
  const configuredTextLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const textLimit =
    params.formatting?.textLimit ??
    (handler.resolveEffectiveTextChunkLimit
      ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit)
      : configuredTextLimit);
  const chunkMode = handler.chunker
    ? (params.formatting?.chunkMode ?? resolveChunkMode(cfg, channel, accountId))
    : "length";
  const { resolveCurrentReplyTo, applyReplyToConsumption } = createReplyToDeliveryPolicy({
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
  });

  const sendTextChunks = async (text: string, overrides: OutboundMessageSendOverrides = {}) => {
    const units = planOutboundTextMessageUnits({
      text,
      overrides,
      chunker: handler.chunker,
      chunkerMode: handler.chunkerMode,
      textLimit,
      chunkMode,
      formatting: params.formatting,
      consumeReplyTo: (value) =>
        applyReplyToConsumption(value, {
          consumeImplicitReply: value.replyToIdSource === "implicit",
        }),
    });
    for (const unit of units) {
      if (unit.kind !== "text") {
        continue;
      }
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(unit.text, unit.overrides));
    }
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  const recordPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    payloadOutcomes.push(outcome);
    params.onPayloadDeliveryOutcome?.(outcome);
  };
  if (normalizedPayloads.length === 0 && payloads.length > 0) {
    payloads.forEach((_payload, index) => {
      recordPayloadOutcome(suppressedPayloadOutcome({ index, reason: "no_visible_payload" }));
    });
  }
  const hookRunner = getGlobalHookRunner();
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
  const mirrorIsGroup = params.mirror?.isGroup;
  const mirrorGroupId = params.mirror?.groupId;
  const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
    hookRunner,
    channel,
    to,
    accountId,
    sessionKeyForInternalHooks,
    mirrorIsGroup,
    mirrorGroupId,
  });
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const diagnosticSessionKey = sessionKeyForDeliveryDiagnostics(params);
  if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
    log.warn(
      "deliverOutboundPayloads: session.agentId present without session key; internal message:sent hook will be skipped",
      {
        channel,
        to,
        agentId: params.session.agentId,
      },
    );
  }
  for (const { index: payloadIndex, payload } of normalizedPayloads) {
    let payloadSummary = buildPayloadSummary(payload);
    let deliveryKind: DiagnosticMessageDeliveryKind = "other";
    let deliveryStartedAt = 0;
    let deliveryStarted = false;
    let deliveryFinished = false;
    const startDeliveryDiagnostics = (kind: DiagnosticMessageDeliveryKind) => {
      deliveryKind = kind;
      deliveryStartedAt = Date.now();
      deliveryStarted = true;
      deliveryFinished = false;
      emitMessageDeliveryStarted({
        channel,
        deliveryKind,
        sessionKey: diagnosticSessionKey,
      });
    };
    const completeDeliveryDiagnostics = (resultCount: number) => {
      if (!deliveryStarted) {
        return;
      }
      deliveryFinished = true;
      emitMessageDeliveryCompleted({
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        resultCount,
        sessionKey: diagnosticSessionKey,
      });
    };
    const errorDeliveryDiagnostics = (err: unknown) => {
      if (!deliveryStarted || deliveryFinished) {
        return;
      }
      deliveryFinished = true;
      emitMessageDeliveryError({
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        error: err,
        sessionKey: diagnosticSessionKey,
      });
    };
    try {
      throwIfAborted(abortSignal);

      // Run message_sending plugin hook (may modify content or cancel)
      const hookResult = await applyMessageSendingHook({
        hookRunner,
        enabled: hasMessageSendingHooks,
        payload,
        payloadSummary,
        to,
        channel,
        accountId,
        replyToId: resolveCurrentReplyTo(payload).replyToId,
        threadId: params.threadId,
      });
      if (hookResult.cancelled) {
        const hookEffect =
          hookResult.cancelReason || hookResult.hookMetadata
            ? {
                ...(hookResult.cancelReason ? { cancelReason: hookResult.cancelReason } : {}),
                ...(hookResult.hookMetadata ? { metadata: hookResult.hookMetadata } : {}),
              }
            : undefined;
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "cancelled_by_message_sending_hook",
            ...(hookEffect ? { hookEffect } : {}),
          }),
        );
        continue;
      }
      const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(
        await renderPresentationForDelivery(handler, hookResult.payload),
      );
      const normalizedEffectivePayload = handler.normalizePayload
        ? handler.normalizePayload(renderedPayload)
        : renderedPayload;
      const effectivePayload = normalizedEffectivePayload
        ? normalizeEmptyPayloadForDelivery(
            stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload),
          )
        : null;
      if (!effectivePayload) {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: hookResult.contentRewritten
              ? "empty_after_message_sending_hook"
              : "no_visible_payload",
          }),
        );
        continue;
      }
      payloadSummary = buildPayloadSummary(effectivePayload);
      startDeliveryDiagnostics(deliveryKindForPayload(effectivePayload, payloadSummary));

      params.onPayload?.(payloadSummary);
      const replyToResolution = resolveCurrentReplyTo(effectivePayload);
      const sendOverrides: OutboundMessageSendOverrides = {
        replyToId: replyToResolution.replyToId,
        replyToIdSource: replyToResolution.source,
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        ...(effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
      };
      const applySendReplyToConsumption = <T extends OutboundMessageSendOverrides>(
        overrides: T,
      ): T =>
        applyReplyToConsumption(overrides, {
          consumeImplicitReply: replyToResolution.source === "implicit",
        });
      const deliveryTarget = handler.buildTargetRef({ threadId: sendOverrides.threadId });
      if (
        handler.sendPayload &&
        ((effectivePayload.isError === true && handler.sendTextOnlyErrorPayloads === true) ||
          hasReplyPayloadContent({
            presentation: effectivePayload.presentation,
            interactive: effectivePayload.interactive,
            channelData: effectivePayload.channelData,
          }) ||
          effectivePayload.audioAsVoice === true)
      ) {
        const delivery = await handler.sendPayload(
          effectivePayload,
          applySendReplyToConsumption(sendOverrides),
        );
        if (!hasDeliveryResultIdentity(delivery)) {
          completeDeliveryDiagnostics(0);
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
          continue;
        }
        results.push(delivery);
        recordPayloadOutcome({ index: payloadIndex, status: "sent", results: [delivery] });
        await maybePinDeliveredMessage({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: delivery.messageId,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: [delivery],
        });
        completeDeliveryDiagnostics(1);
        emitMessageSent({
          success: true,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId: delivery.messageId,
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (handler.sendFormattedText) {
          results.push(
            ...(await handler.sendFormattedText(
              payloadSummary.text,
              applySendReplyToConsumption(sendOverrides),
            )),
          );
        } else {
          await sendTextChunks(payloadSummary.text, sendOverrides);
        }
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = results.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        await maybePinDeliveredMessage({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
        continue;
      }

      if (!handler.supportsMedia) {
        log.warn(
          "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
          {
            channel,
            to,
            mediaCount: payloadSummary.mediaUrls.length,
          },
        );
        const fallbackText = payloadSummary.text.trim();
        if (!fallbackText) {
          throw new Error(
            "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
          );
        }
        const beforeCount = results.length;
        await sendTextChunks(fallbackText, sendOverrides);
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = results.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        await maybePinDeliveredMessage({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
        continue;
      }

      let firstMessageId: string | undefined;
      let lastMessageId: string | undefined;
      const beforeCount = results.length;
      const mediaUnits = planOutboundMediaMessageUnits({
        mediaUrls: payloadSummary.mediaUrls,
        caption: payloadSummary.text,
        overrides: sendOverrides,
        consumeReplyTo: applySendReplyToConsumption,
      });
      for (const unit of mediaUnits) {
        if (unit.kind !== "media") {
          continue;
        }
        throwIfAborted(abortSignal);
        const delivery = handler.sendFormattedMedia
          ? await handler.sendFormattedMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides)
          : await handler.sendMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides);
        results.push(delivery);
        firstMessageId ??= delivery.messageId;
        lastMessageId = delivery.messageId;
      }
      await maybePinDeliveredMessage({
        handler,
        payload: effectivePayload,
        target: deliveryTarget,
        messageId: firstMessageId,
      });
      await maybeNotifyAfterDeliveredPayload({
        handler,
        payload: effectivePayload,
        target: deliveryTarget,
        results: results.slice(beforeCount),
      });
      const deliveredResults = results.slice(beforeCount);
      if (deliveredResults.length > 0) {
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
      } else {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "adapter_returned_no_identity",
          }),
        );
      }
      completeDeliveryDiagnostics(results.length - beforeCount);
      emitMessageSent({
        success: true,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        messageId: lastMessageId,
      });
    } catch (err) {
      recordPayloadOutcome({
        index: payloadIndex,
        status: "failed",
        error: err,
        sentBeforeError: results.length > 0,
        stage: "platform_send",
      });
      errorDeliveryDiagnostics(err);
      emitMessageSent({
        success: false,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        error: formatErrorMessage(err),
      });
      if (!params.bestEffort) {
        throw toOutboundDeliveryError({
          error: err,
          results,
          payloadOutcomes,
          stage: "platform_send",
        });
      }
      params.onError?.(err, payloadSummary);
    }
  }
  if (params.mirror && results.length > 0) {
    const mirrorText = resolveMirroredTranscriptText({
      text: params.mirror.text,
      mediaUrls: params.mirror.mediaUrls,
    });
    if (mirrorText) {
      const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
      await appendAssistantMessageToSessionTranscript({
        agentId: params.mirror.agentId,
        sessionKey: params.mirror.sessionKey,
        text: mirrorText,
        idempotencyKey: params.mirror.idempotencyKey,
        config: params.cfg,
      });
    }
  }

  return results;
}
