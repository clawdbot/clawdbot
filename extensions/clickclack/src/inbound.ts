import {
  buildChannelInboundEventContext,
  createChannelInboundEnvelopeBuilder,
  recordChannelBotPairLoopAndCheckSuppression,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  deriveDurableFinalDeliveryRequirements,
} from "openclaw/plugin-sdk/channel-outbound";
/**
 * Converts authorized ClickClack messages into OpenClaw agent/model replies and
 * routes resulting outbound text back to ClickClack.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveClickClackInboundAccess, type ClickClackInboundAccess } from "./access.js";
import { createClickClackActivityPublisher, type ClickClackActivityPublisher } from "./activity.js";
import { createClickClackClient } from "./http-client.js";
import { sendClickClackText } from "./outbound.js";
import {
  createClickClackAgentProgressPublisher,
  type ClickClackItemEventPayload,
} from "./progress.js";
import { getClickClackRuntime } from "./runtime.js";
import type {
  ClickClackMessage,
  ClickClackMessageProvenance,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const CHANNEL_ID = "clickclack" as const;
const CLICKCLACK_MESSAGE_ID_PATTERN = /^msg_[0-9a-hjkmnp-tv-z]{26}$/u;

function hasClickClackReplyMedia(payload: {
  mediaUrl?: string;
  mediaUrls?: readonly string[];
}): boolean {
  return Boolean(
    payload.mediaUrl?.trim() ||
    payload.mediaUrls?.some((mediaUrl) => typeof mediaUrl === "string" && mediaUrl.trim()),
  );
}

function resolveClickClackAgentRunId(messageId: string): string | undefined {
  return CLICKCLACK_MESSAGE_ID_PATTERN.test(messageId) ? `${CHANNEL_ID}:${messageId}` : undefined;
}

async function dispatchModelReply(params: {
  account: ResolvedClickClackAccount;
  cfg: OpenClawConfig;
  message: ClickClackMessage;
  route: { agentId: string };
  target: string;
  correlationId?: string;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const runtime = getClickClackRuntime();
  const result = await runtime.llm.complete({
    agentId: params.route.agentId,
    model: params.account.model,
    purpose: "clickclack bot reply",
    systemPrompt: params.account.systemPrompt,
    messages: [
      {
        role: "user",
        content: params.message.body,
      },
    ],
  });
  const completion = result.text.trim();
  if (!completion) {
    runtime.logging
      .getChildLogger({ plugin: "clickclack", feature: "model-reply" })
      .warn(`[${params.account.accountId}] ClickClack model reply produced no sendable text`);
    return;
  }
  // Direct completions bypass agent dispatch; use its prefix/model-context owner.
  const replyPipeline = createChannelMessageReplyPipeline({
    cfg: params.cfg,
    agentId: params.route.agentId,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
  });
  replyPipeline.onModelSelected?.({
    provider: result.provider,
    model: result.model,
    thinkLevel: undefined,
  });
  const responsePrefix = replyPipeline.resolveResponsePrefix?.();
  // An operator-owned system prompt may already ask the model to emit this prefix.
  const text =
    responsePrefix && !completion.startsWith(responsePrefix)
      ? `${responsePrefix} ${completion}`
      : completion;
  await sendClickClackText({
    cfg: params.cfg as CoreConfig,
    accountId: params.account.accountId,
    to: params.target,
    text,
    threadId: params.message.parent_message_id ? params.message.thread_root_id : undefined,
    replyToId: params.message.id,
    correlationId: params.correlationId,
  });
}

/**
 * Dispatches one already-fetched ClickClack message through the configured
 * reply mode for its account.
 */
