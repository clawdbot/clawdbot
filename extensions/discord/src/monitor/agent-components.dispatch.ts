import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { createNonExitingRuntime, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  resolveAgentComponentRoute,
  resolveComponentCommandAuthorized,
  resolvePinnedMainDmOwnerFromAllowlist,
  type AgentComponentContext,
  type AgentComponentInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
} from "./agent-components-helpers.js";
import { readSessionUpdatedAt, resolveStorePath } from "./agent-components.deps.runtime.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
} from "./inbound-context.js";
import { buildDirectLabel, buildGuildLabel } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";

let conversationRuntimePromise: Promise<typeof import("./agent-components.runtime.js")> | undefined;
let typingRuntimePromise: Promise<typeof import("./typing.js")> | undefined;

async function loadConversationRuntime() {
  conversationRuntimePromise ??= import("./agent-components.runtime.js");
  return await conversationRuntimePromise;
}

async function loadTypingRuntime() {
  typingRuntimePromise ??= import("./typing.js");
  return await typingRuntimePromise;
}

function buildDiscordComponentConversationLabel(params: {
  interactionCtx: ComponentInteractionContext;
  interaction: AgentComponentInteraction;
  channelCtx: DiscordChannelContext;
}) {
  if (params.interactionCtx.isDirectMessage) {
    return buildDirectLabel(params.interactionCtx.user);
  }
  if (params.interactionCtx.isGroupDm) {
    return `Group DM #${params.channelCtx.channelName ?? params.interactionCtx.channelId} channel id:${params.interactionCtx.channelId}`;
  }
  return buildGuildLabel({
    guild: params.interaction.guild ?? undefined,
    channelName: params.channelCtx.channelName ?? params.interactionCtx.channelId,
    channelId: params.interactionCtx.channelId,
  });
}

function resolveDiscordComponentChatType(interactionCtx: ComponentInteractionContext) {
  if (interactionCtx.isDirectMessage) {
    return "direct";
  }
  if (interactionCtx.isGroupDm) {
    return "group";
  }
  return "channel";
}

export function resolveDiscordComponentOriginatingTo(
  interactionCtx: Pick<ComponentInteractionContext, "isDirectMessage" | "userId" | "channelId">,
) {
  return resolveDiscordConversationIdentity({
    isDirectMessage: interactionCtx.isDirectMessage,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
  });
}

