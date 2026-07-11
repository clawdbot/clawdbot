// Outbound delivery core runs plugin hooks, queue durability, channel adapter
// sends, commit hooks, diagnostics, transcript mirroring, and payload outcomes.
import { hasTrustedMessageAuditListeners } from "../../audit/message-audit-events.js";
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import type {
  ChannelMessageAdapterShape,
  ChannelMessageSendAttemptContext,
  ChannelMessageSendAttemptKind,
  ChannelMessageSendLifecycleAdapter,
  ChannelMessageSendResult,
} from "../../channels/message/types.js";
import { unknownSendReconciliationKinds } from "../../channels/message/types.js";
import { adaptMessagePresentationForChannel } from "../../channels/plugins/outbound/interactive.js";
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
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { isProvenDeliveryNotSentError } from "../delivery-recovery.shared.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMessageDeliveryKind,
} from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import { resolveDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliveryKind,
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
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendDispatched,
  markDeliveryPlatformSendAttemptStarted,
  type QueuedReplyPayloadSendingHook,
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
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import {
  createOutboundPayloadPlan,
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
  type OutboundPayloadPlan,
} from "./payloads.js";
import { stripInternalRuntimeScaffolding } from "./protocol-scaffolding.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";
import type { OutboundSendDeps } from "./send-deps.js";
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

// Transcript writes are optional side effects; keep this lazy for import-only
// delivery policy checks and tests.
const loadTranscriptRuntime = createLazyRuntimeModule(
  () => import("../../config/sessions/transcript.runtime.js"),
);

const loadChannelBootstrapRuntime = createLazyRuntimeModule(
  () => import("./channel-bootstrap.runtime.js"),
);

type ChannelHandler = {
  chunker: ChannelOutboundAdapter["chunker"] | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  textChunkLimit?: number;
  supportsMedia: boolean;
  sanitizeText?: (payload: ReplyPayload) => string;
  normalizePayload?: (payload: ReplyPayload) => ReplyPayload | null;
  sendTextOnlyErrorPayloads?: boolean;
  renderPresentation?: (payload: ReplyPayload) => Promise<ReplyPayload | null>;
  presentationCapabilities?: ChannelOutboundAdapter["presentationCapabilities"];
  pinDeliveredMessage?: (params: {
    target: ChannelOutboundTargetRef;
    messageId: string;
    pin: ReplyPayloadDeliveryPin;
    gatewayClientScopes?: readonly string[];
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
type PlatformSendRoute = {
  replyToId?: string | null;
  threadId?: string | number | null;
};

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
  deliveryQueueId?: string;
  requiredUnknownSendReconciliation?: boolean;
  onPlatformSendStart?: (route: PlatformSendRoute) => Promise<void>;
  onPlatformSendDispatch?: () => Promise<void>;
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
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

  if (params.requirements?.reconcileUnknownSend === true) {
    const supportedKinds = messageDurableFinal?.reconcileUnknownSendKinds;
    for (const kind of unknownSendReconciliationKinds) {
      if (
        supportedKinds !== undefined &&
        params.requirements[kind] === true &&
        supportedKinds[kind] !== true
      ) {
        return {
          ok: false,
          reason: "capability_mismatch",
          capability: "reconcileUnknownSend",
        };
      }
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
  const assertUnknownSendReconciliationKind = (kind: ChannelMessageSendAttemptKind): void => {
    const durableFinal = params.message?.durableFinal;
    if (
      !params.requiredUnknownSendReconciliation ||
      durableFinal?.capabilities?.reconcileUnknownSend !== true
    ) {
      return;
    }
    if (
      durableFinal.reconcileUnknownSendKinds !== undefined &&
      durableFinal.reconcileUnknownSendKinds[kind] !== true
    ) {
      throw new Error(
        `Required durable message send became unsupported after outbound transforms: ${kind} unknown-send reconciliation is unavailable for ${params.channel}`,
      );
    }
  };
  if (!messageText && !outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound?.sendText;
  const sendMedia = outbound?.sendMedia;
  const chunker = outbound?.chunker ?? null;
  const chunkerMode = outbound?.chunkerMode;
  const onMessageDeliveryResult = params.onDeliveryResult
    ? async (result: ChannelMessageSendResult): Promise<void> => {
        await params.onDeliveryResult?.(normalizeChannelMessageSendResult(params.channel, result));
      }
    : undefined;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    replyToIdSource?: "explicit" | "implicit";
    threadId?: string | number | null;
    audioAsVoice?: boolean;
    formatting?: OutboundDeliveryFormattingOptions;
  }): Omit<ChannelOutboundContext, "text" | "mediaUrl"> => ({
    ...baseCtx,
    replyToId: overrides && "replyToId" in overrides ? overrides.replyToId : baseCtx.replyToId,
    replyToIdSource:
      overrides && "replyToIdSource" in overrides
        ? overrides.replyToIdSource
        : baseCtx.replyToIdSource,
    threadId: overrides && "threadId" in overrides ? overrides.threadId : baseCtx.threadId,
    audioAsVoice: overrides?.audioAsVoice,
    formatting:
      overrides && "formatting" in overrides
        ? { ...baseCtx.formatting, ...overrides.formatting }
        : baseCtx.formatting,
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
    chunkedTextFormatting: outbound?.chunkedTextFormatting,
    textChunkLimit: outbound?.textChunkLimit,
    supportsMedia: Boolean(messageMedia ?? sendMedia),
    sanitizeText: outbound?.sanitizeText
      ? (payload) => outbound.sanitizeText!({ text: payload.text ?? "", payload })
      : undefined,
    normalizePayload: outbound?.normalizePayload
      ? (payload) =>
          outbound.normalizePayload!({
            payload,
            cfg: params.cfg,
            accountId: params.accountId,
          })
      : undefined,
    sendTextOnlyErrorPayloads: outbound?.sendTextOnlyErrorPayloads === true,
    presentationCapabilities: outbound?.presentationCapabilities,
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
      ? async ({ target, messageId, pin, gatewayClientScopes }) =>
          outbound.pinDeliveredMessage!({
            cfg: params.cfg,
            target,
            messageId,
            pin,
            gatewayClientScopes,
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
            assertUnknownSendReconciliationKind("payload");
            if (messagePayload) {
              const messagePayloadCtx = {
                ...payloadCtx,
                onDeliveryResult: onMessageDeliveryResult,
              };
              const sent = await runChannelMessageSendWithLifecycle({
                lifecycle: messageLifecycle,
                ctx: messagePayloadCtx,
                send: async () => {
                  await params.onPlatformSendStart?.(messagePayloadCtx);
                  return await messagePayload(messagePayloadCtx);
                },
              });
              return attachOutboundDeliveryCommitHook(
                normalizeChannelMessageSendResult(params.channel, sent.result),
                sent.afterCommit,
              );
            }
            await params.onPlatformSendStart?.(payloadCtx);
            return outbound!.sendPayload!(payloadCtx);
          }
        : undefined,
    sendFormattedText: outbound?.sendFormattedText
      ? async (text, overrides) => {
          const formattedCtx = {
            ...resolveCtx(overrides),
            text,
          };
          assertUnknownSendReconciliationKind("text");
          await params.onPlatformSendStart?.(formattedCtx);
          return await outbound.sendFormattedText!(formattedCtx);
        }
      : undefined,
    sendFormattedMedia: outbound?.sendFormattedMedia
      ? async (caption, mediaUrl, overrides) => {
          const formattedCtx = {
            ...resolveCtx(overrides),
            text: caption,
            mediaUrl,
          };
          assertUnknownSendReconciliationKind("media");
          await params.onPlatformSendStart?.(formattedCtx);
          return await outbound.sendFormattedMedia!(formattedCtx);
        }
      : undefined,
    sendText: async (text, overrides) => {
      const textCtx = {
        ...resolveCtx(overrides),
        kind: "text" as const satisfies ChannelMessageSendAttemptKind,
        text,
      };
      assertUnknownSendReconciliationKind("text");
      if (messageText) {
        const messageTextCtx = { ...textCtx, onDeliveryResult: onMessageDeliveryResult };
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: messageTextCtx,
          send: async () => {
            await params.onPlatformSendStart?.(messageTextCtx);
            return await messageText(messageTextCtx);
          },
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      await params.onPlatformSendStart?.(textCtx);
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
      assertUnknownSendReconciliationKind("media");
      if (messageMedia) {
        const messageMediaCtx = { ...mediaCtx, onDeliveryResult: onMessageDeliveryResult };
        const sent = await runChannelMessageSendWithLifecycle({
          lifecycle: messageLifecycle,
          ctx: messageMediaCtx,
          send: async () => {
            await params.onPlatformSendStart?.(messageMediaCtx);
            return await messageMedia(messageMediaCtx);
          },
        });
        return attachOutboundDeliveryCommitHook(
          normalizeChannelMessageSendResult(params.channel, sent.result),
          sent.afterCommit,
        );
      }
      if (sendMedia) {
        await params.onPlatformSendStart?.(mediaCtx);
        return sendMedia(mediaCtx);
      }
      await params.onPlatformSendStart?.(mediaCtx);
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
    deliveryQueueId: params.deliveryQueueId,
    onPlatformSendDispatch: params.onPlatformSendDispatch,
    onDeliveryResult: params.onDeliveryResult,
  };
}

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

const isDeliveryAbortError = (err: unknown): boolean =>
  isAbortError(err) ||
  (err instanceof OutboundDeliveryError &&
    isAbortError((err as Error & { cause?: unknown }).cause));

type QueuedPostSendState = "marked" | "acked" | "failed";

type QueuedPreSendState = "marked" | "acked";

async function persistQueuedPreSendState(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
  stateDir?: string;
  route: PlatformSendRoute;
}): Promise<QueuedPreSendState> {
  try {
    await markDeliveryPlatformSendAttemptStarted(params.queueId, params.stateDir, {
      replyToId: params.route.replyToId ?? null,
    });
    return "marked";
  } catch (markErr: unknown) {
    if (params.queuePolicy === "required") {
      throw markErr;
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-send-attempt-started; removing replay intent before best-effort send: ${formatErrorMessage(markErr)}`,
    );
    // If the pre-send marker is unavailable, remove the intent before crossing
    // the platform boundary. An ack failure aborts the send, leaving safe retry state.
    await ackDelivery(params.queueId, params.stateDir);
    return "acked";
  }
}

async function persistQueuedPostSendState(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
}): Promise<QueuedPostSendState> {
  try {
    await markDeliveryPlatformOutcomeUnknown(params.queueId);
    return "marked";
  } catch (markErr: unknown) {
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
    );
    try {
      // The platform already returned a result. If state marking is unavailable,
      // deleting the intent is safer than leaving it replayable.
      await ackDelivery(params.queueId);
      return "acked";
    } catch (ackErr: unknown) {
      const error = `post-send state persistence failed: marker=${formatErrorMessage(markErr)}; ack=${formatErrorMessage(ackErr)}`;
      // Keep the evidence in the same canonical row if both primary state
      // transitions fail; a generic failure update would make it replayable.
      await failDeliveryAfterPlatformSend(params.queueId, error);
      return "failed";
    }
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
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
  /** @internal Runs after each identified platform result, before further fallible work. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
  /** @internal Persists ambiguous-send state immediately before platform I/O. */
  onPlatformSendStart?: (route: PlatformSendRoute) => Promise<void>;
  /** @internal Opaque durable intent id forwarded to provider reconciliation hooks. */
  deliveryQueueId?: string;
  /** @internal Recheck the concrete post-hook send shape before platform I/O. */
  requiredUnknownSendReconciliation?: boolean;
  /** @internal Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /** @internal Refresh durable timing before recipient-visible or finalizing platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};

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
  /** @internal Recovery already ran provider admission after its pending-row re-read. */
  deferredDeliveryAdmissionPassed?: true;
  /** @internal State directory that owns the existing recovery queue entry. */
  deliveryQueueStateDir?: string;
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

/**
 * Best-effort session identifier for delivery telemetry only. Falls back to
 * `policyKey` as a last resort so diagnostic emission still has a stable
 * string when neither mirror nor canonical key are available. **Do not use
 * this value for hook-context correlation** — use `sessionKeyForInternalHooks`
 * (mirror.sessionKey ?? session.key, no policyKey fallback) instead, so we
 * never accidentally hand the policy key to plugins that expect the canonical
 * session key.
 */
function sessionKeyForDeliveryDiagnostics(params: {
  mirror?: DeliveryMirror;
  session?: OutboundSessionContext;
}): string | undefined {
  return params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
}

function deliveryKindForPayload(
  payload: ReplyPayload,
  payloadSummary: NormalizedOutboundPayload,
): OutboundPayloadDeliveryKind {
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
  gatewayClientScopes?: readonly string[];
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
      gatewayClientScopes: params.gatewayClientScopes,
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
  const adaptedPresentation = adaptMessagePresentationForChannel({
    presentation,
    capabilities: handler.presentationCapabilities,
  });
  const adaptedPayload = { ...payload, presentation: adaptedPresentation };
  const rendered = handler.renderPresentation
    ? await handler.renderPresentation(adaptedPayload)
    : null;
  if (rendered) {
    const { presentation: _presentation, ...withoutPresentation } = rendered;
    return withoutPresentation;
  }
  const { presentation: _presentation, ...withoutPresentation } = payload;
  return {
    ...withoutPresentation,
    text: renderMessagePresentationFallbackText({
      text: payload.text,
      presentation: adaptedPresentation,
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
      // Mirror the canonical outbound session key into the `message_sent`
      // hook context so plugins that observe both `message_sending` and
      // `message_sent` see the same `sessionKey` (and so it matches the
      // value the internal `message:sent` hook fires with). The value is
      // already computed for the internal hook below; reusing it here
      // keeps the contract documented in `PluginHookMessageContext`
      // honest for both outbound delivery hooks.
      sessionKey: params.sessionKeyForInternalHooks,
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
  sessionKey?: string;
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
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
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

async function applyReplyPayloadSendingHook(params: {
  hook: QueuedReplyPayloadSendingHook | undefined;
  payload: ReplyPayload;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  changed: boolean;
}> {
  if (!params.hook) {
    return { cancelled: false, payload: params.payload, changed: false };
  }
  const nextPayload = await runReplyPayloadSendingHook({
    payload: params.payload,
    kind: params.hook.kind,
    ...(params.hook.channel ? { channel: params.hook.channel } : {}),
    ...(params.hook.sessionKey ? { sessionKey: params.hook.sessionKey } : {}),
    ...(params.hook.runId ? { runId: params.hook.runId } : {}),
    context: params.hook.context,
  });
  if (!nextPayload) {
    return { cancelled: true, payload: params.payload, changed: false };
  }
  return {
    cancelled: false,
    payload: nextPayload,
    changed: nextPayload !== params.payload,
  };
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
  const auditStartedAt = Date.now();
  const { channel, to, payloads } = params;
  const emitPreQueueFailure = (): void => {
    // Recovery owns the stable queue terminal for replayed intents.
    if (params.deliveryQueueId !== undefined) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals: () =>
        uniformOutboundAuditTerminals(params.payloads.length, {
          outcome: "failed",
          failureStage: "queue",
        }),
      startedAt: auditStartedAt,
    });
  };
  if (params.requireUnknownSendReconciliation === true && payloads.length !== 1) {
    emitPreQueueFailure();
    throw new Error(
      `Required durable message send is unsupported for ${channel}: unknown-send reconciliation requires exactly one payload`,
    );
  }
  if (params.deferredDeliveryAdmissionPassed !== true) {
    const admission = resolveDeferredDeliveryAdmission({
      cfg: params.cfg,
      channel,
      to,
      accountId: params.accountId,
      phase: "live",
    });
    if (admission.status === "permanent_rejection") {
      emitPreQueueFailure();
      throw new Error(admission.reason);
    }
  }
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
        queuePolicy,
        requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
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
        replyPayloadSendingHook: params.replyPayloadSendingHook,
        silent: params.silent,
        mirror: params.mirror,
        session: params.session,
        gatewayClientScopes: params.gatewayClientScopes,
      }).catch((err: unknown) => {
        if (queuePolicy === "required") {
          emitPreQueueFailure();
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
    return await deliverOutboundPayloadsWithQueueCleanup(params, null, auditStartedAt);
  }

  // Hold the same in-process claim used by recovery/drain while the live send
  // owns this queue entry.
  const claimResult = await withActiveDeliveryClaim(queueId, () =>
    deliverOutboundPayloadsWithQueueCleanup(params, queueId, auditStartedAt),
  );
  if (claimResult.status === "claimed-by-other-owner") {
    return [];
  }
  return claimResult.value;
}

async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
): Promise<OutboundDeliveryResult[]> {
  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // without throwing — so the outer try/catch never fires. We track whether any
  // payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  let lastPayloadError: unknown;
  let partialFailuresAreProvenNotSent = true;
  const ownsAuditTerminal = params.deliveryQueueId === undefined;
  const auditPayloadOutcomes =
    ownsAuditTerminal && hasTrustedMessageAuditListeners()
      ? ([] as OutboundPayloadDeliveryOutcome[])
      : undefined;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const platformQueueId = queueId ?? params.deliveryQueueId;
  const platformQueuePolicy = queueId ? queuePolicy : (params.queuePolicy ?? "required");
  const platformQueueStateDir = queueId ? undefined : params.deliveryQueueStateDir;
  const exactReconciliationRequired =
    params.requireUnknownSendReconciliation === true && platformQueueId !== undefined;
  let queuedPreSendState: QueuedPreSendState | undefined;
  let queuedPostSendState: QueuedPostSendState | undefined;
  let platformSendRoute: PlatformSendRoute | undefined;
  let deliveredResults: OutboundDeliveryResult[] = [];
  let commitHooksRun = false;
  const emitTerminals = (
    terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
  ): void => {
    if (!ownsAuditTerminal) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals,
      startedAt: auditStartedAt,
      ...(queueId ? { queueId } : {}),
    });
  };
  const runCommitHooksAfterAck = async (): Promise<void> => {
    if (
      queuedPostSendState !== "acked" ||
      params.deferCommitHooks ||
      commitHooksRun ||
      deliveredResults.length === 0
    ) {
      return;
    }
    commitHooksRun = true;
    await runOutboundDeliveryCommitHooks(deliveredResults);
  };
  const wrappedParams: DeliverOutboundPayloadsParams = {
    ...params,
    // A provider marker can represent the whole durable intent only when one payload owns it.
    // Adapters must narrow further when one payload can fan out into multiple platform sends.
    ...(exactReconciliationRequired && params.payloads.length === 1
      ? { deliveryQueueId: platformQueueId }
      : { deliveryQueueId: undefined }),
    requiredUnknownSendReconciliation: exactReconciliationRequired,
    onPlatformSendStart: async (route) => {
      platformSendRoute = route;
      if (platformQueueId && !exactReconciliationRequired && queuedPreSendState === undefined) {
        queuedPreSendState = await persistQueuedPreSendState({
          queueId: platformQueueId,
          queuePolicy: platformQueuePolicy,
          stateDir: platformQueueStateDir,
          route,
        });
        if (queueId && queuedPreSendState === "acked") {
          queuedPostSendState = "acked";
        }
      }
      await params.onPlatformSendStart?.(route);
    },
    onPlatformSendDispatch: async () => {
      if (platformQueueId && queuedPreSendState !== "acked") {
        try {
          await markDeliveryPlatformSendDispatched(
            platformQueueId,
            platformQueueStateDir,
            platformSendRoute,
          );
          queuedPreSendState ??= "marked";
        } catch (dispatchMarkError) {
          if (exactReconciliationRequired) {
            throw dispatchMarkError;
          }
          log.warn(
            `failed to refresh queued delivery ${platformQueueId} at platform dispatch; continuing best-effort send: ${formatErrorMessage(dispatchMarkError)}`,
          );
        }
      }
      await params.onPlatformSendDispatch?.();
    },
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
      hadPartialFailure = true;
      lastPayloadError = err;
      partialFailuresAreProvenNotSent &&= isProvenDeliveryNotSentError(err);
      params.onError?.(err, payload);
    },
    ...(auditPayloadOutcomes
      ? {
          onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => {
            auditPayloadOutcomes.push(outcome);
            params.onPayloadDeliveryOutcome?.(outcome);
          },
        }
      : {}),
    onDeliveryResult: async (result) => {
      deliveredResults.push(result);
      if (queueId && queuedPostSendState === undefined) {
        queuedPostSendState = await persistQueuedPostSendState({ queueId, queuePolicy });
      }
      await params.onDeliveryResult?.(result);
    },
  };
  let platformResultsReturned = false;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    // Core reconciles adapter progress objects with hook-bearing final results.
    deliveredResults = results;
    platformResultsReturned = true;
    if (!queueId) {
      if (!params.deferCommitHooks) {
        await runOutboundDeliveryCommitHooks(results);
      }
      emitTerminals(() =>
        hadPartialFailure
          ? failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            })
          : completedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
            }),
      );
      return results;
    }
    if (queueId) {
      if (hadPartialFailure) {
        const partialSendEvidence =
          results.length > 0 ||
          (lastPayloadError instanceof OutboundDeliveryError && lastPayloadError.sentBeforeError);
        const postSendState =
          queuedPostSendState ??
          (partialSendEvidence
            ? await persistQueuedPostSendState({ queueId, queuePolicy })
            : undefined);
        const error = "partial delivery failure (bestEffort)";
        if (postSendState === undefined || postSendState === "marked") {
          const recordFailure =
            !partialSendEvidence && partialFailuresAreProvenNotSent
              ? failDeliveryBeforePlatformSend
              : failDelivery;
          await recordFailure(queueId, error).catch((err: unknown) => {
            log.warn(
              `failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
            );
          });
        } else if (postSendState === "acked") {
          // Direct ack is the fallback when the post-send marker cannot be
          // written. Once the row is gone, recovery cannot run these hooks.
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            }),
          );
        }
      } else {
        const postSendState =
          queuedPostSendState ??
          (results.length > 0 || queuedPreSendState === "marked"
            ? await persistQueuedPostSendState({ queueId, queuePolicy })
            : queuedPreSendState === "acked"
              ? "acked"
              : undefined);
        const acked =
          postSendState === "acked"
            ? true
            : postSendState === "failed"
              ? false
              : await ackDelivery(queueId)
                  .then(() => true)
                  .catch(async (err: unknown) => {
                    const hasSendEvidence =
                      deliveredResults.length > 0 || queuedPreSendState !== undefined;
                    try {
                      if (hasSendEvidence) {
                        await failDeliveryAfterPlatformSend(
                          queueId,
                          `failed to ack sent delivery: ${formatErrorMessage(err)}`,
                        );
                        queuedPostSendState = "failed";
                      } else {
                        await failDelivery(
                          queueId,
                          `failed to ack unsent delivery: ${formatErrorMessage(err)}`,
                        );
                      }
                    } catch (persistErr: unknown) {
                      log.warn(
                        `failed to preserve queued delivery ${queueId} after ack failure: ${formatErrorMessage(persistErr)}`,
                      );
                    }
                    if (queuePolicy === "required") {
                      throw err;
                    }
                    log.warn(
                      hasSendEvidence
                        ? `failed to ack queued delivery ${queueId}; preserved unknown-after-send state: ${formatErrorMessage(err)}`
                        : `failed to ack unsent queued delivery ${queueId}; retained it for retry: ${formatErrorMessage(err)}`,
                    );
                    return false;
                  });
        if (acked) {
          queuedPostSendState = "acked";
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            completedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
            }),
          );
        }
      }
    }
    return results;
  } catch (err) {
    if (err instanceof OutboundDeliveryError && err.results.length > 0) {
      deliveredResults = err.results;
    }
    if (queueId) {
      if (isDeliveryAbortError(err)) {
        const acked = await ackDelivery(queueId)
          .then(() => true)
          .catch(() => false);
        if (acked) {
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results: deliveredResults,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "queue",
            }),
          );
        }
      } else if (!platformResultsReturned) {
        const sendEvidence =
          deliveredResults.length > 0 ||
          (err instanceof OutboundDeliveryError && err.sentBeforeError);
        if (sendEvidence) {
          try {
            queuedPostSendState ??= await persistQueuedPostSendState({
              queueId,
              queuePolicy,
            });
            if (queuedPostSendState === "marked") {
              await failDeliveryAfterPlatformSend(queueId, formatErrorMessage(err));
              queuedPostSendState = "failed";
            }
          } catch (persistErr: unknown) {
            // Do not convert concrete send evidence back into a generic retry.
            // All canonical state transitions failed, so retain the original row.
            log.warn(
              `failed to preserve queued delivery ${queueId} post-send evidence: ${formatErrorMessage(persistErr)}`,
            );
          }
          await runCommitHooksAfterAck();
          if (queuedPostSendState === "acked") {
            emitTerminals(() =>
              failedOutboundAuditTerminals({
                payloadCount: params.payloads.length,
                results: deliveredResults,
                payloadOutcomes: auditPayloadOutcomes ?? [],
                failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
              }),
            );
          }
        } else if (queuedPreSendState === "acked") {
          // The best-effort marker fallback removed the durable row before
          // provider I/O, so this owner must emit the stable queue terminal.
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results: deliveredResults,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
            }),
          );
        } else {
          const recordFailure = isProvenDeliveryNotSentError(err)
            ? failDeliveryBeforePlatformSend
            : failDelivery;
          await recordFailure(queueId, formatErrorMessage(err)).catch((failErr: unknown) => {
            log.warn(
              `failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`,
            );
          });
        }
      }
    } else {
      emitTerminals(() =>
        failedOutboundAuditTerminals({
          payloadCount: params.payloads.length,
          results: deliveredResults,
          payloadOutcomes: auditPayloadOutcomes ?? [],
          failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
        }),
      );
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
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
  const results: OutboundDeliveryResult[] = [];
  let reportedResults: Array<{ identityKey: string; resultIndex: number }> = [];
  const resultIdentityKey = (delivery: OutboundDeliveryResult): string =>
    JSON.stringify([
      delivery.channel,
      delivery.messageId,
      delivery.chatId,
      delivery.channelId,
      delivery.roomId,
      delivery.conversationId,
      delivery.timestamp,
      delivery.toJid,
      delivery.pollId,
    ]);
  const resultPlatformIds = (
    delivery: OutboundDeliveryResult,
    options?: { receiptOnly?: boolean },
  ): Set<string> => {
    const ids = new Set<string>();
    const add = (value: string | undefined) => {
      const id = value?.trim();
      if (id && id !== "unknown" && id !== "suppressed") {
        ids.add(id);
      }
    };
    if (!options?.receiptOnly) {
      add(delivery.messageId);
    }
    add(delivery.receipt?.primaryPlatformMessageId);
    for (const id of delivery.receipt?.platformMessageIds ?? []) {
      add(id);
    }
    for (const part of delivery.receipt?.parts ?? []) {
      add(part.platformMessageId);
    }
    return ids;
  };
  const reportIdentifiedDeliveryResult = async (
    delivery: OutboundDeliveryResult,
  ): Promise<void> => {
    if (!hasDeliveryResultIdentity(delivery)) {
      return;
    }
    const resultIndex = results.length;
    results.push(delivery);
    reportedResults.push({ identityKey: resultIdentityKey(delivery), resultIndex });
    // Persist concrete platform evidence before pinning, hooks, mirroring, or
    // another send can fail or the process can stop.
    await params.onDeliveryResult?.(delivery);
  };
  const recordIdentifiedDeliveryResults = async (
    deliveries: readonly OutboundDeliveryResult[],
    options?: { finalResultIsLastReported?: boolean },
  ): Promise<boolean[]> => {
    const reportedByIdentity = new Map<string, number[]>();
    for (const reported of reportedResults) {
      const matches = reportedByIdentity.get(reported.identityKey) ?? [];
      matches.push(reported.resultIndex);
      reportedByIdentity.set(reported.identityKey, matches);
    }
    try {
      const recorded: boolean[] = [];
      const availableReportedIndices = new Set(
        reportedResults.map((reported) => reported.resultIndex),
      );
      const replacements = new Map<number, OutboundDeliveryResult>();
      const removals = new Set<number>();
      const appendResults: OutboundDeliveryResult[] = [];
      for (const delivery of deliveries) {
        if (!hasDeliveryResultIdentity(delivery)) {
          recorded.push(false);
          continue;
        }
        const receiptPartIds = (delivery.receipt?.parts ?? [])
          .map((part) => part.platformMessageId?.trim())
          .filter((id): id is string => Boolean(id && id !== "unknown" && id !== "suppressed"));
        const receiptIds =
          receiptPartIds.length > 0
            ? receiptPartIds
            : [...resultPlatformIds(delivery, { receiptOnly: true })];
        const coveredIndices: number[] = [];
        for (const receiptId of receiptIds) {
          const matchingIndices = reportedResults
            .filter(
              (reported) =>
                availableReportedIndices.has(reported.resultIndex) &&
                !coveredIndices.includes(reported.resultIndex) &&
                results[reported.resultIndex]?.channel === delivery.channel &&
                resultPlatformIds(results[reported.resultIndex]).has(receiptId),
            )
            .map((reported) => reported.resultIndex);
          // One receipt part covers one progress result. Repeated parts preserve
          // aggregate multiplicity, while one constant platform ID cannot erase
          // other successful sends that the final receipt does not aggregate.
          const matchingIndex = options?.finalResultIsLastReported
            ? matchingIndices.at(-1)
            : matchingIndices[0];
          if (matchingIndex !== undefined && !coveredIndices.includes(matchingIndex)) {
            coveredIndices.push(matchingIndex);
          }
        }
        let reportedIndex: number | undefined;
        if (coveredIndices.length > 0) {
          reportedIndex = Math.min(...coveredIndices);
          for (const coveredIndex of coveredIndices) {
            availableReportedIndices.delete(coveredIndex);
            if (coveredIndex !== reportedIndex) {
              removals.add(coveredIndex);
            }
          }
        } else {
          const reportedMatches = (
            reportedByIdentity.get(resultIdentityKey(delivery)) ?? []
          ).filter((index) => availableReportedIndices.has(index));
          reportedIndex = options?.finalResultIsLastReported
            ? reportedMatches.at(-1)
            : reportedMatches[0];
          if (reportedIndex !== undefined) {
            availableReportedIndices.delete(reportedIndex);
          }
        }
        if (reportedIndex !== undefined) {
          // Replace all progress covered by an aggregate receipt with the final
          // hook-bearing object, avoiding duplicate receipt parts.
          replacements.set(reportedIndex, delivery);
        } else {
          appendResults.push(delivery);
        }
        recorded.push(true);
      }
      if (replacements.size > 0 || removals.size > 0) {
        const reconciled = results.flatMap((result, index) => {
          if (removals.has(index)) {
            return [];
          }
          return [replacements.get(index) ?? result];
        });
        results.splice(0, results.length, ...reconciled);
      }
      for (const delivery of appendResults) {
        results.push(delivery);
        await params.onDeliveryResult?.(delivery);
      }
      return recorded;
    } finally {
      // Progress matching is scoped to exactly one adapter invocation. IDs such
      // as LINE's constant "push" value can legitimately repeat later.
      reportedResults = [];
    }
  };
  const recordIdentifiedDeliveryResult = async (
    delivery: OutboundDeliveryResult,
  ): Promise<boolean> =>
    (
      await recordIdentifiedDeliveryResults([delivery], {
        finalResultIsLastReported: true,
      })
    )[0] ?? false;
  const resolveMediaAccess = (mediaSources: readonly string[]): OutboundMediaAccess =>
    mediaSources.length > 0
      ? resolveAgentScopedOutboundMediaAccess({
          cfg,
          agentId: params.session?.agentId ?? params.mirror?.agentId,
          mediaSources,
          mediaAccess: params.mediaAccess,
          sessionKey: params.session?.policyKey ?? params.session?.key,
          messageProvider: params.session?.key ? undefined : channel,
          accountId: params.session?.requesterAccountId ?? accountId,
          requesterSenderId: params.session?.requesterSenderId,
          requesterSenderName: params.session?.requesterSenderName,
          requesterSenderUsername: params.session?.requesterSenderUsername,
          requesterSenderE164: params.session?.requesterSenderE164,
        })
      : (params.mediaAccess ?? {});
  const createHandler = (mediaSources: readonly string[]) =>
    createChannelHandler({
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
      mediaAccess: resolveMediaAccess(mediaSources),
      gatewayClientScopes: params.gatewayClientScopes,
      deliveryQueueId: params.deliveryQueueId,
      requiredUnknownSendReconciliation: params.requiredUnknownSendReconciliation,
      onPlatformSendStart: params.onPlatformSendStart,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onDeliveryResult: reportIdentifiedDeliveryResult,
    });
  const baseHandler = await createHandler([]);
  const handlerByMediaSources = new Map<string, Promise<ChannelHandler>>();
  const getDeliveryHandler = (mediaSources: readonly string[]): Promise<ChannelHandler> => {
    if (mediaSources.length === 0) {
      return Promise.resolve(baseHandler);
    }
    const key = JSON.stringify(mediaSources);
    const cached = handlerByMediaSources.get(key);
    if (cached) {
      return cached;
    }
    const created = createHandler(mediaSources);
    handlerByMediaSources.set(key, created);
    return created;
  };
  const handler = baseHandler;
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

  const sendTextChunks = async (
    sendHandler: ChannelHandler,
    text: string,
    overrides: OutboundMessageSendOverrides = {},
  ) => {
    const units = planOutboundTextMessageUnits({
      text,
      overrides,
      chunker: sendHandler.chunker,
      chunkerMode: sendHandler.chunkerMode,
      chunkedTextFormatting: sendHandler.chunkedTextFormatting,
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
      await recordIdentifiedDeliveryResult(await sendHandler.sendText(unit.text, unit.overrides));
    }
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  const effectiveDeliveryKinds = new Map<number, OutboundPayloadDeliveryKind>();
  const recordPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    const deliveryKind = effectiveDeliveryKinds.get(outcome.index);
    const recordedOutcome =
      deliveryKind && outcome.status !== "suppressed" ? { ...outcome, deliveryKind } : outcome;
    payloadOutcomes.push(recordedOutcome);
    params.onPayloadDeliveryOutcome?.(recordedOutcome);
  };
  if (normalizedPayloads.length === 0) {
    for (const [index] of payloads.entries()) {
      recordPayloadOutcome(suppressedPayloadOutcome({ index, reason: "no_visible_payload" }));
    }
  } else {
    const normalizedPayloadIndexes = new Set(normalizedPayloads.map((entry) => entry.index));
    for (const [index] of payloads.entries()) {
      if (!normalizedPayloadIndexes.has(index)) {
        recordPayloadOutcome(suppressedPayloadOutcome({ index, reason: "no_visible_payload" }));
      }
    }
  }
  const deliveredMirrorPayloads: NormalizedOutboundPayload[] = [];
  const recordDeliveredMirrorPayload = (
    payloadSummary: NormalizedOutboundPayload,
    deliveredResults: readonly OutboundDeliveryResult[],
  ): void => {
    if (!params.mirror || deliveredResults.length === 0) {
      return;
    }
    deliveredMirrorPayloads.push(payloadSummary);
  };
  const hookRunner = getGlobalHookRunner();
  // Canonical session key forwarded to internal lifecycle hooks
  // (`message:sent` event, `message_sending` plugin hook ctx, etc.). Mirror
  // delivery wins because mirror sends are explicitly bound to the mirror's
  // session; otherwise we use `session.key`, which by contract equals the
  // agent runtime's `params.sessionKey` for the run that produced the
  // payload (see OutboundSessionContext.key JSDoc). We deliberately do NOT
  // fall back to `session.policyKey` here — the policy key describes the
  // delivery target's policy, not the canonical control session, and
  // handing it to plugins that correlate against agent_end would be wrong.
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
    const payloadResultStartIndex = results.length;
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

      const replyHookResult = await applyReplyPayloadSendingHook({
        hook: params.replyPayloadSendingHook,
        payload,
      });
      if (replyHookResult.cancelled) {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "cancelled_by_reply_payload_sending_hook",
          }),
        );
        continue;
      }
      let deliveryPayload = replyHookResult.payload;
      payloadSummary = buildPayloadSummary(deliveryPayload);

      // Run message_sending plugin hook (may modify content or cancel)
      const hookResult = await applyMessageSendingHook({
        hookRunner,
        enabled: hasMessageSendingHooks,
        payload: deliveryPayload,
        payloadSummary,
        to,
        channel,
        accountId,
        replyToId: resolveCurrentReplyTo(deliveryPayload).replyToId,
        threadId: params.threadId,
        sessionKey: sessionKeyForInternalHooks,
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
      deliveryPayload = hookResult.payload;
      const presentationHandler = await getDeliveryHandler(
        buildPayloadSummary(deliveryPayload).mediaUrls,
      );
      const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(
        await renderPresentationForDelivery(presentationHandler, deliveryPayload),
      );
      const renderedHandler = await getDeliveryHandler(
        buildPayloadSummary(renderedPayload).mediaUrls,
      );
      const normalizedEffectivePayload = renderedHandler.normalizePayload
        ? renderedHandler.normalizePayload(renderedPayload)
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
              : replyHookResult.changed
                ? "empty_after_reply_payload_sending_hook"
                : "no_visible_payload",
          }),
        );
        continue;
      }
      payloadSummary = buildPayloadSummary(effectivePayload);
      const deliveryHandler = await getDeliveryHandler(payloadSummary.mediaUrls);
      const effectiveDeliveryKind = deliveryKindForPayload(effectivePayload, payloadSummary);
      effectiveDeliveryKinds.set(payloadIndex, effectiveDeliveryKind);
      startDeliveryDiagnostics(effectiveDeliveryKind);

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
      const deliveryTarget = deliveryHandler.buildTargetRef({ threadId: sendOverrides.threadId });
      if (
        deliveryHandler.sendPayload &&
        ((effectivePayload.isError === true &&
          deliveryHandler.sendTextOnlyErrorPayloads === true) ||
          hasReplyPayloadContent({
            presentation: effectivePayload.presentation,
            interactive: effectivePayload.interactive,
            channelData: effectivePayload.channelData,
          }) ||
          effectivePayload.audioAsVoice === true)
      ) {
        const beforeCount = results.length;
        const delivery = await deliveryHandler.sendPayload(
          effectivePayload,
          applySendReplyToConsumption(sendOverrides),
        );
        await recordIdentifiedDeliveryResult(delivery);
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length === 0) {
          completeDeliveryDiagnostics(0);
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
          continue;
        }
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
        recordDeliveredMirrorPayload(payloadSummary, deliveredResults);
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: deliveredResults.find((entry) => entry.messageId)?.messageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: true,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId: deliveredResults.at(-1)?.messageId,
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (deliveryHandler.sendFormattedText) {
          await recordIdentifiedDeliveryResults(
            await deliveryHandler.sendFormattedText(
              payloadSummary.text,
              applySendReplyToConsumption(sendOverrides),
            ),
          );
        } else {
          await sendTextChunks(deliveryHandler, payloadSummary.text, sendOverrides);
        }
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
          recordDeliveredMirrorPayload(payloadSummary, deliveredResults);
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = deliveredResults.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: deliveredResults.length > 0,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
        continue;
      }

      if (!deliveryHandler.supportsMedia) {
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
        await sendTextChunks(deliveryHandler, fallbackText, sendOverrides);
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
          recordDeliveredMirrorPayload(payloadSummary, deliveredResults);
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = deliveredResults.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: deliveredResults.length > 0,
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
        const delivery = deliveryHandler.sendFormattedMedia
          ? await deliveryHandler.sendFormattedMedia(
              unit.caption ?? "",
              unit.mediaUrl,
              unit.overrides,
            )
          : await deliveryHandler.sendMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides);
        if (await recordIdentifiedDeliveryResult(delivery)) {
          firstMessageId ??= delivery.messageId;
          lastMessageId = delivery.messageId;
        }
      }
      const deliveredResults = results.slice(beforeCount);
      if (deliveredResults.length > 0) {
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
        recordDeliveredMirrorPayload(payloadSummary, deliveredResults);
      } else {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "adapter_returned_no_identity",
          }),
        );
      }
      await maybePinDeliveredMessage({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget,
        messageId: firstMessageId,
        gatewayClientScopes: params.gatewayClientScopes,
      });
      await maybeNotifyAfterDeliveredPayload({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget,
        results: deliveredResults,
      });
      completeDeliveryDiagnostics(results.length - beforeCount);
      emitMessageSent({
        success: results.length > beforeCount,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        messageId: lastMessageId,
      });
    } catch (err) {
      // A rejected adapter has no final return to reconcile with its progress
      // results. Keep the results, but never match them to a later payload.
      reportedResults = [];
      const failedPayloadResults = results.slice(payloadResultStartIndex);
      recordPayloadOutcome({
        index: payloadIndex,
        status: "failed",
        error: err,
        sentBeforeError: failedPayloadResults.length > 0,
        stage: "platform_send",
        results: failedPayloadResults,
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
  if (params.mirror && deliveredMirrorPayloads.length > 0) {
    const deliveredMirror = {
      text: deliveredMirrorPayloads
        .map((payload) => payload.hookContent ?? payload.text)
        .filter((text) => text.trim())
        .join("\n"),
      mediaUrls: deliveredMirrorPayloads.flatMap((payload) => payload.mediaUrls),
    };
    const mirrorText = resolveMirroredTranscriptText({
      text: deliveredMirror.text,
      mediaUrls: deliveredMirror.mediaUrls,
    });
    if (mirrorText) {
      // Transcript mirroring is best-effort bookkeeping after platform send.
      // Keep mirror failures non-fatal so callers do not retry an already-sent
      // channel payload and create duplicate delivery.
      try {
        const { appendAssistantMessageToSessionTranscript } = await loadTranscriptRuntime();
        const mirrorResult = await appendAssistantMessageToSessionTranscript({
          agentId: params.mirror.agentId,
          sessionKey: params.mirror.sessionKey,
          text: mirrorText,
          idempotencyKey: params.mirror.idempotencyKey,
          config: params.cfg,
        });
        if (!mirrorResult.ok) {
          log.warn(
            `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${mirrorResult.reason}`,
            { channel, to, sessionKey: params.mirror.sessionKey },
          );
        }
      } catch (err) {
        log.warn(
          `failed to mirror outbound delivery into session transcript; channel send already succeeded: ${formatErrorMessage(err)}`,
          { channel, to, sessionKey: params.mirror.sessionKey },
        );
      }
    }
  }

  return results;
}
