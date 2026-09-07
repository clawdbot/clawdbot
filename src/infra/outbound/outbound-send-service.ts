// Outbound send service chooses plugin-handled message actions or the core
// message/poll path while preserving media policy and transcript mirrors.
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OutboundReplyFacts } from "../../channels/message/types.js";
import { normalizeConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelOutboundAdapter,
} from "../../channels/plugins/types.public.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { getOwnedSessionTranscriptWriterFence } from "../../config/sessions/transcript-write-context.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import type { NormalizedOutboundPayload } from "./deliver.js";
import type { ResolvedActionContext } from "./message-action-contracts.js";
import { collectActionMediaSourceHints } from "./message-action-params.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import type { OutboundMirror } from "./mirror.js";

const log = createSubsystemLogger("outbound/send-service");

type OutboundSendContext = Omit<ResolvedActionContext, "mediaAccess"> & {
  mediaAccess?: OutboundMediaAccess;
  conversationType?: ChatType;
  mirror?: OutboundMirror;
  silent?: boolean;
  /** The caller resends proven-not-sent payloads itself, so recovery must not. */
  deliveryRetryOwner?: "caller";
  /** Commits the route after platform evidence, before either delivery mirror. */
  onSendAccepted?: () => Promise<void>;
};

type PluginHandledResult = {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
};

type SendMessageParams = Parameters<typeof sendMessage>[0];

export function materializeMessagePresentationFallback(params: {
  payload: Pick<ReplyPayload, "presentation" | "text">;
  text?: string;
}): string {
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const text = (params.text ?? params.payload.text ?? "").trim();
  if (!presentation) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation });
  if (!fallback || text.includes(fallback)) {
    return text;
  }
  return [text, fallback].filter(Boolean).join("\n\n");
}

export function hasCorePresentationDelivery(outbound?: ChannelOutboundAdapter): boolean {
  return Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText);
}

