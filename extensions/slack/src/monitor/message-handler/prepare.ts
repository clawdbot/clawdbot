import {
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type AckReactionScope,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  formatInboundEnvelope,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelMessageSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-message";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveSlackReplyToMode } from "../../account-reply-mode.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { formatSlackError } from "../../errors.js";
import { formatSlackFileReference } from "../../file-reference.js";
import { hasSlackThreadParticipationWithPersistence } from "../../sent-thread-cache.js";
import type { SlackMessageEvent } from "../../types.js";
import { normalizeAllowListLower, normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import {
  authorizeSlackBotRoomMessage,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import {
  readSessionUpdatedAt,
  resolveChannelContextVisibilityMode,
  resolveStorePath,
} from "../config.runtime.js";
import {
  normalizeSlackChannelType,
  resolveSlackChatType,
  type SlackMonitorContext,
} from "../context.js";
import { resolveConversationLabel } from "../conversation.runtime.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import { resolveSlackRoomContextHints } from "../room-context.js";
import { sendMessageSlack } from "../send.runtime.js";
import { resolveSlackThreadStarter } from "../thread.js";
import { resolveSlackMessageContent } from "./prepare-content.js";
import { resolveSlackDmHistoryContext, resolveSlackDmHistoryLimit } from "./prepare-dm-history.js";
import { resolveSlackRoutingContext } from "./prepare-routing.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import { isSlackSubteamMentionForBot } from "./subteam-mentions.js";
import type { PreparedSlackMessage } from "./types.js";

const mentionRegexCache = new WeakMap<SlackMonitorContext, Map<string, RegExp[]>>();
const SLACK_ANY_MENTION_RE = /<@[^>]+>|<!subteam\^[^>]+>/;
const SLACK_USER_MENTION_RE = /<@([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_RE = /<!subteam\^([^>|]+)(?:\|[^>]+)?>/g;
const SLACK_SUBTEAM_MENTION_MARKER = "<!subteam^";

function resolveCachedMentionRegexes(
  ctx: SlackMonitorContext,
  agentId: string | undefined,
): RegExp[] {
  const key = normalizeOptionalString(agentId) ?? "__default__";
  let byAgent = mentionRegexCache.get(ctx);
  if (!byAgent) {
    byAgent = new Map<string, RegExp[]>();
    mentionRegexCache.set(ctx, byAgent);
  }
  const cached = byAgent.get(key);
  if (cached) {
    return cached;
  }
  const built = buildMentionRegexes(ctx.cfg, agentId);
  byAgent.set(key, built);
  return built;
}

type SlackConversationContext = {
  channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  };
  channelName?: string;
  resolvedChannelType: ReturnType<typeof normalizeSlackChannelType>;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  channelConfig: ReturnType<typeof resolveSlackChannelConfig> | null;
  allowBotsMode: "off" | "all" | "mentions";
  isBotMessage: boolean;
};

type SlackAuthorizationContext = {
  senderId: string;
  allowFromLower: string[];
};

type SlackMentionMetadata = {
  mentionedUserIds: string[];
  mentionedSubteamIds: string[];
  hasAnyMention: boolean;
  hasSubteamMention: boolean;
};

type SlackExplicitMentionState = {
  explicitlyMentionedBotUser: boolean;
  explicitlyMentionedBotSubteam: boolean;
  explicitlyMentioned: boolean;
};

type SlackMentionContextPayload = Pick<
  FinalizedMsgContext,
  | "WasMentioned"
  | "ExplicitlyMentionedBot"
  | "MentionedUserIds"
  | "MentionedSubteamIds"
  | "ImplicitMentionKinds"
  | "MentionSource"
>;

function collectUniqueSlackMentionIds(text: string, regex: RegExp): string[] {
  const ids: string[] = [];
  regex.lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const id = normalizeOptionalString(match[1]);
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function collectSlackMentionMetadata(text: string): SlackMentionMetadata {
  return {
    mentionedUserIds: collectUniqueSlackMentionIds(text, SLACK_USER_MENTION_RE),
    mentionedSubteamIds: collectUniqueSlackMentionIds(text, SLACK_SUBTEAM_MENTION_RE),
    hasAnyMention: SLACK_ANY_MENTION_RE.test(text),
    hasSubteamMention: text.includes(SLACK_SUBTEAM_MENTION_MARKER),
  };
}

async function resolveSlackExplicitMentionState(params: {
  ctx: SlackMonitorContext;
  messageText: string;
  mentionedUserIds: readonly string[];
  hasSubteamMention: boolean;
  source: "message" | "app_mention";
}): Promise<SlackExplicitMentionState> {
  const explicitlyMentionedBotUser = Boolean(
    params.ctx.botUserId && params.mentionedUserIds.includes(params.ctx.botUserId),
  );
  const explicitlyMentionedBotSubteam =
    Boolean(params.ctx.botUserId && params.hasSubteamMention) &&
    (await isSlackSubteamMentionForBot({
      client: params.ctx.app.client,
      text: params.messageText,
      botUserId: params.ctx.botUserId,
      teamId: params.ctx.teamId,
      log: logVerbose,
    }));
  return {
    explicitlyMentionedBotUser,
    explicitlyMentionedBotSubteam,
    explicitlyMentioned:
      explicitlyMentionedBotUser ||
      explicitlyMentionedBotSubteam ||
      params.source === "app_mention",
  };
}

function resolveSlackMentionSource(params: {
  explicitBotMention: boolean;
  explicitSubteamMention: boolean;
  matchedImplicitMentionKinds: readonly string[];
  shouldBypassMention: boolean;
  wasMentioned: boolean;
}): NonNullable<FinalizedMsgContext["MentionSource"]> {
  if (params.explicitBotMention) {
    return "explicit_bot";
  }
  if (params.explicitSubteamMention) {
    return "subteam";
  }
  if (params.shouldBypassMention) {
    return "command_bypass";
  }
  if (params.wasMentioned) {
    return "mention_pattern";
  }
  if (params.matchedImplicitMentionKinds.length > 0) {
    return "implicit_thread";
  }
  return "none";
}

function buildSlackMentionContextPayload(params: {
  isRoomish: boolean;
  effectiveWasMentioned: boolean;
  explicitlyMentioned: boolean;
  mentionedUserIds: readonly string[];
  mentionedSubteamIds: readonly string[];
  matchedImplicitMentionKinds: readonly string[];
  mentionSource: NonNullable<FinalizedMsgContext["MentionSource"]>;
}): SlackMentionContextPayload {
  if (!params.isRoomish) {
    return {};
  }
  return {
    WasMentioned: params.effectiveWasMentioned,
    ExplicitlyMentionedBot: params.explicitlyMentioned,
    MentionedUserIds: params.mentionedUserIds.length > 0 ? [...params.mentionedUserIds] : undefined,
    MentionedSubteamIds:
      params.mentionedSubteamIds.length > 0 ? [...params.mentionedSubteamIds] : undefined,
    ImplicitMentionKinds:
      params.matchedImplicitMentionKinds.length > 0
        ? [...params.matchedImplicitMentionKinds]
        : undefined,
    MentionSource: params.mentionSource,
  };
}

async function resolveSlackConversationContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
}): Promise<SlackConversationContext> {
  const { ctx, account, message } = params;
  const cfg = ctx.cfg;

  let channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  } = {};
  let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
  // D-prefixed channels are always direct messages. Skip channel lookups in
  // that common path to avoid an unnecessary API round-trip.
  if (resolvedChannelType !== "im" && (!message.channel_type || message.channel_type !== "im")) {
    channelInfo = await ctx.resolveChannelName(message.channel);
    resolvedChannelType = normalizeSlackChannelType(
      message.channel_type ?? channelInfo.type,
      message.channel,
    );
  }
  const channelName = channelInfo?.name;
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;
  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        channelKeys: ctx.channelsConfigKeys,
        defaultRequireMention: ctx.defaultRequireMention,
        allowNameMatching: ctx.allowNameMatching,
      })
    : null;
  const allowBotsSetting =
    channelConfig?.allowBots ??
    account.config?.allowBots ??
    cfg.channels?.slack?.allowBots ??
    false;
  const allowBotsMode: "off" | "all" | "mentions" =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting ? "all" : "off";

  return {
    channelInfo,
    channelName,
    resolvedChannelType,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    allowBotsMode,
    isBotMessage: Boolean(message.bot_id),
  };
}

