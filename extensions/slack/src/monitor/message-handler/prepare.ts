import {
  resolveAckReaction,
  shouldAckReaction as shouldAckReactionGate,
  type AckReactionScope,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildChannelInboundEventContext,
  buildMentionRegexes,
  classifyChannelInboundEvent,
  formatInboundEnvelope,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveEnvelopeFormatOptions,
  resolveUnmentionedGroupInboundPolicy,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelMessageSourceReplyDeliveryMode } from "openclaw/plugin-sdk/channel-message";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-surface";
import { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { recordDroppedChannelTurnHistory } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
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
import type { SlackAttachment, SlackFile, SlackMessageEvent } from "../../types.js";
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
  buildSlackAssistantThreadMetadata,
  normalizeSlackChannelType,
  parseSlackAssistantThreadMetadata,
  resolveSlackChatType,
  type SlackAssistantThreadContext,
  type SlackMonitorContext,
} from "../context.js";
import { resolveConversationLabel } from "../conversation.runtime.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import { resolveSlackRoomContextHints } from "../room-context.js";
import { sendMessageSlack } from "../send.runtime.js";
import { resolveSlackThreadStarter, type SlackThreadStarter } from "../thread.js";
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
const SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS = 4;
const SLACK_HISTORY_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const SLACK_HISTORY_MEDIA_IDLE_TIMEOUT_MS = 1_000;
const SLACK_HISTORY_MEDIA_TOTAL_TIMEOUT_MS = 3_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return normalizeOptionalString(record?.[key]);
}

function recordNullableString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | null | undefined {
  if (!record || !(key in record)) {
    return undefined;
  }
  if (record[key] === null) {
    return null;
  }
  return normalizeOptionalString(record[key]);
}

function mergeSlackAssistantThreadContext(
  primary: Omit<SlackAssistantThreadContext, "updatedAt"> | undefined,
  fallback: Omit<SlackAssistantThreadContext, "updatedAt"> | undefined,
): Omit<SlackAssistantThreadContext, "updatedAt"> | undefined {
  if (!primary) {
    return fallback;
  }
  if (!fallback) {
    return primary;
  }
  return {
    assistantChannelId: primary.assistantChannelId || fallback.assistantChannelId,
    threadTs: primary.threadTs || fallback.threadTs,
    userId: primary.userId ?? fallback.userId,
    channelId: primary.channelId ?? fallback.channelId,
    teamId: primary.teamId ?? fallback.teamId,
    enterpriseId: primary.enterpriseId !== undefined ? primary.enterpriseId : fallback.enterpriseId,
  };
}

function hasSlackAssistantThreadMetadata(
  context: Omit<SlackAssistantThreadContext, "updatedAt"> | undefined,
): boolean {
  return Boolean(context?.channelId || context?.teamId || context?.enterpriseId !== undefined);
}

function resolveSlackMessageAssistantThreadContext(
  message: SlackMessageEvent,
): Omit<SlackAssistantThreadContext, "updatedAt"> | undefined {
  const thread = asRecord(message.assistant_thread);
  if (!thread) {
    return undefined;
  }
  const context = asRecord(thread.context);
  const assistantChannelId = recordString(thread, "channel_id") ?? message.channel;
  const threadTs = recordString(thread, "thread_ts") ?? message.thread_ts ?? message.ts;
  if (!assistantChannelId || !threadTs) {
    return undefined;
  }
  return {
    assistantChannelId,
    threadTs,
    userId: recordString(thread, "user_id") ?? message.user,
    channelId: recordString(context, "channel_id"),
    teamId: recordString(context, "team_id"),
    enterpriseId: recordNullableString(context, "enterprise_id"),
  };
}

async function restoreSlackAssistantThreadContextFromMetadata(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
}): Promise<Omit<SlackAssistantThreadContext, "updatedAt"> | undefined> {
  const threadTs = params.message.thread_ts;
  const parentUserId = params.message.parent_user_id?.trim();
  if (
    !params.message.channel ||
    !threadTs ||
    !parentUserId ||
    (parentUserId !== params.ctx.botUserId && parentUserId !== params.ctx.botId)
  ) {
    return undefined;
  }
  try {
    const response = (await params.ctx.app.client.conversations.replies({
      channel: params.message.channel,
      ts: threadTs,
      oldest: threadTs,
      include_all_metadata: true,
      limit: 4,
    })) as {
      messages?: Array<{
        metadata?: unknown;
      }>;
    };
    for (const message of response.messages ?? []) {
      const context = parseSlackAssistantThreadMetadata(message.metadata);
      if (!context) {
        continue;
      }
      return {
        assistantChannelId: params.message.channel,
        threadTs,
        userId: params.message.user,
        channelId: context.channelId,
        teamId: context.teamId,
        enterpriseId: context.enterpriseId,
      };
    }
  } catch (err) {
    logVerbose(
      `slack assistant context restore failed channel=${params.message.channel} ts=${threadTs}: ${formatErrorMessage(err)}`,
    );
  }
  return undefined;
}

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