async function sendCoreMessage(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  buffer?: string;
  filename?: string;
  contentType?: string;
  asVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  bestEffort?: boolean;
  reply?: OutboundReplyFacts;
  threadId?: string | number;
  queuePolicy: NonNullable<SendMessageParams["queuePolicy"]>;
  payloads?: SendMessageParams["payloads"];
}): Promise<{ result: MessageSendResult; deliveredText?: string }> {
  const deliveredPayloads: NormalizedOutboundPayload[] = [];
  const result = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: params.message,
    ...(params.payloads ? { payloads: params.payloads } : {}),
    agentId: params.ctx.agentId,
    requesterSessionKey: params.ctx.input.sessionKey,
    requesterAccountId: params.ctx.input.requesterAccountId ?? params.ctx.accountId ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    requesterSenderName: params.ctx.input.requesterSenderName ?? undefined,
    requesterSenderUsername: params.ctx.input.requesterSenderUsername ?? undefined,
    requesterSenderE164: params.ctx.input.requesterSenderE164 ?? undefined,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    asVoice: params.asVoice,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    conversationType: params.ctx.conversationType,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(
      params.ctx.input.conversationReadOrigin,
    ),
    reply: params.reply,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    queuePolicy: params.queuePolicy,
    deps: params.ctx.input.deps,
    gateway: params.ctx.gateway,
    idempotencyKey: params.ctx.idempotencyKey,
    runId: params.ctx.input.runId,
    executionIdentityToken: params.ctx.input.executionIdentityToken,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
    mediaAccess: params.ctx.mediaAccess,
    preparedMessageId: params.ctx.input.preparedMessageId,
    preparedPlugin: params.ctx.channelPlugin,
    gatewayOwnedDelivery: params.ctx.input.gatewayOwnedDelivery,
    deliveryIntentId: params.ctx.input.deliveryIntentId,
    deliveryCompletion: params.ctx.input.deliveryCompletion,
    deliveryRetryOwner: params.ctx.deliveryRetryOwner,
    requireUnknownSendReconciliation: params.ctx.input.requireQueuePersistence ? false : undefined,
    onDeliveryIntent: params.ctx.input.onDeliveryIntent,
    onDeliveryAttempt: params.ctx.input.onDeliveryAttempt,
    onDeliveryResult: async (evidence) => {
      await params.ctx.onSendAccepted?.();
      await params.ctx.input.onDeliveryResult?.(evidence);
    },
    onPlatformSendDispatch: params.ctx.input.onPlatformSendDispatch,
    assertDirectAdapterHandoff: params.ctx.input.assertDirectAdapterHandoff,
    skipQueue: params.ctx.input.skipQueue,
    onDeliveredPayload: (payload) => deliveredPayloads.push(payload),
  });
  const deliveredText =
    result.deliveryStatus === "sent" &&
    deliveredPayloads.every(
      (payload) => payload.mediaUrls.length === 0 && payload.audioAsVoice !== true,
    )
      ? deliveredPayloads
          .map((payload) => payload.text)
          .filter((text) => text.trim())
          .join("\n")
      : "";
  return {
    result,
    ...(deliveredText ? { deliveredText } : {}),
  };
}

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  reply?: OutboundReplyFacts;
  onHandled?: () => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  // Plugin actions receive media access scoped to the same requester/session
  // policy as core delivery so custom handlers cannot widen file reads.
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.ctx.cfg,
    agentId: params.ctx.agentId ?? params.ctx.mirror?.agentId,
    mediaSources: collectActionMediaSourceHints(params.ctx.params, undefined, {
      structuredAttachments: params.action === "send" ? "all" : undefined,
    }),
    sessionKey: params.ctx.input.sessionKey,
    messageProvider: params.ctx.input.sessionKey ? undefined : params.ctx.channel,
    accountId:
      (params.ctx.input.sessionKey
        ? (params.ctx.input.requesterAccountId ?? params.ctx.accountId)
        : params.ctx.accountId) ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    requesterSenderName: params.ctx.input.requesterSenderName ?? undefined,
    requesterSenderUsername: params.ctx.input.requesterSenderUsername ?? undefined,
    requesterSenderE164: params.ctx.input.requesterSenderE164 ?? undefined,
    mediaAccess: params.ctx.mediaAccess,
  });
  const handled = await dispatchChannelMessageAction(
    createChannelActionContext({
      ctx: params.ctx,
      action: params.action,
      mediaAccess,
      reply: params.reply,
    }),
  );
  if (!handled) {
    return null;
  }
  await params.onHandled?.();
  return {
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

function createChannelActionContext(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  mediaAccess?: ReturnType<typeof resolveAgentScopedOutboundMediaAccess>;
  reply?: OutboundReplyFacts;
}): ChannelMessageActionContext {
  const mediaAccess = params.mediaAccess ?? params.ctx.mediaAccess;
  return {
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    ...(params.reply ? { reply: params.reply } : {}),
    ...(mediaAccess ? { mediaAccess } : {}),
    mediaLocalRoots: mediaAccess?.localRoots,
    mediaReadFile: mediaAccess?.readFile,
    accountId: params.ctx.accountId ?? undefined,
    requesterAccountId: params.ctx.input.requesterAccountId ?? undefined,
    requesterSenderId: params.ctx.input.requesterSenderId ?? undefined,
    senderIsOwner: params.ctx.input.senderIsOwner,
    conversationReadOrigin: normalizeConversationReadInvocationOrigin(
      params.ctx.input.conversationReadOrigin,
    ),
    sessionKey: params.ctx.input.sessionKey,
    sessionId: params.ctx.input.sessionId,
    inboundEventKind: params.ctx.input.inboundEventKind,
    agentId: params.ctx.agentId,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.input.toolContext,
    dryRun: params.ctx.dryRun,
    ...(params.action === "send"
      ? {
          onPlatformSendDispatch: params.ctx.input.onPlatformSendDispatch,
          assertDirectAdapterHandoff: params.ctx.input.assertDirectAdapterHandoff,
          skipQueue: params.ctx.input.skipQueue,
        }
      : {}),
  };
}

