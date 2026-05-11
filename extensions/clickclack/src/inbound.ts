import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-message";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sendClickClackText } from "./outbound.js";
import { getClickClackRuntime } from "./runtime.js";
import { buildClickClackTarget } from "./target.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const CHANNEL_ID = "clickclack" as const;

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
  const agentId = params.account.agentId ?? route.agentId;
  if (agentId === route.agentId) {
    return route;
  }
  return {
    ...route,
    agentId,
    sessionKey: runtime.channel.routing.buildAgentSessionKey({
      agentId,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      peer: {
        kind: params.isDirect ? "direct" : "channel",
        id: params.target,
      },
    }),
  };
}

async function dispatchModelReply(params: {
  account: ResolvedClickClackAccount;
  cfg: OpenClawConfig;
  message: ClickClackMessage;
  route: { agentId: string };
  target: string;
}) {
  const runtime = getClickClackRuntime();
  const result = await runtime.llm.complete({
    agentId: params.route.agentId,
    model: params.account.model,
    maxTokens: 96,
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
    return;
  }
  await sendClickClackText({
    cfg: params.cfg as CoreConfig,
    accountId: params.account.accountId,
    to: params.target,
    text,
    threadId: params.message.parent_message_id ? params.message.thread_root_id : undefined,
    replyToId: params.message.id,
  });
}

export async function handleClickClackInbound(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  message: ClickClackMessage;
}) {
  const runtime = getClickClackRuntime();
  const message = params.message;
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
    });
    return;
  }
  const senderName = message.author?.display_name || message.author_id;
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath: runtime.channel.session.resolveStorePath(params.config.session?.store, {
      agentId: route.agentId,
    }),
    sessionKey: route.sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "ClickClack",
    from: senderName,
    timestamp: new Date(message.created_at),
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(params.config as OpenClawConfig),
    body: message.body,
  });
  const storePath = runtime.channel.session.resolveStorePath(params.config.session?.store, {
    agentId: route.agentId,
  });
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: message.body,
    RawBody: message.body,
    CommandBody: message.body,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? params.account.accountId,
    ChatType: isDirect ? "direct" : "group",
    WasMentioned: isDirect ? undefined : true,
    ConversationLabel: isDirect ? senderName : message.channel_id,
    GroupChannel: message.channel_id,
    NativeChannelId: message.channel_id || message.direct_conversation_id,
    MessageThreadId: message.parent_message_id ? message.thread_root_id : undefined,
    ThreadParentId: message.parent_message_id ? message.thread_root_id : undefined,
    SenderName: senderName,
    SenderId: message.author_id,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.id,
    MessageSidFull: message.id,
    ReplyToId: message.id,
    Timestamp: message.created_at,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: target,
    CommandAuthorized: true,
  });
  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: params.config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
  });
  await runtime.channel.turn.runPrepared({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.channel.session.recordInboundSession,
    runDispatch: async () =>
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: params.config as OpenClawConfig,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload) => {
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
            });
          },
          onError: (error) => {
            throw error instanceof Error
              ? error
              : new Error(`clickclack dispatch failed: ${String(error)}`);
          },
        },
        replyOptions: { onModelSelected },
      }),
    record: {
      onRecordError: (error) => {
        throw error instanceof Error
          ? error
          : new Error(`clickclack session record failed: ${String(error)}`);
      },
    },
  });
}
