import { createChannelInboundEnvelopeBuilder } from "openclaw/plugin-sdk/channel-inbound";
import { deriveDurableFinalDeliveryRequirements } from "openclaw/plugin-sdk/channel-outbound";
/**
 * Converts authorized ClickClack messages into OpenClaw agent/model replies and
 * routes resulting outbound text back to ClickClack.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { resolveClickClackInboundAccess, type ClickClackInboundAccess } from "./access.js";
import { createClickClackActivityPublisher, type ClickClackActivityPublisher } from "./activity.js";
import { createClickClackClient } from "./http-client.js";
import { sendClickClackText } from "./outbound.js";
import { getClickClackRuntime } from "./runtime.js";
import { buildClickClackTarget } from "./target.js";
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

function resolveAccountAgentRoute(params: {
  cfg: OpenClawConfig;
  account: ResolvedClickClackAccount;
  target: string;
  isDirect: boolean;
}) {
  const runtime = getClickClackRuntime();
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: params.isDirect ? "direct" : "channel",
      id: params.target,
    },
  });
  const agentId = normalizeAgentId(params.account.agentId ?? route.agentId);
  if (agentId === route.agentId) {
    return route;
  }
  const peer = {
    kind: params.isDirect ? ("direct" as const) : ("channel" as const),
    id: params.target,
  };
  const dmScope = params.cfg.session?.dmScope ?? "main";
  // Account-level agent ownership changes only the agent prefix. Preserve the
  // resolved session policy so outbound recipient routing reaches this key.
  const sessionKey = runtime.channel.routing.buildAgentSessionKey({
    agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer,
    dmScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
  const mainSessionKey = runtime.channel.routing.buildAgentSessionKey({
    agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    dmScope: "main",
  });
  return {
    ...route,
    agentId,
    dmScope,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: sessionKey === mainSessionKey ? "main" : "session",
  };
}

async function dispatchModelReply(params: {
  account: ResolvedClickClackAccount;
  cfg: OpenClawConfig;
  message: ClickClackMessage;
  route: { agentId: string };
  target: string;
  correlationId?: string;
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
  const text = result.text.trim();
  if (!text) {
    runtime.logging
      .getChildLogger({ plugin: "clickclack", feature: "model-reply" })
      .warn(`[${params.account.accountId}] ClickClack model reply produced no sendable text`);
    return;
  }
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
  if (!access.shouldDispatch) {
    return;
  }
  const conversationId = message.channel_id || message.direct_conversation_id;
  if (!conversationId) {
    return;
  }
  const isDirect = Boolean(message.direct_conversation_id);
  const target = buildClickClackTarget(
    isDirect
      ? { chatType: "direct", kind: "dm", id: message.author_id }
      : { chatType: "group", kind: "channel", id: message.channel_id ?? "" },
  );
  const route = resolveAccountAgentRoute({
    cfg: params.config as OpenClawConfig,
    account: params.account,
    target,
    isDirect,
  });
  if (params.account.replyMode === "model") {
    await dispatchModelReply({
      account: params.account,
      cfg: params.config as OpenClawConfig,
      message,
      route,
      target,
      correlationId: params.correlationId,
    });
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
        baseUrl: params.account.baseUrl,
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
  const ctxPayload = runtime.channel.inbound.buildContext({
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
      mentions: {
        canDetectMention: !isDirect,
        wasMentioned: !isDirect,
      },
    },
    extra: { GroupChannel: message.channel_id },
  });
  const runId = resolveClickClackAgentRunId(message.id);
  const activityReplyOptions = activity
    ? {
        onModelSelected: (ctx: { provider: string; model: string; thinkLevel?: string }) => {
          turnProvenance = {
            model: ctx.provider && ctx.model ? `${ctx.provider}/${ctx.model}` : ctx.model,
            thinking: ctx.thinkLevel,
          };
          activity?.setProvenance(turnProvenance);
        },
        onItemEvent: activity.onItemEvent,
        commentaryProgressEnabled: true,
        // The durable activity rows are ClickClack's own progress
        // rendering, so item events must flow even when session verbose
        // mode is off and the default tool-progress texts stay suppressed.
        suppressDefaultToolProgressMessages: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      }
    : undefined;
  const dispatchPromise = runtime.channel.inbound.dispatch({
    cfg: params.config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    toolsAllow: params.account.toolsAllow,
    // Provenance stamping shares the agentActivity opt-in: with the flag off
    // the extension's wire payloads stay byte-identical to pre-activity
    // builds, which is the documented contract for stock setups.
    replyOptions:
      runId || activityReplyOptions
        ? {
            ...(runId ? { runId } : {}),
            ...activityReplyOptions,
          }
        : undefined,
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
    await dispatchPromise;
  } finally {
    await activity?.finalize();
  }
}