function isSlackImageFileCandidate(file: SlackFile): boolean {
  const mime = file.mimetype?.split(";")[0]?.trim().toLowerCase();
  if (mime?.startsWith("image/")) {
    return true;
  }
  return Boolean(mimeTypeFromFilePath(file.name)?.startsWith("image/"));
}

function sliceSlackImageFileCandidates(files: SlackFile[] | undefined, limit: number): SlackFile[] {
  if (limit <= 0 || !files?.length) {
    return [];
  }
  return files.filter(isSlackImageFileCandidate).slice(0, limit);
}

function sliceSlackHistoryAttachmentCandidates(
  attachments: SlackAttachment[] | undefined,
  limit: number,
): SlackAttachment[] {
  if (limit <= 0 || !attachments?.length) {
    return [];
  }
  const out: SlackAttachment[] = [];
  let remaining = limit;
  for (const attachment of attachments) {
    if (attachment.is_share !== true) {
      continue;
    }
    const hasImageUrl = Boolean(normalizeOptionalString(attachment.image_url));
    const files = sliceSlackImageFileCandidates(
      attachment.files,
      remaining - (hasImageUrl ? 1 : 0),
    );
    if (!hasImageUrl && files.length === 0) {
      continue;
    }
    out.push({ ...attachment, files });
    remaining -= (hasImageUrl ? 1 : 0) + files.length;
    if (remaining <= 0) {
      break;
    }
  }
  return out;
}

function buildSlackHistoryMediaCandidateMessage(
  message: SlackMessageEvent,
): SlackMessageEvent | null {
  const files = sliceSlackImageFileCandidates(message.files, SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS);
  const attachments = sliceSlackHistoryAttachmentCandidates(
    message.attachments,
    Math.max(0, SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS - files.length),
  );
  if (files.length === 0 && attachments.length === 0) {
    return null;
  }
  return {
    ...message,
    files,
    attachments,
  };
}

