// Outbound send service chooses plugin-handled message actions or the core
// message/poll path while preserving media policy and transcript mirrors.
import type { AgentToolResult } from "../../agents/runtime/index.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import type { DurableMessageSendIntent } from "../../channels/message/types.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionContext,
  ChannelOutboundAdapter,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import type { NormalizedOutboundPayload, OutboundSendDeps } from "./deliver.js";
import type { DurableDeliveryCompletion } from "./delivery-completion.js";
import { collectActionMediaSourceHints } from "./message-action-params.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import type { OutboundMirror } from "./mirror.js";

const log = createSubsystemLogger("outbound/send-service");

/** Gateway connection settings forwarded to outbound send helpers. */
type OutboundGatewayContext = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

/** Shared execution context for message-tool send and poll actions. */
type OutboundSendContext = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
  sessionKey?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  senderIsOwner?: boolean;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  mediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaReadFile;
  accountId?: string | null;
  /** Known destination conversation kind prepared by the caller. */
  conversationType?: ChatType;
  sessionId?: string;
  inboundEventKind?: InboundEventKind;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: OutboundMirror;
  abortSignal?: AbortSignal;
  silent?: boolean;
  /** Channel-valid id reserved before a correlated conversation turn is sent. */
  preparedMessageId?: string;
  /** The Gateway owns this call and may use its active gateway-mode adapter directly. */
  gatewayOwnedDelivery?: boolean;
  /** Bypass provider-native actions so core durable delivery owns the send. */
  forceCoreDelivery?: boolean;
  /** Fail before platform I/O unless the core delivery queue persisted the intent. */
  requireQueuePersistence?: boolean;
  /** Stable producer id for idempotent durable queue creation. */
  deliveryIntentId?: string;
  /** Serializable owner state finalized by live send or recovery. */
  deliveryCompletion?: DurableDeliveryCompletion;
  /** Runs after queue persistence and before platform I/O. */
  onDeliveryIntent?: (intent: DurableMessageSendIntent) => void;
  /** Runs on identified platform evidence before queue acknowledgement. */
  onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
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
  replyToId?: string;
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
    requesterSessionKey: params.ctx.sessionKey,
    requesterAccountId: params.ctx.requesterAccountId ?? params.ctx.accountId ?? undefined,
    requesterSenderId: params.ctx.requesterSenderId,
    requesterSenderName: params.ctx.requesterSenderName,
    requesterSenderUsername: params.ctx.requesterSenderUsername,
    requesterSenderE164: params.ctx.requesterSenderE164,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    buffer: params.buffer,
    filename: params.filename,
    contentType: params.contentType,
    asVoice: params.asVoice,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    conversationType: params.ctx.conversationType,
    conversationReadOrigin: params.ctx.conversationReadOrigin,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    queuePolicy: params.queuePolicy,
    deps: params.ctx.deps,
    gateway: params.ctx.gateway,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
    mediaAccess: params.ctx.mediaAccess,
    preparedMessageId: params.ctx.preparedMessageId,
    gatewayOwnedDelivery: params.ctx.gatewayOwnedDelivery,
    deliveryIntentId: params.ctx.deliveryIntentId,
    deliveryCompletion: params.ctx.deliveryCompletion,
    requireUnknownSendReconciliation: params.ctx.requireQueuePersistence ? false : undefined,
    onDeliveryIntent: params.ctx.onDeliveryIntent,
    onDeliveryResult: params.ctx.onDeliveryResult,
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
    sessionKey: params.ctx.sessionKey,
    messageProvider: params.ctx.sessionKey ? undefined : params.ctx.channel,
    accountId:
      (params.ctx.sessionKey
        ? (params.ctx.requesterAccountId ?? params.ctx.accountId)
        : params.ctx.accountId) ?? undefined,
    requesterSenderId: params.ctx.requesterSenderId,
    requesterSenderName: params.ctx.requesterSenderName,
    requesterSenderUsername: params.ctx.requesterSenderUsername,
    requesterSenderE164: params.ctx.requesterSenderE164,
    mediaAccess: params.ctx.mediaAccess,
    mediaReadFile: params.ctx.mediaReadFile,
  });
  const handled = await dispatchChannelMessageAction(
    createChannelActionContext({
      ctx: params.ctx,
      action: params.action,
      mediaAccess,
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
}): ChannelMessageActionContext {
  const mediaAccess = params.mediaAccess ?? params.ctx.mediaAccess;
  return {
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    ...(mediaAccess ? { mediaAccess } : {}),
    mediaLocalRoots: mediaAccess?.localRoots ?? params.ctx.mediaAccess?.localRoots,
    mediaReadFile: mediaAccess?.readFile ?? params.ctx.mediaReadFile,
    accountId: params.ctx.accountId ?? undefined,
    requesterAccountId: params.ctx.requesterAccountId,
    requesterSenderId: params.ctx.requesterSenderId,
    senderIsOwner: params.ctx.senderIsOwner,
    conversationReadOrigin: params.ctx.conversationReadOrigin,
    sessionKey: params.ctx.sessionKey,
    sessionId: params.ctx.sessionId,
    inboundEventKind: params.ctx.inboundEventKind,
    agentId: params.ctx.agentId,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    dryRun: params.ctx.dryRun,
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
  replyToId?: string;
  replyToIdSource?: "explicit" | "implicit";
  threadId?: string | number;
}): Promise<PluginSendPayloadPreparation> {
  const plugin = resolveOutboundChannelPlugin({
    channel: params.ctx.channel,
    cfg: params.ctx.cfg,
  });
  if (!plugin?.outbound) {
    return { kind: "unavailable" };
  }
  const prepareSendPayload = plugin?.actions?.prepareSendPayload;
  if (!prepareSendPayload) {
    return { kind: "unavailable" };
  }
  const payload = await prepareSendPayload({
    ctx: createChannelActionContext({ ctx: params.ctx, action: "send" }),
    to: params.to,
    payload: params.payload,
    replyToId: params.replyToId,
    replyToIdSource: params.replyToIdSource,
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
  replyToId?: string;
  replyToIdSource?: "explicit" | "implicit";
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
    params.bestEffort === false || params.ctx.requireQueuePersistence ? "required" : "best_effort";
  // Queue persistence cannot be guaranteed by provider-native action handlers.
  // Treat the guarantee as forcing the one core path at every dispatch gate.
  const requiresCoreDelivery =
    params.ctx.forceCoreDelivery === true || params.ctx.requireQueuePersistence === true;
  const pluginPreparation = requiresCoreDelivery
    ? ({ kind: "unavailable" } as const)
    : await preparePluginSendPayload({
        ctx: params.ctx,
        to: params.to,
        payload: defaultPayload,
        replyToId: params.replyToId,
        replyToIdSource: params.replyToIdSource,
        threadId: params.threadId,
      });
  const channelPlugin = resolveOutboundChannelPlugin({
    channel: params.ctx.channel,
    cfg: params.ctx.cfg,
  });
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
  if (corePayload) {
    throwIfAborted(params.ctx.abortSignal);
    const corePresentation = normalizeMessagePresentation(corePayload.presentation);
    const message =
      corePresentation && channelPlugin?.outbound?.deliveryMode === "gateway"
        ? materializeMessagePresentationFallback({
            payload: corePayload,
            text: params.message,
          })
        : params.message;
    // Prepared payloads and portable presentations need core delivery so queueing,
    // presentation rendering/adaptation, hooks, and mirrors stay uniform. The legacy
    // gateway `send` method accepts text/media only, so materialize its fallback here.
    const delivery = await sendCoreMessage({
      ...params,
      message,
      queuePolicy,
      payloads: [corePayload],
    });

    return {
      handledBy: "core",
      payload: delivery.result,
      ...(delivery.deliveredText ? { deliveredText: delivery.deliveredText } : {}),
      sendResult: delivery.result,
    };
  }

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
  const pluginHandled = requiresCoreDelivery
    ? null
    : await tryHandleWithPluginAction({
        ctx: pluginCtx,
        action: "send",
        onHandled: async () => {
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
            const mirrorResult = await appendAssistantMessageToSessionTranscript({
              agentId: params.ctx.mirror.agentId,
              sessionKey: params.ctx.mirror.sessionKey,
              expectedSessionId: params.ctx.mirror.expectedSessionId,
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

  throwIfAborted(params.ctx.abortSignal);
  const delivery = await sendCoreMessage({
    ...params,
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
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