export async function handleClickClackInbound(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
  access?: ClickClackInboundAccess;
  correlationId?: string;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const runtime = getClickClackRuntime();
  const message = params.message;
  const access =
    params.access ??
    (await resolveClickClackInboundAccess({
      account: params.account,
      config: params.config,
      message,
    }));
  if (!access.shouldDispatch || !access.channelIngress) {
    return;
  }
  const conversationId = message.channel_id || message.direct_conversation_id;
  if (!conversationId) {
    return;
  }
  const { discussionRoute, isDirect, route, target } = access.preparedRoute;
  const progress = params.account.nativeProgress
    ? createClickClackAgentProgressPublisher({
        client: createClickClackClient({
          baseUrl: params.account.apiEndpoint,
          token: params.account.token,
          correlationId: params.correlationId,
        }),
        target: message.channel_id
          ? { workspaceId: message.workspace_id, channelId: message.channel_id }
          : { workspaceId: message.workspace_id, conversationId },
        turnId: message.id,
        agentLabel:
          params.account.name?.trim() ||
          params.account.botHandle?.trim() ||
          params.account.agentId?.trim() ||
          params.account.accountId,
        onError: (error) => {
          runtime.logging
            .getChildLogger({ plugin: "clickclack", feature: "agent-progress" })
            .warn(`clickclack progress publish failed: ${String(error)}`);
        },
      })
    : undefined;
  if (params.account.replyMode === "model" && !discussionRoute) {
    if (access.botLoopProtection) {
      const loopResult = recordChannelBotPairLoopAndCheckSuppression(access.botLoopProtection);
      if (loopResult.suppressed) {
        runtime.logging
          .getChildLogger({ plugin: "clickclack", feature: "bot-loop-protection" })
          .warn(
            `[${params.account.accountId}] ClickClack bot-pair loop suppressed for ${Math.max(
              0,
              Math.ceil((loopResult.cooldownUntilMs - Date.now()) / 1000),
            )}s`,
          );
        return;
      }
    }
    progress?.start();
    try {
      await dispatchModelReply({
        account: params.account,
        cfg: params.config as OpenClawConfig,
        message,
        route,
        target,
        correlationId: params.correlationId,
      });
    } finally {
      await progress?.finalize();
    }
    return;
  }
  // Durable activity rows (streamed commentary + tool progress) are a
  // per-account opt-in: they need a ClickClack bot token carrying the
  // agent_activity:write scope. Publishing is best-effort and must never
  // break final text delivery.
  // Resolved model/thinking for this turn (from onModelSelected); stamped as
  // attribution metadata onto activity rows and the final reply message.
  let turnProvenance: ClickClackMessageProvenance | undefined;
  let activity: ClickClackActivityPublisher | undefined;
  if (params.account.agentActivity && (message.channel_id || message.direct_conversation_id)) {
    activity = createClickClackActivityPublisher({
      client: createClickClackClient({
        baseUrl: params.account.apiEndpoint,
        token: params.account.token,
        correlationId: params.correlationId,
      }),
      target: message.channel_id
        ? { channelId: message.channel_id }
        : { conversationId: message.direct_conversation_id },
      turnId: message.id,
      onError: (error) => {
        runtime.logging
          .getChildLogger({ plugin: "clickclack", feature: "agent-activity" })
          .warn(`clickclack activity publish failed: ${String(error)}`);
      },
    });
  }
  const senderName = message.author?.display_name || message.author_id;
  // Preserve both normalized channel fields and ClickClack-native ids so reply
  // routing, session recovery, and command authorization see the same message.
  const body = createChannelInboundEnvelopeBuilder({
    cfg: params.config as OpenClawConfig,
    route,
  })({
    channel: "ClickClack",
    from: senderName,
    timestamp: new Date(message.created_at),
    body: message.body,
  });
  const ctxPayload = (params.buildContext ?? buildChannelInboundEventContext)({
    channelIngress: access.channelIngress,
    channel: CHANNEL_ID,
    accountId: route.accountId ?? params.account.accountId,
    messageId: message.id,
    messageIdFull: message.id,
    timestamp: new Date(message.created_at).getTime(),
    from: target,
    sender: { id: message.author_id, name: senderName },
    conversation: {
      kind: isDirect ? "direct" : "group",
      id: conversationId,
      label: isDirect ? senderName : message.channel_id,
      threadId: message.parent_message_id ? message.thread_root_id : undefined,
      nativeChannelId: conversationId,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: message.id,
      messageThreadId: message.parent_message_id ? message.thread_root_id : undefined,
      threadParentId: message.parent_message_id ? message.thread_root_id : undefined,
    },
    message: { body, bodyForAgent: message.body, rawBody: message.body, commandBody: message.body },
    access: {
      commands: { authorized: access.commandAuthorized },
      mentions: access.mentionFacts,
    },
    extra: {
      GroupChannel: message.channel_id,
      ...(discussionRoute ? { GroupSystemPrompt: discussionRoute.systemPrompt } : {}),
    },
  });
  const runId = resolveClickClackAgentRunId(message.id);
  const activityReplyOptions = {
    ...(activity
      ? {
          onModelSelected: (ctx: { provider: string; model: string; thinkLevel?: string }) => {
            turnProvenance = {
              model: ctx.provider && ctx.model ? `${ctx.provider}/${ctx.model}` : ctx.model,
              thinking: ctx.thinkLevel,
            };
            activity.setProvenance(turnProvenance);
          },
        }
      : {}),
    ...(progress || activity
      ? {
          onItemEvent: (payload: ClickClackItemEventPayload) => {
            progress?.onItemEvent(payload);
            activity?.onItemEvent(payload);
            return false;
          },
          commentaryProgressEnabled: true,
          // ClickClack owns the native progress rendering, so item events must flow
          // even when session verbose mode is off and default tool-progress texts
          // stay suppressed.
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        }
      : {}),
  };
  progress?.start();
  const dispatch = () =>
    runtime.channel.inbound.dispatch({
      cfg: params.config as OpenClawConfig,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
      ctxPayload,
      botLoopProtection: access.botLoopProtection,
      toolsAllow: params.account.toolsAllow,
      replyOptions: {
        ...(runId ? { runId } : {}),
        ...activityReplyOptions,
      },
      delivery: {
        deliver: async (payload) => {
          if (hasClickClackReplyMedia(payload)) {
            throw new Error("ClickClack media reply requires durable delivery");
          }
          const text =
            payload && typeof payload === "object" && "text" in payload
              ? ((payload as { text?: string }).text ?? "")
              : "";
          if (!text.trim()) {
            return;
          }
          await sendClickClackText({
            cfg: params.config,
            accountId: params.account.accountId,
            to: target,
            text,
            threadId: message.parent_message_id ? message.thread_root_id : undefined,
            replyToId: message.id,
            provenance: turnProvenance,
            correlationId: params.correlationId,
          });
        },
        durable: (payload) => {
          if (!hasClickClackReplyMedia(payload)) {
            return false;
          }
          const threadId = message.parent_message_id ? message.thread_root_id : undefined;
          return {
            to: target,
            threadId,
            replyToId: message.id,
            requiredCapabilities: deriveDurableFinalDeliveryRequirements({
              payload,
              threadId,
              replyToId: message.id,
              reconcileUnknownSend: true,
            }),
          };
        },
        onError: (error) => {
          throw error instanceof Error
            ? error
            : new Error(`clickclack dispatch failed: ${String(error)}`);
        },
      },
      replyPipeline: {},
      record: {
        onRecordError: (error) => {
          throw error instanceof Error
            ? error
            : new Error(`clickclack session record failed: ${String(error)}`);
        },
      },
    });
  try {
    await dispatch();
  } finally {
    // Clear transient UI before awaiting optional durable activity writes:
    // their transport has separate failure/latency characteristics and must
    // not leave the native progress indicator behind after final delivery.
    await progress?.finalize();
    await activity?.finalize();
  }
}