async function resolveSlackHistoryMediaForPendingRecord(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
  isBotMessage: boolean;
}) {
  const mediaMessage = buildSlackHistoryMediaCandidateMessage(params.message);
  if (!mediaMessage) {
    return [];
  }
  const content = await resolveSlackMessageContent({
    message: mediaMessage,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
    isBotMessage: params.isBotMessage,
    client: params.ctx.app.client,
    botToken: params.ctx.botToken,
    mediaMaxBytes: Math.min(params.ctx.mediaMaxBytes, SLACK_HISTORY_MEDIA_MAX_BYTES),
    mediaReadIdleTimeoutMs: SLACK_HISTORY_MEDIA_IDLE_TIMEOUT_MS,
    mediaTotalTimeoutMs: SLACK_HISTORY_MEDIA_TOTAL_TIMEOUT_MS,
  });
  return toInboundMediaFacts(content?.effectiveDirectMedia, {
    kind: "image",
    messageId: params.message.ts,
  });
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
  const messageAssistantThreadContext = resolveSlackMessageAssistantThreadContext(message);
  const assistantContextLookupChannelId =
    messageAssistantThreadContext?.assistantChannelId ?? message.channel;
  const assistantContextLookupThreadTs =
    messageAssistantThreadContext?.threadTs ?? message.thread_ts ?? message.ts;
  const cachedAssistantThreadContext = isDirectMessage
    ? ctx.getSlackAssistantThreadContext(
        assistantContextLookupChannelId,
        assistantContextLookupThreadTs,
      )
    : undefined;
  const restoredAssistantThreadContext =
    isDirectMessage &&
    !cachedAssistantThreadContext &&
    !hasSlackAssistantThreadMetadata(messageAssistantThreadContext)
      ? await restoreSlackAssistantThreadContextFromMetadata({ ctx, message })
      : undefined;
  const assistantThreadContext = mergeSlackAssistantThreadContext(
    messageAssistantThreadContext,
    cachedAssistantThreadContext ?? restoredAssistantThreadContext,
  );
  const assistantThreadContextToCache =
    messageAssistantThreadContext || restoredAssistantThreadContext
      ? assistantThreadContext
      : undefined;
  if (assistantThreadContextToCache) {
    ctx.saveSlackAssistantThreadContext(assistantThreadContextToCache);
  }
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
    assistantThreadTs: assistantThreadContext?.threadTs,
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
      assistantThreadTs: assistantThreadContext?.threadTs,
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
  const directThreadRoutedToDmSession =
    !assistantThreadContext &&
    isDirectMessage &&
    isThreadReply &&
    threadTs &&
    runtimeBinding?.conversation.conversationId !== threadTs;
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
  const hasAbortRequest = isAbortRequestText(textForCommandDetection);
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
    const historyMediaCandidate = buildSlackHistoryMediaCandidateMessage(message);
    const fallbackFile = message.files?.length
      ? `[Slack file: ${formatSlackFileReference(message.files[0])}]`
      : "";
    const fallbackSharedMedia =
      !fallbackFile && historyMediaCandidate ? "[Slack media attachment]" : "";
    const pendingBody = pendingText || fallbackFile || fallbackSharedMedia;
    const skippedThreadStarter =
      historyMediaCandidate && isThreadReply && threadTs
        ? await resolveSlackThreadStarter({
            channelId: message.channel,
            threadTs,
            client: ctx.app.client,
          })
        : null;
    const timestamp = message.ts ? Math.round(Number(message.ts) * 1000) : undefined;
    const senderName = pendingBody ? await resolveSenderName() : undefined;
    await recordDroppedChannelTurnHistory({
      input: {
        id: message.ts ?? `${message.channel}:${Date.now()}`,
        timestamp,
        rawText: pendingBody,
        textForAgent: pendingBody,
        raw: message,
      },
      admission: { kind: "drop", reason: "slack-no-mention", recordHistory: true },
      preflight: {
        message: pendingBody
          ? {
              rawBody: pendingBody,
              body: pendingBody,
              bodyForAgent: pendingBody,
              senderLabel: senderName,
              envelopeFrom: senderName,
            }
          : undefined,
        history: {
          key: historyKey,
          historyMap: ctx.channelHistories,
          limit: ctx.historyLimit,
          recordOnDrop: true,
          mediaLimit: SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS,
        },
        media: () =>
          resolveSlackHistoryMediaForPendingRecord({
            ctx,
            message,
            isThreadReply,
            threadStarter: skippedThreadStarter,
            isBotMessage,
          }),
      },
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
  const inboundEventKind = classifyChannelInboundEvent({
    conversation: { kind: chatType },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg,
      agentId: route.agentId,
    }),
    wasMentioned: effectiveWasMentioned,
    hasControlCommand: hasControlCommandInMessage,
    hasAbortRequest,
  });

  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "slack",
    accountId: account.accountId,
  });
  const ackReactionValue = ackReaction ?? "";
  const sourceRepliesAreToolOnly =
    resolveChannelMessageSourceReplyDeliveryMode({
      cfg,
      ctx: { ChatType: chatType, InboundEventKind: inboundEventKind },
    }) === "message_tool_only";
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
    forceSenderIsOwnerFalse: true,
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
  const channelHistory = createChannelHistoryWindow({ historyMap: ctx.channelHistories });
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
    combinedBody = channelHistory.buildPendingContext({
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
    forceInitialHistory: Boolean(directThreadRoutedToDmSession),
    allowFromLower: threadContextAllowFromLower,
    allowNameMatching: ctx.allowNameMatching,
    contextVisibilityMode,
    envelopeOptions,
    effectiveDirectMedia,
  });

  // Use direct media (including forwarded attachment media) if available, else thread starter media
  const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
  const inboundHistory =
    isRoomish && ctx.historyLimit > 0
      ? channelHistory.buildInboundHistory({
          historyKey,
          limit: ctx.historyLimit,
        })
      : dmHistoryContext.inboundHistory;
  const commandBody = textForCommandDetection.trim();
  const supplementalThreadHistoryBody =
    directThreadRoutedToDmSession && !threadHistoryBody ? threadStarterBody : threadHistoryBody;
  const effectiveMessageThreadId =
    assistantThreadContext?.threadTs ?? threadContext.messageThreadId;

  const ctxPayload = buildChannelInboundEventContext({
    channel: "slack",
    provider: "slack",
    surface: "slack",
    accountId: route.accountId,
    messageId: message.ts,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    from: slackFrom,
    sender: {
      id: senderId,
      name: senderName,
      displayLabel: senderName,
    },
    conversation: {
      kind: chatType,
      id: message.channel,
      label: envelopeFrom,
      spaceId: ctx.teamId || undefined,
      threadId: directThreadRoutedToDmSession ? undefined : effectiveMessageThreadId,
      nativeChannelId: message.channel,
      routePeer: {
        kind: chatType,
        id: message.channel,
      },
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: sessionKey,
      parentSessionKey: threadKeys.parentSessionKey,
    },
    reply: {
      to: slackTo,
      originatingTo: slackTo,
      replyToId: threadContext.replyToId,
      messageThreadId: directThreadRoutedToDmSession ? undefined : effectiveMessageThreadId,
      nativeChannelId: message.channel,
    },
    message: {
      inboundEventKind,
      body: combinedBody,
      bodyForAgent: rawBody,
      rawBody,
      commandBody,
      envelopeFrom,
      inboundHistory,
    },
    access: {
      mentions: {
        canDetectMention: isRoomish,
        wasMentioned: effectiveWasMentioned,
        hasAnyMention: explicitlyMentioned || mentionedSubteamIds.length > 0,
        implicitMentionKinds: matchedImplicitMentionKinds as Array<
          "reply_to_bot" | "quoted_bot" | "bot_thread_participant" | "native"
        >,
        requireMention: shouldRequireMention,
        effectiveWasMentioned,
      },
      commands: {
        authorized: commandAuthorized,
        allowTextCommands,
        useAccessGroups: false,
        authorizers: [],
      },
    },
    media: toInboundMediaFacts(effectiveMedia),
    supplemental: {
      thread: {
        // Only include thread starter body for NEW sessions (existing sessions already have it in their transcript)
        starterBody:
          !directThreadRoutedToDmSession && !threadSessionPreviousTimestamp
            ? threadStarterBody
            : undefined,
        historyBody: supplementalThreadHistoryBody,
        label: directThreadRoutedToDmSession ? undefined : threadLabel,
      },
      groupSystemPrompt,
    },
    extra: {
      GroupSubject: isRoomish ? roomLabel : undefined,
      UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
      TransportThreadId: directThreadRoutedToDmSession ? threadContext.messageThreadId : undefined,
      SlackAssistantThread: assistantThreadContext ? true : undefined,
      SlackAssistantThreadContextChannelId: assistantThreadContext?.channelId,
      SlackAssistantThreadContextTeamId: assistantThreadContext?.teamId,
      SlackAssistantThreadContextEnterpriseId: assistantThreadContext?.enterpriseId ?? undefined,
      IsFirstThreadTurn:
        isThreadReply &&
        threadTs &&
        !directThreadRoutedToDmSession &&
        !threadSessionPreviousTimestamp
          ? true
          : undefined,
      ...buildSlackMentionContextPayload({
        isRoomish,
        effectiveWasMentioned,
        explicitlyMentioned,
        mentionedUserIds,
        mentionedSubteamIds,
        matchedImplicitMentionKinds,
        mentionSource,
      }),
    },
  }) satisfies FinalizedMsgContext;

  if (isRoomish && !shouldRequireMention) {
    channelHistory.record({
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

  const updateLastRouteSessionKey = resolveInboundLastRouteSessionKey({ route, sessionKey });

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
              sessionKey: updateLastRouteSessionKey,
              channel: "slack",
              to: `user:${message.user}`,
              accountId: route.accountId,
              threadId: effectiveMessageThreadId,
              mainDmOwnerPin:
                updateLastRouteSessionKey === route.mainSessionKey &&
                pinnedMainDmOwner &&
                message.user
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
      history:
        isRoomish && shouldRequireMention
          ? {
              isGroup: true,
              historyKey,
              historyMap: ctx.channelHistories,
              limit: ctx.historyLimit,
            }
          : undefined,
    },
    replyToMode,
    ...(assistantThreadContext?.threadTs
      ? { forcedReplyThreadTs: assistantThreadContext.threadTs }
      : {}),
    ...(assistantThreadContext
      ? { slackMessageMetadata: buildSlackAssistantThreadMetadata(assistantThreadContext) }
      : {}),
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
