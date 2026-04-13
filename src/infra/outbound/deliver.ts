import { sendMediaWithLeadingCaption } from "openclaw/plugin-sdk/reply-payload";
import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "../../channels/plugins/types.adapters.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "./delivery-queue.js";
import type { OutboundIdentity } from "./identity.js";
import type { DeliveryMirror } from "./mirror.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
  type OutboundPayloadPlan,
} from "./payloads.js";
import { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

export type { OutboundDeliveryResult } from "./deliver-types.js";
export type { NormalizedOutboundPayload } from "./payloads.js";
export { normalizeOutboundPayloads } from "./payloads.js";
export { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";

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

type Chunker = (text: string, limit: number) => string[];

type ChannelHandler = {
  chunker: Chunker | null;
  chunkerMode?: "text" | "markdown";
  textChunkLimit?: number;
  supportsMedia: boolean;
  sanitizeText?: (payload: ReplyPayload) => string;
  normalizePayload?: (payload: ReplyPayload) => ReplyPayload | null;
  shouldSkipPlainTextSanitization?: (payload: ReplyPayload) => boolean;
  resolveEffectiveTextChunkLimit?: (fallbackLimit?: number) => number | undefined;
  sendPayload?: (
    payload: ReplyPayload,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendFormattedText?: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult[]>;
  sendFormattedMedia?: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendText: (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
  sendMedia: (
    caption: string,
    mediaUrl: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => Promise<OutboundDeliveryResult>;
};

type ChannelHandlerParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  silent?: boolean;
  mediaAccess?: OutboundMediaAccess;
  gatewayClientScopes?: readonly string[];
};

// Channel docking: outbound delivery delegates to plugin.outbound adapters.
async function createChannelHandler(params: ChannelHandlerParams): Promise<ChannelHandler> {
  let outbound = await loadChannelOutboundAdapter(params.channel);
  if (!outbound) {
    const { bootstrapOutboundChannelPlugin } = await loadChannelBootstrapRuntime();
    bootstrapOutboundChannelPlugin({
      channel: params.channel,
      cfg: params.cfg,
    });
    outbound = await loadChannelOutboundAdapter(params.channel);
  }
  const handler = createPluginHandler({ ...params, outbound });
  if (!handler) {
    throw new Error(`Outbound not configured for channel: ${params.channel}`);
  }
  return handler;
}

function createPluginHandler(
  params: ChannelHandlerParams & { outbound?: ChannelOutboundAdapter },
): ChannelHandler | null {
  const outbound = params.outbound;
  if (!outbound?.sendText) {
    return null;
  }
  const baseCtx = createChannelOutboundContextBase(params);
  const sendText = outbound.sendText;
  const sendMedia = outbound.sendMedia;
  const chunker = outbound.chunker ?? null;
  const chunkerMode = outbound.chunkerMode;
  const resolveCtx = (overrides?: {
    replyToId?: string | null;
    threadId?: string | number | null;
    audioAsVoice?: boolean;
  }): Omit<ChannelOutboundContext, "text" | "mediaUrl"> => ({
    ...baseCtx,
    replyToId: overrides?.replyToId ?? baseCtx.replyToId,
    threadId: overrides?.threadId ?? baseCtx.threadId,
    audioAsVoice: overrides?.audioAsVoice,
  });
  return {
    chunker,
    chunkerMode,
    textChunkLimit: outbound.textChunkLimit,
    supportsMedia: Boolean(sendMedia),
    sanitizeText: outbound.sanitizeText
      ? (payload) => outbound.sanitizeText!({ text: payload.text ?? "", payload })
      : undefined,
    normalizePayload: outbound.normalizePayload
      ? (payload) => outbound.normalizePayload!({ payload })
      : undefined,
    shouldSkipPlainTextSanitization: outbound.shouldSkipPlainTextSanitization
      ? (payload) => outbound.shouldSkipPlainTextSanitization!({ payload })
      : undefined,
    resolveEffectiveTextChunkLimit: outbound.resolveEffectiveTextChunkLimit
      ? (fallbackLimit) =>
          outbound.resolveEffectiveTextChunkLimit!({
            cfg: params.cfg,
            accountId: params.accountId ?? undefined,
            fallbackLimit,
          })
      : undefined,
    sendPayload: outbound.sendPayload
      ? async (payload, overrides) =>
          outbound.sendPayload!({
            ...resolveCtx(overrides),
            text: payload.text ?? "",
            mediaUrl: payload.mediaUrl,
            payload,
          })
      : undefined,
    sendFormattedText: outbound.sendFormattedText
      ? async (text, overrides) =>
          outbound.sendFormattedText!({
            ...resolveCtx(overrides),
            text,
          })
      : undefined,
    sendFormattedMedia: outbound.sendFormattedMedia
      ? async (caption, mediaUrl, overrides) =>
          outbound.sendFormattedMedia!({
            ...resolveCtx(overrides),
            text: caption,
            mediaUrl,
          })
      : undefined,
    sendText: async (text, overrides) =>
      sendText({
        ...resolveCtx(overrides),
        text,
      }),
    sendMedia: async (caption, mediaUrl, overrides) => {
      if (sendMedia) {
        return sendMedia({
          ...resolveCtx(overrides),
          text: caption,
          mediaUrl,
        });
      }
      return sendText({
        ...resolveCtx(overrides),
        text: caption,
      });
    },
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

type DeliverOutboundPayloadsCoreParams = {
  cfg: OpenClawConfig;
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  payloads: ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  identity?: OutboundIdentity;
  deps?: OutboundSendDeps;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  abortSignal?: AbortSignal;
  bestEffort?: boolean;
  onError?: (err: unknown, payload: NormalizedOutboundPayload) => void;
  onPayload?: (payload: NormalizedOutboundPayload) => void;
  /** Session/agent context used for hooks and media local-root scoping. */
  session?: OutboundSessionContext;
  mirror?: DeliveryMirror;
  silent?: boolean;
  gatewayClientScopes?: readonly string[];
};

function collectPayloadMediaSources(plan: readonly OutboundPayloadPlan[]): string[] {
  return plan.flatMap((entry) => entry.parts.mediaUrls);
}

export type DeliverOutboundPayloadsParams = DeliverOutboundPayloadsCoreParams & {
  /** @internal Skip write-ahead queue (used by crash-recovery to avoid re-enqueueing). */
  skipQueue?: boolean;
};

type MessageSentEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
};

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

function normalizePayloadsForChannelDelivery(
  plan: readonly OutboundPayloadPlan[],
  handler: ChannelHandler,
): ReplyPayload[] {
  const normalizedPayloads: ReplyPayload[] = [];
  for (const payload of projectOutboundPayloadPlanForDelivery(plan)) {
    let sanitizedPayload = payload;
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
      ? normalizeEmptyPayloadForDelivery(normalizedPayload)
      : null;
    if (normalized) {
      normalizedPayloads.push(normalized);
    }
  }
  return normalizedPayloads;
}

function buildPayloadSummary(payload: ReplyPayload): NormalizedOutboundPayload {
  return summarizeOutboundPayloadForTransport(payload);
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
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  if (!params.enabled) {
    return {
      cancelled: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.text,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
      },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
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
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function deliverOutboundPayloads(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const { channel, to, payloads } = params;

  // Write-ahead delivery queue: persist before sending, remove after success.
  const queueId = params.skipQueue
    ? null
    : await enqueueDelivery({
        channel,
        to,
        accountId: params.accountId,
        payloads,
        threadId: params.threadId,
        replyToId: params.replyToId,
        bestEffort: params.bestEffort,
        gifPlayback: params.gifPlayback,
        forceDocument: params.forceDocument,
        silent: params.silent,
        mirror: params.mirror,
        gatewayClientScopes: params.gatewayClientScopes,
      }).catch(() => null); // Best-effort — don't block delivery if queue write fails.

  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // without throwing — so the outer try/catch never fires. We track whether any
  // payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  const wrappedParams = params.onError
    ? {
        ...params,
        onError: (err: unknown, payload: NormalizedOutboundPayload) => {
          hadPartialFailure = true;
          params.onError!(err, payload);
        },
      }
    : params;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    if (queueId) {
      if (hadPartialFailure) {
        await failDelivery(queueId, "partial delivery failure (bestEffort)").catch(() => {});
      } else {
        await ackDelivery(queueId).catch(() => {}); // Best-effort cleanup.
      }
    }
    return results;
  } catch (err) {
    if (queueId) {
      if (isAbortError(err)) {
        await ackDelivery(queueId).catch(() => {});
      } else {
        await failDelivery(queueId, formatErrorMessage(err)).catch(() => {});
      }
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const outboundPayloadPlan = createOutboundPayloadPlan(payloads);
  const accountId = params.accountId;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg,
    agentId: params.session?.agentId ?? params.mirror?.agentId,
    mediaSources: collectPayloadMediaSources(outboundPayloadPlan),
    sessionKey: params.session?.key,
    messageProvider: params.session?.key ? undefined : channel,
    accountId: params.session?.requesterAccountId ?? accountId,
    requesterSenderId: params.session?.requesterSenderId,
    requesterSenderName: params.session?.requesterSenderName,
    requesterSenderUsername: params.session?.requesterSenderUsername,
    requesterSenderE164: params.session?.requesterSenderE164,
  });
  const results: OutboundDeliveryResult[] = [];
  const handler = await createChannelHandler({
    cfg,
    channel,
    to,
    deps,
    accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    identity: params.identity,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    silent: params.silent,
    mediaAccess,
    gatewayClientScopes: params.gatewayClientScopes,
  });
  const configuredTextLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const textLimit = handler.resolveEffectiveTextChunkLimit
    ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit)
    : configuredTextLimit;
  const chunkMode = handler.chunker ? resolveChunkMode(cfg, channel, accountId) : "length";

  const sendTextChunks = async (
    text: string,
    overrides?: {
      replyToId?: string | null;
      threadId?: string | number | null;
      audioAsVoice?: boolean;
    },
  ) => {
    throwIfAborted(abortSignal);
    if (!handler.chunker || textLimit === undefined) {
      results.push(await handler.sendText(text, overrides));
      return;
    }
    if (chunkMode === "newline") {
      const mode = handler.chunkerMode ?? "text";
      const blockChunks =
        mode === "markdown"
          ? chunkMarkdownTextWithMode(text, textLimit, "newline")
          : chunkByParagraph(text, textLimit);

      if (!blockChunks.length && text) {
        blockChunks.push(text);
      }
      for (const blockChunk of blockChunks) {
        const chunks = handler.chunker(blockChunk, textLimit);
        if (!chunks.length && blockChunk) {
          chunks.push(blockChunk);
        }
        for (const chunk of chunks) {
          throwIfAborted(abortSignal);
          results.push(await handler.sendText(chunk, overrides));
        }
      }
      return;
    }
    const chunks = handler.chunker(text, textLimit);
    for (const chunk of chunks) {
      throwIfAborted(abortSignal);
      results.push(await handler.sendText(chunk, overrides));
    }
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
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
  for (const payload of normalizedPayloads) {
    let payloadSummary = buildPayloadSummary(payload);
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
      });
      if (hookResult.cancelled) {
        continue;
      }
      const effectivePayload = hookResult.payload;
      payloadSummary = hookResult.payloadSummary;

      params.onPayload?.(payloadSummary);
      const sendOverrides = {
        replyToId: effectivePayload.replyToId ?? params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        audioAsVoice: effectivePayload.audioAsVoice === true ? true : undefined,
        forceDocument: params.forceDocument,
      };
      if (
        handler.sendPayload &&
        hasReplyPayloadContent({
          interactive: effectivePayload.interactive,
          channelData: effectivePayload.channelData,
        })
      ) {
        const delivery = await handler.sendPayload(effectivePayload, sendOverrides);
        results.push(delivery);
        emitMessageSent({
          success: true,
          content: payloadSummary.text,
          messageId: delivery.messageId,
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (handler.sendFormattedText) {
          results.push(...(await handler.sendFormattedText(payloadSummary.text, sendOverrides)));
        } else {
          await sendTextChunks(payloadSummary.text, sendOverrides);
        }
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.text,
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
        const messageId = results.at(-1)?.messageId;
        emitMessageSent({
          success: results.length > beforeCount,
          content: payloadSummary.text,
          messageId,
        });
        continue;
      }

      let lastMessageId: string | undefined;
      await sendMediaWithLeadingCaption({
        mediaUrls: payloadSummary.mediaUrls,
        caption: payloadSummary.text,
        send: async ({ mediaUrl, caption }) => {
          throwIfAborted(abortSignal);
          if (handler.sendFormattedMedia) {
            const delivery = await handler.sendFormattedMedia(
              caption ?? "",
              mediaUrl,
              sendOverrides,
            );
            results.push(delivery);
            lastMessageId = delivery.messageId;
            return;
          }
          const delivery = await handler.sendMedia(caption ?? "", mediaUrl, sendOverrides);
          results.push(delivery);
          lastMessageId = delivery.messageId;
        },
      });
      emitMessageSent({
        success: true,
        content: payloadSummary.text,
        messageId: lastMessageId,
      });
    } catch (err) {
      emitMessageSent({
        success: false,
        content: payloadSummary.text,
        error: formatErrorMessage(err),
      });
      if (!params.bestEffort) {
        throw err;
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
      });
    }
  }

  return results;
}