type PluginSendPayloadPreparation =
  | { kind: "unavailable" }
  | { kind: "declined" }
  | { kind: "prepared"; payload: ReplyPayload };

async function preparePluginSendPayload(params: {
  ctx: OutboundSendContext;
  to: string;
  payload: ReplyPayload;
  reply?: OutboundReplyFacts;
  threadId?: string | number;
}): Promise<PluginSendPayloadPreparation> {
  const plugin = params.ctx.channelPlugin;
  if (!plugin?.outbound) {
    return { kind: "unavailable" };
  }
  const prepareSendPayload = plugin?.actions?.prepareSendPayload;
  if (!prepareSendPayload) {
    return { kind: "unavailable" };
  }
  const payload = await prepareSendPayload({
    ctx: createChannelActionContext({ ctx: params.ctx, action: "send", reply: params.reply }),
    to: params.to,
    payload: params.payload,
    replyToId: params.reply?.replyToId,
    replyToIdSource: params.reply?.source,
    threadId: params.threadId,
  });
  // A null result is an ownership decision: the provider-native payload cannot
  // use durable core delivery, so even a presentation must stay on the action path.
  return payload ? { kind: "prepared", payload } : { kind: "declined" };
}

/** Executes a message-tool send through plugin handlers or the core outbound path. */
export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  payload?: ReplyPayload;
  mediaUrl?: string;
  mediaUrls?: string[];
  buffer?: string;
  filename?: string;
  contentType?: string;
  asVoice?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  bestEffort?: boolean;
  reply?: OutboundReplyFacts;
  threadId?: string | number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  /** Exact text handed to the direct transport after core normalization and hooks. */
  deliveredText?: string;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);
  const defaultPayload: ReplyPayload = params.payload ?? {
    text: params.message,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
    audioAsVoice: params.asVoice === true,
  };
  const queuePolicy =
    params.bestEffort === false || params.ctx.input.requireQueuePersistence
      ? "required"
      : "best_effort";
  // Queue persistence cannot be guaranteed by provider-native action handlers.
  // Treat the guarantee as forcing the one core path at every dispatch gate.
  const requiresCoreDelivery =
    params.ctx.input.forceCoreDelivery === true ||
    params.ctx.input.requireQueuePersistence === true;
  const pluginPreparation = requiresCoreDelivery
    ? ({ kind: "unavailable" } as const)
    : await preparePluginSendPayload({
        ctx: params.ctx,
        to: params.to,
        payload: defaultPayload,
        reply: params.reply,
        threadId: params.threadId,
      });
  const channelPlugin = params.ctx.channelPlugin;
  const presentation = normalizeMessagePresentation(defaultPayload.presentation);
  const corePayload = requiresCoreDelivery
    ? defaultPayload
    : pluginPreparation.kind === "prepared"
      ? pluginPreparation.payload
      : pluginPreparation.kind === "unavailable" &&
          presentation &&
          hasCorePresentationDelivery(channelPlugin?.outbound)
        ? defaultPayload
        : null;
  if (!corePayload) {
    const pluginMessage = presentation
      ? materializeMessagePresentationFallback({ payload: defaultPayload, text: params.message })
      : params.message;
    const pluginCtx =
      pluginMessage === params.message
        ? params.ctx
        : {
            ...params.ctx,
            params: { ...params.ctx.params, message: pluginMessage },
          };
    const pluginHandled = await tryHandleWithPluginAction({
      ctx: pluginCtx,
      action: "send",
      reply: params.reply,
      onHandled: async () => {
        // The accepted-send commit must precede the transcript mirror below:
        // first-contact outbound routes create their session row in it.
        await params.ctx.onSendAccepted?.();
        if (!params.ctx.mirror) {
          return;
        }
        const materializedPresentationFallback = pluginMessage !== params.message;
        const mirrorText = materializedPresentationFallback
          ? pluginMessage
          : params.ctx.mirror.text?.trim() || pluginMessage;
        const mirrorMediaUrls =
          params.ctx.mirror.mediaUrls ??
          params.mediaUrls ??
          (params.mediaUrl ? [params.mediaUrl] : undefined);
        try {
          const writerFence = getOwnedSessionTranscriptWriterFence({
            sessionKey: params.ctx.mirror.sessionKey,
          });
          const mirrorResult = await appendAssistantMessageToSessionTranscript({
            agentId: params.ctx.mirror.agentId,
            sessionKey: params.ctx.mirror.sessionKey,
            expectedSessionId: params.ctx.mirror.expectedSessionId,
            ...(writerFence?.expectedLifecycleRevision !== undefined
              ? { expectedLifecycleRevision: writerFence.expectedLifecycleRevision }
              : {}),
            ...(writerFence ? { expectedWriterRunId: writerFence.expectedWriterRunId } : {}),
            text: mirrorText,
            mediaUrls: mirrorMediaUrls,
            idempotencyKey: params.ctx.mirror.idempotencyKey,
            deliveryMirror: params.ctx.mirror.deliveryMirror,
            config: params.ctx.cfg,
          });
          if (!mirrorResult.ok) {
            log.warn(
              `failed to mirror plugin-handled delivery; channel send already succeeded: ${mirrorResult.reason}`,
            );
          }
        } catch (error) {
          log.warn(
            `failed to mirror plugin-handled delivery; channel send already succeeded: ${formatErrorMessage(error)}`,
          );
        }
      },
    });
    if (pluginHandled) {
      return pluginHandled;
    }
  }

  throwIfAborted(params.ctx.abortSignal);
  // Prepared payloads and presentations share core queueing, hooks, and mirrors.
  // The legacy gateway send RPC accepts text/media, so materialize its fallback.
  const message =
    corePayload &&
    normalizeMessagePresentation(corePayload.presentation) &&
    channelPlugin?.outbound?.deliveryMode === "gateway"
      ? materializeMessagePresentationFallback({ payload: corePayload, text: params.message })
      : params.message;
  const delivery = await sendCoreMessage({
    ...params,
    message,
    ...(corePayload ? { payloads: [corePayload] } : {}),
    queuePolicy,
  });

  return {
    handledBy: "core",
    payload: delivery.result,
    ...(delivery.deliveredText ? { deliveredText: delivery.deliveredText } : {}),
    sendResult: delivery.result,
  };
}

/** Executes a message-tool poll through plugin handlers or the core poll path. */
export async function executePollAction(params: {
  ctx: OutboundSendContext;
  resolveCorePoll: () => {
    to: string;
    question: string;
    content?: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
    threadId?: string;
    isAnonymous?: boolean;
  };
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "poll",
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  const corePoll = params.resolveCorePoll();
  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: corePoll.to,
    question: corePoll.question,
    content: corePoll.content,
    options: corePoll.options,
    maxSelections: corePoll.maxSelections,
    durationSeconds: corePoll.durationSeconds ?? undefined,
    durationHours: corePoll.durationHours ?? undefined,
    channel: params.ctx.channel,
    accountId: params.ctx.accountId ?? undefined,
    threadId: corePoll.threadId ?? undefined,
    silent: params.ctx.silent ?? undefined,
    isAnonymous: corePoll.isAnonymous ?? undefined,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
    idempotencyKey: params.ctx.idempotencyKey,
    preparedPlugin: params.ctx.channelPlugin,
    sessionKey: params.ctx.input.sessionKey,
    inboundEventKind: params.ctx.input.inboundEventKind,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