async function authorizeSlackInboundMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  conversation: SlackConversationContext;
}): Promise<SlackAuthorizationContext | null> {
  const { ctx, account, message, conversation } = params;
  const { isDirectMessage, channelName, resolvedChannelType, isBotMessage, allowBotsMode } =
    conversation;

  if (isBotMessage) {
    if (message.user && ctx.botUserId && message.user === ctx.botUserId) {
      return null;
    }
    if (allowBotsMode === "off") {
      logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
      return null;
    }
  }

  if (isDirectMessage && !message.user) {
    logVerbose("slack: drop dm message (missing user id)");
    return null;
  }

  const senderId = message.user ?? (isBotMessage ? message.bot_id : undefined);
  if (!senderId) {
    logVerbose("slack: drop message (missing sender id)");
    return null;
  }

  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    logVerbose("slack: drop message (channel not allowed)");
    return null;
  }

  const allowFromLower = await resolveSlackEffectiveAllowFrom(ctx, {
    includePairingStore: isDirectMessage,
  });

  if (isDirectMessage) {
    const directUserId = message.user;
    if (!directUserId) {
      logVerbose("slack: drop dm message (missing user id)");
      return null;
    }
    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: account.accountId,
      senderId: directUserId,
      allowFromLower,
      resolveSenderName: ctx.resolveUserName,
      sendPairingReply: async (text) => {
        await sendMessageSlack(message.channel, text, {
          cfg: ctx.cfg,
          token: ctx.botToken,
          client: ctx.app.client,
          accountId: account.accountId,
        });
      },
      onDisabled: () => {
        logVerbose("slack: drop dm (dms disabled)");
      },
      onUnauthorized: ({ allowMatchMeta }) => {
        logVerbose(
          `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
        );
      },
      log: logVerbose,
    });
    if (!allowed) {
      return null;
    }
  }

  return {
    senderId,
    allowFromLower,
  };
}

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, account, message, opts } = params;
  const cfg = ctx.cfg;
  const conversation = await resolveSlackConversationContext({ ctx, account, message });
  const {
    channelInfo,
    channelName,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    allowBotsMode,
    isBotMessage,
  } = conversation;
  const authorization = await authorizeSlackInboundMessage({
    ctx,
    account,
    message,
    conversation,
  });
  if (!authorization) {
    return null;
  }
  const { senderId, allowFromLower } = authorization;
  const messageText = message.text ?? "";
  const mentionMetadata = collectSlackMentionMetadata(messageText);
  const { mentionedUserIds, mentionedSubteamIds, hasAnyMention } = mentionMetadata;
  const { explicitlyMentionedBotUser, explicitlyMentionedBotSubteam, explicitlyMentioned } =
    await resolveSlackExplicitMentionState({
      ctx,
      messageText,
      mentionedUserIds,
      hasSubteamMention: mentionMetadata.hasSubteamMention,
      source: opts.source,
    });
  // Channels with `requireMention: false` and a non-`off` reply mode produce
  // a Slack-side thread on every top-level bot reply (because `replyToMode`
  // creates one). Seed thread routing for the root turn too, so the inbound
  // root and its later thread replies share one parent session — same way
  // app_mention / explicitly mentioned roots already do. Without this gate,
  // the root lands on the channel session while later thread replies land on
  // a fresh `:thread:<root_ts>` session, breaking continuity.
  const channelRequireMention = channelConfig?.requireMention ?? ctx.defaultRequireMention ?? true;
  const channelChatType: "direct" | "group" | "channel" = isDirectMessage
    ? "direct"
    : isGroupDm
      ? "group"
      : "channel";
  const willImplicitlyThreadReply =
    isRoom && !channelRequireMention && resolveSlackReplyToMode(account, channelChatType) !== "off";
  const seedTopLevelRoomThreadBySource =
    opts.source === "app_mention" ||
    opts.wasMentioned === true ||
    explicitlyMentioned ||
    willImplicitlyThreadReply;
  let routing = resolveSlackRoutingContext({
    ctx,
    account,
    message,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    seedTopLevelRoomThread: seedTopLevelRoomThreadBySource,
  });

  const resolveWasMentioned = (mentionRegexes: RegExp[]) =>
    opts.wasMentioned ??
    (!isDirectMessage &&
      matchesMentionWithExplicit({
        text: messageText,
        mentionRegexes,
        explicit: {
          hasAnyMention,
          isExplicitlyMentioned: explicitlyMentioned,
          canResolveExplicit: Boolean(ctx.botUserId),
        },
      }));
  let mentionRegexes = resolveCachedMentionRegexes(ctx, routing.route.agentId);
  let wasMentioned = resolveWasMentioned(mentionRegexes);
  const hasBoundSession = Boolean(
    routing.runtimeBoundSessionKey || routing.configuredBindingSessionKey,
  );
  // Runtime bindings already pin the root and later thread replies to the same
  // target session, so only unbound regex mentions need a seeded thread reroute.
  if (
    !seedTopLevelRoomThreadBySource &&
    wasMentioned &&
    isRoom &&
    !routing.isThreadReply &&
    !hasBoundSession
  ) {
    routing = resolveSlackRoutingContext({
      ctx,
      account,
      message,
      isDirectMessage,
      isGroupDm,
      isRoom,
      isRoomish,
      seedTopLevelRoomThread: true,
    });
    mentionRegexes = resolveCachedMentionRegexes(ctx, routing.route.agentId);
    wasMentioned = resolveWasMentioned(mentionRegexes);
  }
  const {
    route,
    runtimeBinding,
    configuredBinding,
    configuredBindingSessionKey,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
    historyKey,
  } = routing;
  if (runtimeBinding && shouldLogVerbose()) {
    logVerbose(
      `slack: routed via bound conversation ${runtimeBinding.conversation.conversationId} -> ${runtimeBinding.targetSessionKey}`,
    );
  }
  if (configuredBinding) {
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg,
      bindingResolution: configuredBinding,
    });
    if (ensured.ok) {
      if (shouldLogVerbose()) {
        logVerbose(
          `slack: using configured ACP binding for ${configuredBinding.record.conversation.conversationId} -> ${configuredBindingSessionKey}`,
        );
      }
    } else {
      if (shouldLogVerbose()) {
        logVerbose(
          `slack: configured ACP binding unavailable for ${configuredBinding.record.conversation.conversationId}: ${ensured.error}`,
        );
      }
      logInboundDrop({
        log: logVerbose,
        channel: "slack",
        reason: "configured ACP binding unavailable",
        target: configuredBinding.record.conversation.conversationId,
      });
      return null;
    }
  }
  let implicitMentionKinds: ReturnType<typeof implicitMentionKindWhen> = [];
  if (
    !isDirectMessage &&
    ctx.botUserId &&
    message.thread_ts &&
    !ctx.threadRequireExplicitMention &&
    !wasMentioned
  ) {
    const replyToBotKinds = implicitMentionKindWhen(
      "reply_to_bot",
      message.parent_user_id === ctx.botUserId,
    );
    implicitMentionKinds =
      replyToBotKinds.length > 0
        ? replyToBotKinds
        : implicitMentionKindWhen(
            "bot_thread_participant",
            await hasSlackThreadParticipationWithPersistence({
              accountId: account.accountId,
              channelId: message.channel,
              threadTs: message.thread_ts,
            }),
          );
  }

  let resolvedSenderName = normalizeOptionalString(message.username);
  const resolveSenderName = async (): Promise<string> => {
    if (resolvedSenderName) {
      return resolvedSenderName;
    }
    if (message.user) {
      const sender = await ctx.resolveUserName(message.user);
      const normalized = normalizeOptionalString(sender?.name);
      if (normalized) {
        resolvedSenderName = normalized;
        return resolvedSenderName;
      }
    }
    resolvedSenderName = message.user ?? message.bot_id ?? "unknown";
    return resolvedSenderName;
  };
  const senderNameForAuth = ctx.allowNameMatching ? await resolveSenderName() : undefined;

  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;
  if (message._ambiguousThreadReply) {
    ctx.logger.info(
      {
        channel: message.channel,
        ts: message.ts,
        parentUserId: message.parent_user_id,
      },
      "skipping ambiguous slack thread reply",
    );
    return null;
  }
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  // Strip Slack mentions (<@U123>) before command detection so "@Labrador /new" is recognized
  const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
  const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);
  const channelUsersAllowlistConfigured =
    isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const messageIngress = await resolveSlackCommandIngress({
    ctx,
    senderId,
    senderName: senderNameForAuth,
    channelType: conversation.resolvedChannelType ?? "channel",
    channelId: message.channel,
    ownerAllowFromLower: allowFromLower,
    channelUsers: isRoom ? channelConfig?.users : undefined,
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
    mentionFacts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    activation: {
      requireMention: shouldRequireMention,
      allowTextCommands,
      ...(ctx.threadRequireExplicitMention ? { allowedImplicitMentionKinds: [] } : {}),
    },
  });
  const effectiveWasMentioned = messageIngress.activationAccess.effectiveWasMentioned ?? false;
  const shouldBypassMention = messageIngress.activationAccess.shouldBypassMention ?? false;
  const matchedImplicitMentionKinds = implicitMentionKinds;
  const mentionSource = resolveSlackMentionSource({
    explicitBotMention: explicitlyMentionedBotUser || opts.source === "app_mention",
    explicitSubteamMention: explicitlyMentionedBotSubteam,
    matchedImplicitMentionKinds,
    shouldBypassMention,
    wasMentioned,
  });
  const senderGate = messageIngress.senderAccess.gate;
  if (isRoom && senderGate?.allowed === false) {
    logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
    return null;
  }
  if (
    isRoom &&
    isBotMessage &&
    allowBotsMode !== "off" &&
    !(await authorizeSlackBotRoomMessage({
      ctx,
      channelId: message.channel,
      senderId,
      senderName: senderNameForAuth,
      channelUsers: channelConfig?.users,
      allowFromLower,
    }))
  ) {
    return null;
  }

  if (isBotMessage && allowBotsMode === "mentions") {
    const botMentioned = isDirectMessage || effectiveWasMentioned || shouldBypassMention;
    if (!botMentioned) {
      logVerbose("slack: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }

  const threadContextAllowFromLower = isRoom
    ? channelUsersAllowlistConfigured
      ? normalizeAllowListLower(channelConfig?.users)
      : []
    : isDirectMessage
      ? allowFromLower
      : [];
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: ctx.cfg,
    channel: "slack",
    accountId: account.accountId,
  });
  const commandAuthorized = messageIngress.commandAccess.authorized;

  if (isRoomish && messageIngress.commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: logVerbose,
      channel: "slack",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  if (isRoom && shouldRequireMention && messageIngress.activationAccess.shouldSkip) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping channel message");
    const pendingText = (message.text ?? "").trim();
    const fallbackFile = message.files?.length
      ? `[Slack file: ${formatSlackFileReference(message.files[0])}]`
      : "";
    const pendingBody = pendingText || fallbackFile;
    recordPendingHistoryEntryIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: pendingBody
        ? {
            sender: await resolveSenderName(),
            body: pendingBody,
            timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
            messageId: message.ts,
          }
        : null,
    });
    return null;
  }

  const threadStarter =
    isThreadReply && threadTs
      ? await resolveSlackThreadStarter({
          channelId: message.channel,
          threadTs,
          client: ctx.app.client,
        })
      : null;
  const resolvedMessageContent = await resolveSlackMessageContent({
    message,
    isThreadReply,
    threadStarter,
    isBotMessage,
    botToken: ctx.botToken,
    client: ctx.app.client,
    mediaMaxBytes: ctx.mediaMaxBytes,
    resolveUserName: ctx.resolveUserName,
  });
  if (!resolvedMessageContent) {
    return null;
  }
  const { rawBody, effectiveDirectMedia } = resolvedMessageContent;
  const chatType = resolveSlackChatType(conversation.resolvedChannelType);

  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "slack",
    accountId: account.accountId,
  });
  const ackReactionValue = ackReaction ?? "";
  const sourceRepliesAreToolOnly =
    resolveChannelMessageSourceReplyDeliveryMode({ cfg, ctx: { ChatType: chatType } }) ===
    "message_tool_only";
  const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ctx.ackReactionScope as AckReactionScope | undefined,
        isDirect: isDirectMessage,
        isGroup: isRoomish,
        isMentionableGroup: isRoom,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );

  const ackReactionMessageTs = message.ts;
  const allowToolOnlyStatusReaction =
    statusReactionsExplicitlyEnabled && (effectiveWasMentioned || shouldBypassMention);
  const shouldSendAckReaction =
    shouldAckReaction() && (!sourceRepliesAreToolOnly || allowToolOnlyStatusReaction);
  const statusReactionsWillHandle =
    Boolean(ackReactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false &&
    shouldSendAckReaction;
  const ackReactionPromise =
    !statusReactionsWillHandle && shouldSendAckReaction && ackReactionMessageTs && ackReactionValue
      ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).then(
          () => true,
          (err) => {
            logVerbose(
              `slack react failed for channel ${message.channel}: ${formatSlackError(err)}`,
            );
            return false;
          },
        )
      : statusReactionsWillHandle
        ? Promise.resolve(true)
        : null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const senderName = await resolveSenderName();
  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    sessionKey,
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
    trusted: false,
  });

  const envelopeFrom =
    resolveConversationLabel({
      ChatType: chatType,
      SenderName: senderName,
      GroupSubject: isRoomish ? roomLabel : undefined,
      From: slackFrom,
    }) ?? (isDirectMessage ? senderName : roomLabel);
  const threadInfo =
    isThreadReply && threadTs
      ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}`
      : "";
  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
  const storePath = resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const dmHistoryLimit = isDirectMessage
    ? resolveSlackDmHistoryLimit({
        account,
        userId: message.user,
        defaultLimit: ctx.dmHistoryLimit,
      })
    : 0;
  const body = formatInboundEnvelope({
    channel: "Slack",
    from: envelopeFrom,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    body: textWithId,
    chatType,
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  const dmHistoryContext =
    isDirectMessage && !isThreadReply && dmHistoryLimit > 0 && !previousTimestamp
      ? await resolveSlackDmHistoryContext({
          ctx,
          channelId: message.channel,
          currentMessageTs: message.ts,
          limit: dmHistoryLimit,
          envelopeOptions,
        })
      : { body: undefined, inboundHistory: undefined };
  if (dmHistoryContext.body) {
    combinedBody = `${dmHistoryContext.body}\n\n${combinedBody}`;
  }
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Slack",
          from: roomLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;

  const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
    isRoomish,
    channelInfo,
    channelConfig,
  });

  const {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  } = await resolveSlackThreadContextData({
    ctx,
    account,
    message,
    isThreadReply,
    threadTs,
    threadStarter,
    roomLabel,
    storePath,
    sessionKey,
    allowFromLower: threadContextAllowFromLower,
    allowNameMatching: ctx.allowNameMatching,
    contextVisibilityMode,
    envelopeOptions,
    effectiveDirectMedia,
  });

  // Use direct media (including forwarded attachment media) if available, else thread starter media
  const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
  const firstMedia = effectiveMedia?.[0];

  const inboundHistory =
    isRoomish && ctx.historyLimit > 0
      ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : dmHistoryContext.inboundHistory;
  const commandBody = textForCommandDetection.trim();

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: envelopeFrom,
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSpace: ctx.teamId || undefined,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: threadContext.replyToId,
    // Preserve thread context for routed tool notifications.
    MessageThreadId: threadContext.messageThreadId,
    ParentSessionKey: threadKeys.parentSessionKey,
    // Only include thread starter body for NEW sessions (existing sessions already have it in their transcript)
    ThreadStarterBody: !threadSessionPreviousTimestamp ? threadStarterBody : undefined,
    ThreadHistoryBody: threadHistoryBody,
    IsFirstThreadTurn:
      isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : undefined,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    ...buildSlackMentionContextPayload({
      isRoomish,
      effectiveWasMentioned,
      explicitlyMentioned,
      mentionedUserIds,
      mentionedSubteamIds,
      matchedImplicitMentionKinds,
      mentionSource,
    }),
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaUrls:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaTypes:
      effectiveMedia && effectiveMedia.length > 0
        ? effectiveMedia.map((m) => m.contentType ?? "")
        : undefined,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
    NativeChannelId: message.channel,
  }) satisfies FinalizedMsgContext;

  if (isRoomish && !shouldRequireMention) {
    recordPendingHistoryEntryIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: {
        sender: senderName,
        body: rawBody,
        timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
        messageId: message.ts,
      },
    });
  }

  const pinnedMainDmOwner = isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: ctx.allowFrom,
        normalizeEntry: normalizeSlackAllowOwnerEntry,
      })
    : null;

  // Live DM replies should target the concrete Slack DM channel id we just
  // received on. This avoids depending on a follow-up conversations.open
  // round-trip for the normal reply path while keeping persisted routing
  // metadata user-scoped for later session deliveries.
  const replyTarget = isDirectMessage ? `channel:${message.channel}` : (ctxPayload.To ?? undefined);
  if (!replyTarget) {
    return null;
  }

  if (shouldLogVerbose()) {
    logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
  }

  return {
    ctx,
    account,
    message,
    route,
    channelConfig,
    replyTarget,
    ctxPayload,
    turn: {
      storePath,
      record: {
        updateLastRoute: isDirectMessage
          ? {
              sessionKey: resolveInboundLastRouteSessionKey({ route, sessionKey }),
              channel: "slack",
              to: `user:${message.user}`,
              accountId: route.accountId,
              threadId: threadContext.messageThreadId,
              mainDmOwnerPin:
                pinnedMainDmOwner && message.user
                  ? {
                      ownerRecipient: pinnedMainDmOwner,
                      senderRecipient: normalizeLowercaseStringOrEmpty(message.user),
                      onSkip: ({
                        ownerRecipient,
                        senderRecipient,
                      }: {
                        ownerRecipient: string;
                        senderRecipient: string;
                      }) => {
                        logVerbose(
                          `slack: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                        );
                      },
                    }
                  : undefined,
            }
          : undefined,
        onRecordError: (err: unknown) => {
          ctx.logger.warn(
            {
              error: formatErrorMessage(err),
              storePath,
              sessionKey,
            },
            "failed updating session meta",
          );
        },
      },
    },
    replyToMode,
    requireMention: shouldRequireMention,
    isDirectMessage,
    isRoomish,
    historyKey,
    preview,
    ackReactionMessageTs,
    ackReactionValue,
    ackReactionPromise,
  };
}