export async function dispatchDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  eventText: string;
  replyToId?: string;
  routeOverrides?: { sessionKey?: string; agentId?: string; accountId?: string };
}): Promise<void> {
  const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
  const runtime = ctx.runtime ?? createNonExitingRuntime();
  const route = resolveAgentComponentRoute({
    ctx,
    rawGuildId: interactionCtx.rawGuildId,
    memberRoleIds: interactionCtx.memberRoleIds,
    isDirectMessage: interactionCtx.isDirectMessage,
    isGroupDm: interactionCtx.isGroupDm,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
    parentId: channelCtx.parentId,
  });
  const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
  const agentId = params.routeOverrides?.agentId ?? route.agentId;
  const accountId = params.routeOverrides?.accountId ?? route.accountId;
  const fromLabel = buildDiscordComponentConversationLabel({
    interactionCtx,
    interaction,
    channelCtx,
  });
  const chatType = resolveDiscordComponentChatType(interactionCtx);
  const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
  const senderUsername = interactionCtx.user.username;
  const senderTag = formatDiscordUserTag(interactionCtx.user);
  const groupChannel =
    !interactionCtx.isDirectMessage && channelCtx.displayChannelSlug
      ? `#${channelCtx.displayChannelSlug}`
      : undefined;
  const groupSubject = interactionCtx.isDirectMessage ? undefined : groupChannel;
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: interactionCtx.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
  const { ownerAllowFrom } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: interactionCtx.user.id, name: interactionCtx.user.username, tag: senderTag },
    allowNameMatching,
    isGuild: !interactionCtx.isDirectMessage,
  });
  const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
  const pinnedMainDmOwner = interactionCtx.isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: ctx.cfg.session?.dmScope,
        allowFrom: channelConfig?.users ?? guildInfo?.users,
        normalizeEntry: (entry: string) => {
          const normalized = normalizeDiscordAllowList([entry], ["discord:", "user:", "pk:"]);
          const candidate = normalized?.ids.values().next().value;
          return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : undefined;
        },
      })
    : null;
  const commandAuthorized = await resolveComponentCommandAuthorized({
    ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });
  const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const timestamp = Date.now();
  const combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp,
    body: eventText,
    chatType,
    senderLabel: senderName,
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const {
    createReplyReferencePlanner,
    dispatchReplyWithBufferedBlockDispatcher,
    finalizeInboundContext,
    resolveChunkMode,
    resolveTextChunkLimit,
    recordInboundSession,
  } = await (async () => {
    const conversationRuntime = await loadConversationRuntime();
    return {
      ...conversationRuntime,
    };
  })();

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: eventText,
    RawBody: eventText,
    CommandBody: eventText,
    From: interactionCtx.isDirectMessage
      ? `discord:${interactionCtx.userId}`
      : interactionCtx.isGroupDm
        ? `discord:group:${interactionCtx.channelId}`
        : `discord:channel:${interactionCtx.channelId}`,
    To: `channel:${interactionCtx.channelId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: interactionCtx.userId,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    MemberRoleIds: interactionCtx.memberRoleIds,
    GroupSystemPrompt: interactionCtx.isDirectMessage ? undefined : groupSystemPrompt,
    GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    MessageSid: interaction.rawData.id,
    Timestamp: timestamp,
    OriginatingChannel: "discord" as const,
    OriginatingTo:
      resolveDiscordComponentOriginatingTo(interactionCtx) ?? `channel:${interactionCtx.channelId}`,
  });

  const deliverTarget = `channel:${interactionCtx.channelId}`;
  const typingChannelId = interactionCtx.channelId;
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "discord",
    accountId,
  });
  const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, {
    fallbackLimit: 2000,
  });
  const token = ctx.token ?? "";
  const feedbackRest = createDiscordRestClient({
    cfg: ctx.cfg,
    token,
    accountId,
  }).rest;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
  const replyToMode =
    ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
  const replyReference = createReplyReferencePlanner({
    replyToMode,
    startId: params.replyToId,
  });

  await runInboundReplyTurn({
    channel: "discord",
    accountId,
    raw: interaction,
    adapter: {
      ingest: () => ({
        id: interaction.id,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: interaction,
      }),
      resolveTurn: () => ({
        cfg: ctx.cfg,
        channel: "discord",
        accountId,
        agentId,
        routeSessionKey: sessionKey,
        storePath,
        ctxPayload,
        recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher,
        record: {
          updateLastRoute: interactionCtx.isDirectMessage
            ? {
                sessionKey: route.mainSessionKey,
                channel: "discord",
                to:
                  resolveDiscordComponentOriginatingTo(interactionCtx) ??
                  `user:${interactionCtx.userId}`,
                accountId,
                mainDmOwnerPin: pinnedMainDmOwner
                  ? {
                      ownerRecipient: pinnedMainDmOwner,
                      senderRecipient: interactionCtx.userId,
                      onSkip: ({ ownerRecipient, senderRecipient }) => {
                        logVerbose(
                          `discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                        );
                      },
                    }
                  : undefined,
              }
            : undefined,
          onRecordError: (err) => {
            logVerbose(`discord: failed updating component session meta: ${String(err)}`);
          },
        },
        delivery: {
          deliver: async (payload) => {
            const replyToId = replyReference.use();
            await deliverDiscordReply({
              cfg: ctx.cfg,
              replies: [payload],
              target: deliverTarget,
              token,
              accountId,
              rest: interaction.client.rest,
              runtime,
              replyToId,
              replyToMode,
              textLimit,
              maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
                cfg: ctx.cfg,
                discordConfig: ctx.discordConfig,
                accountId,
              }),
              tableMode,
              chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
              mediaLocalRoots,
            });
            replyReference.markSent();
          },
          onError: (err) => {
            logError(`discord component dispatch failed: ${String(err)}`);
          },
        },
        replyPipeline: {},
        dispatcherOptions: {
          humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
          onReplyStart: async () => {
            try {
              const { sendTyping } = await loadTypingRuntime();
              await sendTyping({ rest: feedbackRest, channelId: typingChannelId });
            } catch (err) {
              logVerbose(`discord: typing failed for component reply: ${String(err)}`);
            }
          },
        },
      }),
    },
  });
}
