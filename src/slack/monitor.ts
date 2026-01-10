import {
  App,
  type SlackCommandMiddlewareArgs,
  type SlackEventMiddlewareArgs,
} from "@slack/bolt";
import type { WebClient as SlackWebClient } from "@slack/web-api";
import {
  resolveAckReaction,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../agents/identity.js";
import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  buildCommandText,
  listNativeCommandSpecs,
  shouldHandleTextCommands,
} from "../auto-reply/commands-registry.js";
import {
  formatAgentEnvelope,
  formatThreadStarterEnvelope,
} from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "../auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type {
  ClawdbotConfig,
  SlackReactionNotificationMode,
  SlackSlashCommandConfig,
} from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  resolveSessionKey,
  resolveStorePath,
  updateLastRoute,
} from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { type FetchLike, fetchRemoteMedia } from "../media/fetch.js";
import { saveMediaBuffer } from "../media/store.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  normalizeMainKey,
  resolveThreadSessionKeys,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveSlackAccount } from "./accounts.js";
import { reactSlackMessage, removeSlackReaction } from "./actions.js";
import { sendMessageSlack } from "./send.js";
import { resolveSlackThreadTargets } from "./threading.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "./token.js";
import type {
  SlackAppMentionEvent,
  SlackFile,
  SlackMessageEvent,
} from "./types.js";

export type MonitorSlackOpts = {
  botToken?: string;
  appToken?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  slashCommand?: SlackSlashCommandConfig;
};

type SlackReactionEvent = {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction?: string;
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  item_user?: string;
  event_ts?: string;
};

type SlackMemberChannelEvent = {
  type: "member_joined_channel" | "member_left_channel";
  user?: string;
  channel?: string;
  channel_type?: SlackMessageEvent["channel_type"];
  event_ts?: string;
};

type SlackChannelCreatedEvent = {
  type: "channel_created";
  channel?: { id?: string; name?: string };
  event_ts?: string;
};

type SlackChannelRenamedEvent = {
  type: "channel_rename";
  channel?: { id?: string; name?: string; name_normalized?: string };
  event_ts?: string;
};

type SlackPinEvent = {
  type: "pin_added" | "pin_removed";
  channel_id?: string;
  user?: string;
  item?: { type?: string; message?: { ts?: string } };
  event_ts?: string;
};

type SlackMessageChangedEvent = {
  type: "message";
  subtype: "message_changed";
  channel?: string;
  message?: { ts?: string };
  previous_message?: { ts?: string };
  event_ts?: string;
};

type SlackMessageDeletedEvent = {
  type: "message";
  subtype: "message_deleted";
  channel?: string;
  deleted_ts?: string;
  event_ts?: string;
};

type SlackThreadBroadcastEvent = {
  type: "message";
  subtype: "thread_broadcast";
  channel?: string;
  message?: { ts?: string };
  event_ts?: string;
};

type SlackChannelConfigResolved = {
  allowed: boolean;
  requireMention: boolean;
  allowBots?: boolean;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
};

function normalizeSlackSlug(raw?: string) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function normalizeAllowList(list?: Array<string | number>) {
  return (list ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeAllowListLower(list?: Array<string | number>) {
  return normalizeAllowList(list).map((entry) => entry.toLowerCase());
}

function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (typeof value !== "undefined") return value;
  }
  return undefined;
}

function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
}) {
  const allowList = params.allowList;
  if (allowList.length === 0) return false;
  if (allowList.includes("*")) return true;
  const id = params.id?.toLowerCase();
  const name = params.name?.toLowerCase();
  const slug = normalizeSlackSlug(name);
  const candidates = [
    id,
    id ? `slack:${id}` : undefined,
    id ? `user:${id}` : undefined,
    name,
    name ? `slack:${name}` : undefined,
    slug,
  ].filter(Boolean) as string[];
  return candidates.some((value) => allowList.includes(value));
}

function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
  userName?: string;
}) {
  const allowList = normalizeAllowListLower(params.allowList);
  if (allowList.length === 0) return true;
  return allowListMatches({
    allowList,
    id: params.userId,
    name: params.userName,
  });
}

function resolveSlackSlashCommandConfig(
  raw?: SlackSlashCommandConfig,
): Required<SlackSlashCommandConfig> {
  return {
    enabled: raw?.enabled === true,
    name: raw?.name?.trim() || "clawd",
    sessionPrefix: raw?.sessionPrefix?.trim() || "slack:slash",
    ephemeral: raw?.ephemeral !== false,
  };
}

function shouldEmitSlackReactionNotification(params: {
  mode: SlackReactionNotificationMode | undefined;
  botId?: string | null;
  messageAuthorId?: string | null;
  userId: string;
  userName?: string | null;
  allowlist?: Array<string | number> | null;
}) {
  const { mode, botId, messageAuthorId, userId, userName, allowlist } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") return false;
  if (effectiveMode === "own") {
    if (!botId || !messageAuthorId) return false;
    return messageAuthorId === botId;
  }
  if (effectiveMode === "allowlist") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
    const users = normalizeAllowListLower(allowlist);
    return allowListMatches({
      allowList: users,
      id: userId,
      name: userName ?? undefined,
    });
  }
  return true;
}

function resolveSlackChannelLabel(params: {
  channelId?: string;
  channelName?: string;
}) {
  const channelName = params.channelName?.trim();
  if (channelName) {
    const slug = normalizeSlackSlug(channelName);
    return `#${slug || channelName}`;
  }
  const channelId = params.channelId?.trim();
  return channelId ? `#${channelId}` : "unknown channel";
}

function resolveSlackChannelConfig(params: {
  channelId: string;
  channelName?: string;
  channels?: Record<
    string,
    {
      enabled?: boolean;
      allow?: boolean;
      requireMention?: boolean;
      allowBots?: boolean;
      users?: Array<string | number>;
      skills?: string[];
      systemPrompt?: string;
    }
  >;
}): SlackChannelConfigResolved | null {
  const { channelId, channelName, channels } = params;
  const entries = channels ?? {};
  const keys = Object.keys(entries);
  const normalizedName = channelName ? normalizeSlackSlug(channelName) : "";
  const directName = channelName ? channelName.trim() : "";
  const candidates = [
    channelId,
    channelName ? `#${directName}` : "",
    directName,
    normalizedName,
  ].filter(Boolean);

  let matched:
    | {
        enabled?: boolean;
        allow?: boolean;
        requireMention?: boolean;
        allowBots?: boolean;
        users?: Array<string | number>;
        skills?: string[];
        systemPrompt?: string;
      }
    | undefined;
  for (const candidate of candidates) {
    if (candidate && entries[candidate]) {
      matched = entries[candidate];
      break;
    }
  }
  const fallback = entries["*"];

  if (keys.length === 0) {
    return { allowed: true, requireMention: true };
  }
  if (!matched && !fallback) {
    return { allowed: false, requireMention: true };
  }

  const resolved = matched ?? fallback ?? {};
  const allowed =
    firstDefined(
      resolved.enabled,
      resolved.allow,
      fallback?.enabled,
      fallback?.allow,
      true,
    ) ?? true;
  const requireMention =
    firstDefined(resolved.requireMention, fallback?.requireMention, true) ??
    true;
  const allowBots = firstDefined(resolved.allowBots, fallback?.allowBots);
  const users = firstDefined(resolved.users, fallback?.users);
  const skills = firstDefined(resolved.skills, fallback?.skills);
  const systemPrompt = firstDefined(
    resolved.systemPrompt,
    fallback?.systemPrompt,
  );
  return { allowed, requireMention, allowBots, users, skills, systemPrompt };
}

async function resolveSlackMedia(params: {
  files?: SlackFile[];
  token: string;
  maxBytes: number;
}): Promise<{
  path: string;
  contentType?: string;
  placeholder: string;
} | null> {
  const files = params.files ?? [];
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue;
    try {
      const fetchImpl: FetchLike = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${params.token}`);
        return fetch(input, { ...init, headers });
      };
      const fetched = await fetchRemoteMedia({
        url,
        fetchImpl,
        filePathHint: file.name,
      });
      if (fetched.buffer.byteLength > params.maxBytes) continue;
      const saved = await saveMediaBuffer(
        fetched.buffer,
        fetched.contentType ?? file.mimetype,
        "inbound",
        params.maxBytes,
      );
      const label = fetched.fileName ?? file.name;
      return {
        path: saved.path,
        contentType: saved.contentType,
        placeholder: label ? `[Slack file: ${label}]` : "[Slack file]",
      };
    } catch {
      // Ignore download failures and fall through to the next file.
    }
  }
  return null;
}

type SlackThreadStarter = {
  text: string;
  userId?: string;
  ts?: string;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarter>();

async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) return cached;
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as { messages?: Array<{ text?: string; user?: string; ts?: string }> };
    const message = response?.messages?.[0];
    const text = (message?.text ?? "").trim();
    if (!message || !text) return null;
    const starter: SlackThreadStarter = {
      text,
      userId: message.user,
      ts: message.ts,
    };
    THREAD_STARTER_CACHE.set(cacheKey, starter);
    return starter;
  } catch {
    return null;
  }
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();
  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const resolveSlackSystemEventSessionKey = (params: {
    channelId?: string | null;
    channelType?: string | null;
  }) => {
    const channelId = params.channelId?.trim() ?? "";
    if (!channelId) return mainKey;
    const channelType = params.channelType?.trim().toLowerCase() ?? "";
    const isRoom = channelType === "channel" || channelType === "group";
    const isGroup = channelType === "mpim";
    const from = isRoom
      ? `slack:channel:${channelId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:${channelId}`;
    const chatType = isRoom ? "room" : isGroup ? "group" : "direct";
    return resolveSessionKey(
      sessionScope,
      { From: from, ChatType: chatType, Provider: "slack" },
      mainKey,
    );
  };
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  if (!botToken || !appToken) {
    throw new Error(
      `Slack bot + app tokens missing for account "${account.accountId}" (set slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`,
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;
  const dmPolicy = dmConfig?.policy ?? "pairing";
  const allowFrom = normalizeAllowList(dmConfig?.allowFrom);
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = normalizeAllowList(dmConfig?.groupChannels);
  const channelsConfig = slackCfg.channels;
  const dmEnabled = dmConfig?.enabled ?? true;
  const groupPolicy = slackCfg.groupPolicy ?? "open";
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const slashCommand = resolveSlackSlashCommandConfig(
    opts.slashCommand ?? slackCfg.slashCommand,
  );
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId);
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;

  const logger = getChildLogger({ module: "slack-auto-reply" });
  const channelCache = new Map<
    string,
    {
      name?: string;
      type?: SlackMessageEvent["channel_type"];
      topic?: string;
      purpose?: string;
    }
  >();
  const userCache = new Map<string, { name?: string }>();
  const seenMessages = new Map<string, number>();

  const markMessageSeen = (channelId: string | undefined, ts?: string) => {
    if (!channelId || !ts) return false;
    const key = `${channelId}:${ts}`;
    if (seenMessages.has(key)) return true;
    seenMessages.set(key, Date.now());
    if (seenMessages.size > 500) {
      const cutoff = Date.now() - 60_000;
      for (const [entry, seenAt] of seenMessages) {
        if (seenAt < cutoff || seenMessages.size > 450) {
          seenMessages.delete(entry);
        } else {
          break;
        }
      }
    }
    return false;
  };

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  let botUserId = "";
  let teamId = "";
  try {
    const auth = await app.client.auth.test({ token: botToken });
    botUserId = auth.user_id ?? "";
    teamId = auth.team_id ?? "";
  } catch (err) {
    runtime.error?.(danger(`slack auth failed: ${String(err)}`));
  }

  const resolveChannelName = async (channelId: string) => {
    const cached = channelCache.get(channelId);
    if (cached) return cached;
    try {
      const info = await app.client.conversations.info({
        token: botToken,
        channel: channelId,
      });
      const name =
        info.channel && "name" in info.channel ? info.channel.name : undefined;
      const channel = info.channel ?? undefined;
      const type: SlackMessageEvent["channel_type"] | undefined = channel?.is_im
        ? "im"
        : channel?.is_mpim
          ? "mpim"
          : channel?.is_channel
            ? "channel"
            : channel?.is_group
              ? "group"
              : undefined;
      const topic =
        channel && "topic" in channel
          ? (channel.topic?.value ?? undefined)
          : undefined;
      const purpose =
        channel && "purpose" in channel
          ? (channel.purpose?.value ?? undefined)
          : undefined;
      const entry = { name, type, topic, purpose };
      channelCache.set(channelId, entry);
      return entry;
    } catch {
      return {};
    }
  };

  const resolveUserName = async (userId: string) => {
    const cached = userCache.get(userId);
    if (cached) return cached;
    try {
      const info = await app.client.users.info({
        token: botToken,
        user: userId,
      });
      const profile = info.user?.profile;
      const name =
        profile?.display_name ||
        profile?.real_name ||
        info.user?.name ||
        undefined;
      const entry = { name };
      userCache.set(userId, entry);
      return entry;
    } catch {
      return {};
    }
  };

  const setSlackThreadStatus = async (params: {
    channelId: string;
    threadTs?: string;
    status: string;
  }) => {
    if (!params.threadTs) return;
    const payload = {
      token: botToken,
      channel_id: params.channelId,
      thread_ts: params.threadTs,
      status: params.status,
    };
    const client = app.client as unknown as {
      assistant?: {
        threads?: {
          setStatus?: (args: typeof payload) => Promise<unknown>;
        };
      };
      apiCall?: (method: string, args: typeof payload) => Promise<unknown>;
    };
    try {
      if (client.assistant?.threads?.setStatus) {
        await client.assistant.threads.setStatus(payload);
        return;
      }
      if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setStatus", payload);
      }
    } catch (err) {
      logVerbose(
        `slack status update failed for channel ${params.channelId}: ${String(err)}`,
      );
    }
  };

  const isChannelAllowed = (params: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => {
    const channelType = params.channelType;
    const isDirectMessage = channelType === "im";
    const isGroupDm = channelType === "mpim";
    const isRoom = channelType === "channel" || channelType === "group";

    if (isDirectMessage && !dmEnabled) return false;
    if (isGroupDm && !groupDmEnabled) return false;

    if (isGroupDm && groupDmChannels.length > 0) {
      const allowList = normalizeAllowListLower(groupDmChannels);
      const candidates = [
        params.channelId,
        params.channelName ? `#${params.channelName}` : undefined,
        params.channelName,
        params.channelName ? normalizeSlackSlug(params.channelName) : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      const permitted =
        allowList.includes("*") ||
        candidates.some((candidate) => allowList.includes(candidate));
      if (!permitted) return false;
    }

    if (isRoom && params.channelId) {
      const channelConfig = resolveSlackChannelConfig({
        channelId: params.channelId,
        channelName: params.channelName,
        channels: channelsConfig,
      });
      const channelAllowed = channelConfig?.allowed !== false;
      const channelAllowlistConfigured =
        Boolean(channelsConfig) && Object.keys(channelsConfig ?? {}).length > 0;
      if (
        !isSlackRoomAllowedByPolicy({
          groupPolicy,
          channelAllowlistConfigured,
          channelAllowed,
        })
      ) {
        return false;
      }
      if (!channelAllowed) return false;
    }

    return true;
  };

  const handleSlackMessage = async (
    message: SlackMessageEvent,
    opts: { source: "message" | "app_mention"; wasMentioned?: boolean },
  ) => {
    if (opts.source === "message" && message.type !== "message") return;
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message"
    ) {
      return;
    }
    if (markMessageSeen(message.channel, message.ts)) return;

    let channelInfo: {
      name?: string;
      type?: SlackMessageEvent["channel_type"];
      topic?: string;
      purpose?: string;
    } = {};
    let channelType = message.channel_type;
    if (!channelType || channelType !== "im") {
      channelInfo = await resolveChannelName(message.channel);
      channelType = channelType ?? channelInfo.type;
    }
    const channelName = channelInfo?.name;
    const resolvedChannelType = channelType;
    const isDirectMessage = resolvedChannelType === "im";
    const isGroupDm = resolvedChannelType === "mpim";
    const isRoom =
      resolvedChannelType === "channel" || resolvedChannelType === "group";

    const channelConfig = isRoom
      ? resolveSlackChannelConfig({
          channelId: message.channel,
          channelName,
          channels: channelsConfig,
        })
      : null;

    const allowBots =
      channelConfig?.allowBots ??
      account.config?.allowBots ??
      cfg.slack?.allowBots ??
      false;
    const isBotMessage = Boolean(message.bot_id);
    if (isBotMessage) {
      if (message.user && botUserId && message.user === botUserId) return;
      if (!allowBots) {
        logVerbose(
          `slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`,
        );
        return;
      }
    }
    if (isDirectMessage && !message.user) {
      logVerbose("slack: drop dm message (missing user id)");
      return;
    }
    const senderId =
      message.user ?? (isBotMessage ? message.bot_id : undefined);
    if (!senderId) {
      logVerbose("slack: drop message (missing sender id)");
      return;
    }

    if (
      !isChannelAllowed({
        channelId: message.channel,
        channelName,
        channelType: resolvedChannelType,
      })
    ) {
      logVerbose("slack: drop message (channel not allowed)");
      return;
    }

    const storeAllowFrom = await readProviderAllowFromStore("slack").catch(
      () => [],
    );
    const effectiveAllowFrom = normalizeAllowList([
      ...allowFrom,
      ...storeAllowFrom,
    ]);
    const effectiveAllowFromLower = normalizeAllowListLower(effectiveAllowFrom);

    if (isDirectMessage) {
      const directUserId = message.user;
      if (!directUserId) {
        logVerbose("slack: drop dm message (missing user id)");
        return;
      }
      if (!dmEnabled || dmPolicy === "disabled") {
        logVerbose("slack: drop dm (dms disabled)");
        return;
      }
      if (dmPolicy !== "open") {
        const permitted = allowListMatches({
          allowList: effectiveAllowFromLower,
          id: directUserId,
        });
        if (!permitted) {
          if (dmPolicy === "pairing") {
            const sender = await resolveUserName(directUserId);
            const senderName = sender?.name ?? undefined;
            const { code, created } = await upsertProviderPairingRequest({
              provider: "slack",
              id: directUserId,
              meta: { name: senderName },
            });
            if (created) {
              logVerbose(
                `slack pairing request sender=${directUserId} name=${senderName ?? "unknown"}`,
              );
              try {
                await sendMessageSlack(
                  message.channel,
                  buildPairingReply({
                    provider: "slack",
                    idLine: `Your Slack user id: ${directUserId}`,
                    code,
                  }),
                  {
                    token: botToken,
                    client: app.client,
                    accountId: account.accountId,
                  },
                );
              } catch (err) {
                logVerbose(
                  `slack pairing reply failed for ${message.user}: ${String(err)}`,
                );
              }
            }
          } else {
            logVerbose(
              `Blocked unauthorized slack sender ${message.user} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }
      }
    }

    const route = resolveAgentRoute({
      cfg,
      provider: "slack",
      accountId: account.accountId,
      teamId: teamId || undefined,
      peer: {
        kind: isDirectMessage ? "dm" : isRoom ? "channel" : "group",
        id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
      },
    });
    const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      opts.wasMentioned ??
      (!isDirectMessage &&
        (Boolean(botUserId && message.text?.includes(`<@${botUserId}>`)) ||
          matchesMentionPatterns(message.text ?? "", mentionRegexes)));
    const sender = message.user ? await resolveUserName(message.user) : null;
    const senderName =
      sender?.name ??
      message.username?.trim() ??
      message.user ??
      message.bot_id ??
      "unknown";
    const channelUserAuthorized = isRoom
      ? resolveSlackUserAllowed({
          allowList: channelConfig?.users,
          userId: senderId,
          userName: senderName,
        })
      : true;
    if (isRoom && !channelUserAuthorized) {
      logVerbose(
        `Blocked unauthorized slack sender ${senderId} (not in channel users)`,
      );
      return;
    }
    const allowList = effectiveAllowFromLower;
    const commandAuthorized =
      (allowList.length === 0 ||
        allowListMatches({
          allowList,
          id: senderId,
          name: senderName,
        })) &&
      channelUserAuthorized;
    const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
    const allowTextCommands = shouldHandleTextCommands({
      cfg,
      surface: "slack",
    });
    const shouldRequireMention = isRoom
      ? (channelConfig?.requireMention ?? true)
      : false;
    const shouldBypassMention =
      allowTextCommands &&
      isRoom &&
      shouldRequireMention &&
      !wasMentioned &&
      !hasAnyMention &&
      commandAuthorized &&
      hasControlCommand(message.text ?? "");
    const effectiveWasMentioned = wasMentioned || shouldBypassMention;
    const canDetectMention = Boolean(botUserId) || mentionRegexes.length > 0;
    if (
      isRoom &&
      shouldRequireMention &&
      canDetectMention &&
      !wasMentioned &&
      !shouldBypassMention
    ) {
      logger.info(
        { channel: message.channel, reason: "no-mention" },
        "skipping room message",
      );
      return;
    }

    const media = await resolveSlackMedia({
      files: message.files,
      token: botToken,
      maxBytes: mediaMaxBytes,
    });
    const rawBody = (message.text ?? "").trim() || media?.placeholder || "";
    if (!rawBody) return;
    const ackReaction = resolveAckReaction(cfg, route.agentId);
    const ackReactionValue = ackReaction ?? "";
    const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return isDirectMessage;
      const isGroupChat = isRoom || isGroupDm;
      if (ackReactionScope === "group-all") return isGroupChat;
      if (ackReactionScope === "group-mentions") {
        if (!isRoom) return false;
        if (!shouldRequireMention) return false;
        if (!canDetectMention) return false;
        return wasMentioned || shouldBypassMention;
      }
      return false;
    };
    const ackReactionMessageTs = message.ts;
    const ackReactionPromise =
      shouldAckReaction() && ackReactionMessageTs && ackReactionValue
        ? reactSlackMessage(
            message.channel,
            ackReactionMessageTs,
            ackReactionValue,
            {
              token: botToken,
              client: app.client,
            },
          ).then(
            () => true,
            (err) => {
              logVerbose(
                `slack react failed for channel ${message.channel}: ${String(err)}`,
              );
              return false;
            },
          )
        : null;

    const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
    const isRoomish = isRoom || isGroupDm;
    const historyKey = message.channel;
    const historyEntry =
      isRoomish && historyLimit > 0
        ? {
            sender: senderName,
            body: rawBody,
            timestamp: message.ts
              ? Math.round(Number(message.ts) * 1000)
              : undefined,
            messageId: message.ts,
          }
        : undefined;

    const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isDirectMessage
      ? `Slack DM from ${senderName}`
      : `Slack message in ${roomLabel} from ${senderName}`;
    const slackFrom = isDirectMessage
      ? `slack:${message.user}`
      : isRoom
        ? `slack:channel:${message.channel}`
        : `slack:group:${message.channel}`;
    const baseSessionKey = route.sessionKey;
    const threadTs = message.thread_ts;
    const hasThreadTs = typeof threadTs === "string" && threadTs.length > 0;
    const isThreadReply =
      hasThreadTs &&
      (threadTs !== message.ts || Boolean(message.parent_user_id));
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      threadId: isThreadReply ? threadTs : undefined,
      parentSessionKey: isThreadReply ? baseSessionKey : undefined,
    });
    const sessionKey = threadKeys.sessionKey;
    enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
    });

    const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}]`;
    const body = formatAgentEnvelope({
      provider: "Slack",
      from: senderName,
      timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
      body: textWithId,
    });

    let combinedBody = body;
    if (isRoomish && historyLimit > 0) {
      combinedBody = buildHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        entry: historyEntry,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          formatAgentEnvelope({
            provider: "Slack",
            from: roomLabel,
            timestamp: entry.timestamp,
            body: `${entry.sender}: ${entry.body}${
              entry.messageId
                ? ` [id:${entry.messageId} channel:${message.channel}]`
                : ""
            }`,
          }),
      });
    }
    const slackTo = isDirectMessage
      ? `user:${message.user}`
      : `channel:${message.channel}`;
    const channelDescription = [channelInfo?.topic, channelInfo?.purpose]
      .map((entry) => entry?.trim())
      .filter((entry): entry is string => Boolean(entry))
      .filter((entry, index, list) => list.indexOf(entry) === index)
      .join("\n");
    const systemPromptParts = [
      channelDescription ? `Channel description: ${channelDescription}` : null,
      channelConfig?.systemPrompt?.trim() || null,
    ].filter((entry): entry is string => Boolean(entry));
    const groupSystemPrompt =
      systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
    let threadStarterBody: string | undefined;
    let threadLabel: string | undefined;
    if (isThreadReply && threadTs) {
      const starter = await resolveSlackThreadStarter({
        channelId: message.channel,
        threadTs,
        client: app.client,
      });
      if (starter?.text) {
        const starterUser = starter.userId
          ? await resolveUserName(starter.userId)
          : null;
        const starterName = starterUser?.name ?? starter.userId ?? "Unknown";
        const starterWithId = `${starter.text}\n[slack message id: ${starter.ts ?? threadTs} channel: ${message.channel}]`;
        threadStarterBody = formatThreadStarterEnvelope({
          provider: "Slack",
          author: starterName,
          timestamp: starter.ts
            ? Math.round(Number(starter.ts) * 1000)
            : undefined,
          body: starterWithId,
        });
        const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
        threadLabel = `Slack thread ${roomLabel}${snippet ? `: ${snippet}` : ""}`;
      } else {
        threadLabel = `Slack thread ${roomLabel}`;
      }
    }
    const ctxPayload = {
      Body: combinedBody,
      RawBody: rawBody,
      CommandBody: rawBody,
      From: slackFrom,
      To: slackTo,
      SessionKey: sessionKey,
      AccountId: route.accountId,
      ChatType: isDirectMessage ? "direct" : isRoom ? "room" : "group",
      GroupSubject: isRoomish ? roomLabel : undefined,
      GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
      SenderName: senderName,
      SenderId: senderId,
      Provider: "slack" as const,
      Surface: "slack" as const,
      MessageSid: message.ts,
      ReplyToId: message.thread_ts ?? message.ts,
      ParentSessionKey: threadKeys.parentSessionKey,
      ThreadStarterBody: threadStarterBody,
      ThreadLabel: threadLabel,
      Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
      WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
      MediaPath: media?.path,
      MediaType: media?.contentType,
      MediaUrl: media?.path,
      CommandAuthorized: commandAuthorized,
      // Originating channel for reply routing.
      OriginatingChannel: "slack" as const,
      OriginatingTo: slackTo,
    };

    const replyTarget = ctxPayload.To ?? undefined;
    if (!replyTarget) {
      runtime.error?.(danger("slack: missing reply target"));
      return;
    }

    if (isDirectMessage) {
      const sessionCfg = cfg.session;
      const storePath = resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        provider: "slack",
        to: `user:${message.user}`,
        accountId: route.accountId,
      });
    }

    if (shouldLogVerbose()) {
      logVerbose(
        `slack inbound: channel=${message.channel} from=${ctxPayload.From} preview="${preview}"`,
      );
    }

    // Use helper for status thread; compute baseThreadTs for "first" mode support
    const { statusThreadTs } = resolveSlackThreadTargets({
      message,
      replyToMode,
    });
    const messageTs = message.ts ?? message.event_ts;
    const incomingThreadTs = message.thread_ts;
    let didSetStatus = false;
    // Shared mutable ref for tracking if a reply was sent (used by both
    // auto-reply path and tool path for "first" threading mode).
    const hasRepliedRef = { value: false };
    const onReplyStart = async () => {
      didSetStatus = true;
      await setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "is typing...",
      });
    };
    let didSendReply = false;
    const { dispatcher, replyOptions, markDispatchIdle } =
      createReplyDispatcherWithTyping({
        responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
          .responsePrefix,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload) => {
          const effectiveThreadTs = resolveSlackThreadTs({
            replyToMode,
            incomingThreadTs,
            messageTs,
            hasReplied: hasRepliedRef.value,
          });
          await deliverReplies({
            replies: [payload],
            target: replyTarget,
            token: botToken,
            accountId: account.accountId,
            runtime,
            textLimit,
            replyThreadTs: effectiveThreadTs,
          });
          didSendReply = true;
          hasRepliedRef.value = true;
        },
        onError: (err, info) => {
          runtime.error?.(
            danger(`slack ${info.kind} reply failed: ${String(err)}`),
          );
          if (didSetStatus) {
            void setSlackThreadStatus({
              channelId: message.channel,
              threadTs: statusThreadTs,
              status: "",
            });
          }
        },
        onReplyStart,
      });

    const { queuedFinal, counts } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        skillFilter: channelConfig?.skills,
        hasRepliedRef,
        disableBlockStreaming:
          typeof account.config.blockStreaming === "boolean"
            ? !account.config.blockStreaming
            : undefined,
      },
    });
    markDispatchIdle();
    if (didSetStatus) {
      await setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "",
      });
    }
    if (!queuedFinal) {
      if (isRoomish && historyLimit > 0 && didSendReply) {
        clearHistoryEntries({ historyMap: channelHistories, historyKey });
      }
      return;
    }
    if (shouldLogVerbose()) {
      const finalCount = counts.final;
      logVerbose(
        `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
      );
    }
    if (removeAckAfterReply && ackReactionPromise && ackReactionMessageTs) {
      const messageTs = ackReactionMessageTs;
      void ackReactionPromise.then((didAck) => {
        if (!didAck) return;
        removeSlackReaction(message.channel, messageTs, ackReactionValue, {
          token: botToken,
          client: app.client,
        }).catch((err) => {
          logVerbose(
            `slack: failed to remove ack reaction from ${message.channel}/${message.ts}: ${String(err)}`,
          );
        });
      });
    }
    if (isRoomish && historyLimit > 0 && didSendReply) {
      clearHistoryEntries({ historyMap: channelHistories, historyKey });
    }
  };

  app.event(
    "message",
    async ({ event }: SlackEventMiddlewareArgs<"message">) => {
      try {
        const message = event as SlackMessageEvent;
        if (message.subtype === "message_changed") {
          const changed = event as SlackMessageChangedEvent;
          const channelId = changed.channel;
          const channelInfo = channelId
            ? await resolveChannelName(channelId)
            : {};
          const channelType = channelInfo?.type;
          if (
            !isChannelAllowed({
              channelId,
              channelName: channelInfo?.name,
              channelType,
            })
          ) {
            return;
          }
          const messageId = changed.message?.ts ?? changed.previous_message?.ts;
          const label = resolveSlackChannelLabel({
            channelId,
            channelName: channelInfo?.name,
          });
          const sessionKey = resolveSlackSystemEventSessionKey({
            channelId,
            channelType,
          });
          enqueueSystemEvent(`Slack message edited in ${label}.`, {
            sessionKey,
            contextKey: `slack:message:changed:${channelId ?? "unknown"}:${messageId ?? changed.event_ts ?? "unknown"}`,
          });
          return;
        }
        if (message.subtype === "message_deleted") {
          const deleted = event as SlackMessageDeletedEvent;
          const channelId = deleted.channel;
          const channelInfo = channelId
            ? await resolveChannelName(channelId)
            : {};
          const channelType = channelInfo?.type;
          if (
            !isChannelAllowed({
              channelId,
              channelName: channelInfo?.name,
              channelType,
            })
          ) {
            return;
          }
          const label = resolveSlackChannelLabel({
            channelId,
            channelName: channelInfo?.name,
          });
          const sessionKey = resolveSlackSystemEventSessionKey({
            channelId,
            channelType,
          });
          enqueueSystemEvent(`Slack message deleted in ${label}.`, {
            sessionKey,
            contextKey: `slack:message:deleted:${channelId ?? "unknown"}:${deleted.deleted_ts ?? deleted.event_ts ?? "unknown"}`,
          });
          return;
        }
        if (message.subtype === "thread_broadcast") {
          const thread = event as SlackThreadBroadcastEvent;
          const channelId = thread.channel;
          const channelInfo = channelId
            ? await resolveChannelName(channelId)
            : {};
          const channelType = channelInfo?.type;
          if (
            !isChannelAllowed({
              channelId,
              channelName: channelInfo?.name,
              channelType,
            })
          ) {
            return;
          }
          const label = resolveSlackChannelLabel({
            channelId,
            channelName: channelInfo?.name,
          });
          const messageId = thread.message?.ts ?? thread.event_ts;
          const sessionKey = resolveSlackSystemEventSessionKey({
            channelId,
            channelType,
          });
          enqueueSystemEvent(`Slack thread reply broadcast in ${label}.`, {
            sessionKey,
            contextKey: `slack:thread:broadcast:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
          });
          return;
        }
        await handleSlackMessage(message, { source: "message" });
      } catch (err) {
        runtime.error?.(danger(`slack handler failed: ${String(err)}`));
      }
    },
  );

  app.event(
    "app_mention",
    async ({ event }: SlackEventMiddlewareArgs<"app_mention">) => {
      try {
        const mention = event as SlackAppMentionEvent;
        await handleSlackMessage(mention as unknown as SlackMessageEvent, {
          source: "app_mention",
          wasMentioned: true,
        });
      } catch (err) {
        runtime.error?.(danger(`slack mention handler failed: ${String(err)}`));
      }
    },
  );

  const handleReactionEvent = async (
    event: SlackReactionEvent,
    action: "added" | "removed",
  ) => {
    try {
      const item = event.item;
      if (!event.user) return;
      if (!item?.channel || !item?.ts) return;
      if (item.type && item.type !== "message") return;
      if (botUserId && event.user === botUserId) return;

      const channelInfo = await resolveChannelName(item.channel);
      const channelType = channelInfo?.type;
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";
      const channelName = channelInfo?.name;

      if (isDirectMessage && !dmEnabled) return;
      if (isGroupDm && !groupDmEnabled) return;
      if (isGroupDm && groupDmChannels.length > 0) {
        const allowList = normalizeAllowListLower(groupDmChannels);
        const candidates = [
          item.channel,
          channelName ? `#${channelName}` : undefined,
          channelName,
          channelName ? normalizeSlackSlug(channelName) : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase());
        const permitted =
          allowList.includes("*") ||
          candidates.some((candidate) => allowList.includes(candidate));
        if (!permitted) return;
      }

      if (isRoom) {
        const channelConfig = resolveSlackChannelConfig({
          channelId: item.channel,
          channelName,
          channels: channelsConfig,
        });
        if (channelConfig?.allowed === false) return;
      }

      const actor = await resolveUserName(event.user);
      const shouldNotify = shouldEmitSlackReactionNotification({
        mode: reactionMode,
        botId: botUserId,
        messageAuthorId: event.item_user ?? undefined,
        userId: event.user,
        userName: actor?.name ?? undefined,
        allowlist: reactionAllowlist,
      });
      if (!shouldNotify) return;

      const emojiLabel = event.reaction ?? "emoji";
      const actorLabel = actor?.name ?? event.user;
      const channelLabel = channelName
        ? `#${normalizeSlackSlug(channelName) || channelName}`
        : `#${item.channel}`;
      const authorInfo = event.item_user
        ? await resolveUserName(event.item_user)
        : undefined;
      const authorLabel = authorInfo?.name ?? event.item_user;
      const baseText = `Slack reaction ${action}: :${emojiLabel}: by ${actorLabel} in ${channelLabel} msg ${item.ts}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      const sessionKey = resolveSlackSystemEventSessionKey({
        channelId: item.channel,
        channelType,
      });
      enqueueSystemEvent(text, {
        sessionKey,
        contextKey: `slack:reaction:${action}:${item.channel}:${item.ts}:${event.user}:${emojiLabel}`,
      });
    } catch (err) {
      runtime.error?.(danger(`slack reaction handler failed: ${String(err)}`));
    }
  };

  app.event(
    "reaction_added",
    async ({ event }: SlackEventMiddlewareArgs<"reaction_added">) => {
      await handleReactionEvent(event as SlackReactionEvent, "added");
    },
  );

  app.event(
    "reaction_removed",
    async ({ event }: SlackEventMiddlewareArgs<"reaction_removed">) => {
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    },
  );

  app.event(
    "member_joined_channel",
    async ({ event }: SlackEventMiddlewareArgs<"member_joined_channel">) => {
      try {
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId
          ? await resolveChannelName(channelId)
          : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user
          ? await resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} joined ${label}.`, {
          sessionKey,
          contextKey: `slack:member:joined:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });
      } catch (err) {
        runtime.error?.(danger(`slack join handler failed: ${String(err)}`));
      }
    },
  );

  app.event(
    "member_left_channel",
    async ({ event }: SlackEventMiddlewareArgs<"member_left_channel">) => {
      try {
        const payload = event as SlackMemberChannelEvent;
        const channelId = payload.channel;
        const channelInfo = channelId
          ? await resolveChannelName(channelId)
          : {};
        const channelType = payload.channel_type ?? channelInfo?.type;
        if (
          !isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType,
          })
        ) {
          return;
        }
        const userInfo = payload.user
          ? await resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType,
        });
        enqueueSystemEvent(`Slack: ${userLabel} left ${label}.`, {
          sessionKey,
          contextKey: `slack:member:left:${channelId ?? "unknown"}:${payload.user ?? "unknown"}`,
        });
      } catch (err) {
        runtime.error?.(danger(`slack leave handler failed: ${String(err)}`));
      }
    },
  );

  app.event(
    "channel_created",
    async ({ event }: SlackEventMiddlewareArgs<"channel_created">) => {
      try {
        const payload = event as SlackChannelCreatedEvent;
        const channelId = payload.channel?.id;
        const channelName = payload.channel?.name;
        if (
          !isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel created: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:created:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        runtime.error?.(
          danger(`slack channel created handler failed: ${String(err)}`),
        );
      }
    },
  );

  app.event(
    "channel_rename",
    async ({ event }: SlackEventMiddlewareArgs<"channel_rename">) => {
      try {
        const payload = event as SlackChannelRenamedEvent;
        const channelId = payload.channel?.id;
        const channelName =
          payload.channel?.name_normalized ?? payload.channel?.name;
        if (
          !isChannelAllowed({
            channelId,
            channelName,
            channelType: "channel",
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({ channelId, channelName });
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType: "channel",
        });
        enqueueSystemEvent(`Slack channel renamed: ${label}.`, {
          sessionKey,
          contextKey: `slack:channel:renamed:${channelId ?? channelName ?? "unknown"}`,
        });
      } catch (err) {
        runtime.error?.(
          danger(`slack channel rename handler failed: ${String(err)}`),
        );
      }
    },
  );

  app.event(
    "pin_added",
    async ({ event }: SlackEventMiddlewareArgs<"pin_added">) => {
      try {
        const payload = event as SlackPinEvent;
        const channelId = payload.channel_id;
        const channelInfo = channelId
          ? await resolveChannelName(channelId)
          : {};
        if (
          !isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType: channelInfo?.type,
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const userInfo = payload.user
          ? await resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const itemType = payload.item?.type ?? "item";
        const messageId = payload.item?.message?.ts ?? payload.event_ts;
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType: channelInfo?.type ?? undefined,
        });
        enqueueSystemEvent(
          `Slack: ${userLabel} pinned a ${itemType} in ${label}.`,
          {
            sessionKey,
            contextKey: `slack:pin:added:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
          },
        );
      } catch (err) {
        runtime.error?.(
          danger(`slack pin added handler failed: ${String(err)}`),
        );
      }
    },
  );

  app.event(
    "pin_removed",
    async ({ event }: SlackEventMiddlewareArgs<"pin_removed">) => {
      try {
        const payload = event as SlackPinEvent;
        const channelId = payload.channel_id;
        const channelInfo = channelId
          ? await resolveChannelName(channelId)
          : {};
        if (
          !isChannelAllowed({
            channelId,
            channelName: channelInfo?.name,
            channelType: channelInfo?.type,
          })
        ) {
          return;
        }
        const label = resolveSlackChannelLabel({
          channelId,
          channelName: channelInfo?.name,
        });
        const userInfo = payload.user
          ? await resolveUserName(payload.user)
          : {};
        const userLabel = userInfo?.name ?? payload.user ?? "someone";
        const itemType = payload.item?.type ?? "item";
        const messageId = payload.item?.message?.ts ?? payload.event_ts;
        const sessionKey = resolveSlackSystemEventSessionKey({
          channelId,
          channelType: channelInfo?.type ?? undefined,
        });
        enqueueSystemEvent(
          `Slack: ${userLabel} unpinned a ${itemType} in ${label}.`,
          {
            sessionKey,
            contextKey: `slack:pin:removed:${channelId ?? "unknown"}:${messageId ?? "unknown"}`,
          },
        );
      } catch (err) {
        runtime.error?.(
          danger(`slack pin removed handler failed: ${String(err)}`),
        );
      }
    },
  );

  const handleSlashCommand = async (params: {
    command: SlackCommandMiddlewareArgs["command"];
    ack: SlackCommandMiddlewareArgs["ack"];
    respond: SlackCommandMiddlewareArgs["respond"];
    prompt: string;
  }) => {
    const { command, ack, respond, prompt } = params;
    try {
      if (!prompt.trim()) {
        await ack({
          text: "Message required.",
          response_type: "ephemeral",
        });
        return;
      }
      await ack();

      if (botUserId && command.user_id === botUserId) return;

      const channelInfo = await resolveChannelName(command.channel_id);
      const channelType =
        channelInfo?.type ??
        (command.channel_name === "directmessage" ? "im" : undefined);
      const isDirectMessage = channelType === "im";
      const isGroupDm = channelType === "mpim";
      const isRoom = channelType === "channel" || channelType === "group";

      if (isDirectMessage && !dmEnabled) {
        await respond({
          text: "Slack DMs are disabled.",
          response_type: "ephemeral",
        });
        return;
      }
      if (isGroupDm && !groupDmEnabled) {
        await respond({
          text: "Slack group DMs are disabled.",
          response_type: "ephemeral",
        });
        return;
      }
      if (isGroupDm && groupDmChannels.length > 0) {
        const allowList = normalizeAllowListLower(groupDmChannels);
        const channelName = channelInfo?.name;
        const candidates = [
          command.channel_id,
          channelName ? `#${channelName}` : undefined,
          channelName,
          channelName ? normalizeSlackSlug(channelName) : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => value.toLowerCase());
        const permitted =
          allowList.includes("*") ||
          candidates.some((candidate) => allowList.includes(candidate));
        if (!permitted) {
          await respond({
            text: "This group DM is not allowed.",
            response_type: "ephemeral",
          });
          return;
        }
      }

      const storeAllowFrom = await readProviderAllowFromStore("slack").catch(
        () => [],
      );
      const effectiveAllowFrom = normalizeAllowList([
        ...allowFrom,
        ...storeAllowFrom,
      ]);
      const effectiveAllowFromLower =
        normalizeAllowListLower(effectiveAllowFrom);

      let commandAuthorized = true;
      let channelConfig: SlackChannelConfigResolved | null = null;
      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") {
          await respond({
            text: "Slack DMs are disabled.",
            response_type: "ephemeral",
          });
          return;
        }
        if (dmPolicy !== "open") {
          const sender = await resolveUserName(command.user_id);
          const senderName = sender?.name ?? undefined;
          const permitted = allowListMatches({
            allowList: effectiveAllowFromLower,
            id: command.user_id,
            name: senderName,
          });
          if (!permitted) {
            if (dmPolicy === "pairing") {
              const { code, created } = await upsertProviderPairingRequest({
                provider: "slack",
                id: command.user_id,
                meta: { name: senderName },
              });
              if (created) {
                await respond({
                  text: buildPairingReply({
                    provider: "slack",
                    idLine: `Your Slack user id: ${command.user_id}`,
                    code,
                  }),
                  response_type: "ephemeral",
                });
              }
            } else {
              await respond({
                text: "You are not authorized to use this command.",
                response_type: "ephemeral",
              });
            }
            return;
          }
          commandAuthorized = true;
        }
      }

      if (isRoom) {
        channelConfig = resolveSlackChannelConfig({
          channelId: command.channel_id,
          channelName: channelInfo?.name,
          channels: channelsConfig,
        });
        if (
          useAccessGroups &&
          !isSlackRoomAllowedByPolicy({
            groupPolicy,
            channelAllowlistConfigured:
              Boolean(channelsConfig) &&
              Object.keys(channelsConfig ?? {}).length > 0,
            channelAllowed: channelConfig?.allowed !== false,
          })
        ) {
          await respond({
            text: "This channel is not allowed.",
            response_type: "ephemeral",
          });
          return;
        }
        if (useAccessGroups && channelConfig?.allowed === false) {
          await respond({
            text: "This channel is not allowed.",
            response_type: "ephemeral",
          });
          return;
        }
      }

      const sender = await resolveUserName(command.user_id);
      const senderName = sender?.name ?? command.user_name ?? command.user_id;
      const channelUserAllowed = isRoom
        ? resolveSlackUserAllowed({
            allowList: channelConfig?.users,
            userId: command.user_id,
            userName: senderName,
          })
        : true;
      if (isRoom && !channelUserAllowed) {
        await respond({
          text: "You are not authorized to use this command here.",
          response_type: "ephemeral",
        });
        return;
      }
      const channelName = channelInfo?.name;
      const roomLabel = channelName
        ? `#${channelName}`
        : `#${command.channel_id}`;
      const isRoomish = isRoom || isGroupDm;
      const route = resolveAgentRoute({
        cfg,
        provider: "slack",
        accountId: account.accountId,
        teamId: teamId || undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isRoom ? "channel" : "group",
          id: isDirectMessage ? command.user_id : command.channel_id,
        },
      });
      const channelDescription = [channelInfo?.topic, channelInfo?.purpose]
        .map((entry) => entry?.trim())
        .filter((entry): entry is string => Boolean(entry))
        .filter((entry, index, list) => list.indexOf(entry) === index)
        .join("\n");
      const systemPromptParts = [
        channelDescription
          ? `Channel description: ${channelDescription}`
          : null,
        channelConfig?.systemPrompt?.trim() || null,
      ].filter((entry): entry is string => Boolean(entry));
      const groupSystemPrompt =
        systemPromptParts.length > 0
          ? systemPromptParts.join("\n\n")
          : undefined;

      const ctxPayload = {
        Body: prompt,
        From: isDirectMessage
          ? `slack:${command.user_id}`
          : isRoom
            ? `slack:channel:${command.channel_id}`
            : `slack:group:${command.channel_id}`,
        To: `slash:${command.user_id}`,
        ChatType: isDirectMessage ? "direct" : isRoom ? "room" : "group",
        GroupSubject: isRoomish ? roomLabel : undefined,
        GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
        SenderName: senderName,
        SenderId: command.user_id,
        Provider: "slack" as const,
        Surface: "slack" as const,
        WasMentioned: true,
        MessageSid: command.trigger_id,
        Timestamp: Date.now(),
        SessionKey: `agent:${route.agentId}:${slashCommand.sessionPrefix}:${command.user_id}`,
        CommandTargetSessionKey: route.sessionKey,
        AccountId: route.accountId,
        CommandSource: "native" as const,
        CommandAuthorized: commandAuthorized,
        // Originating channel for reply routing.
        OriginatingChannel: "slack" as const,
        OriginatingTo: `user:${command.user_id}`,
      };

      const replyResult = await getReplyFromConfig(
        ctxPayload,
        { skillFilter: channelConfig?.skills },
        cfg,
      );
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];

      await deliverSlackSlashReplies({
        replies,
        respond,
        ephemeral: slashCommand.ephemeral,
        textLimit,
      });
    } catch (err) {
      runtime.error?.(danger(`slack slash handler failed: ${String(err)}`));
      await respond({
        text: "Sorry, something went wrong handling that command.",
        response_type: "ephemeral",
      });
    }
  };

  const nativeCommands =
    cfg.commands?.native === true ? listNativeCommandSpecs() : [];
  if (nativeCommands.length > 0) {
    for (const command of nativeCommands) {
      app.command(
        `/${command.name}`,
        async ({ command: cmd, ack, respond }: SlackCommandMiddlewareArgs) => {
          const prompt = buildCommandText(command.name, cmd.text);
          await handleSlashCommand({ command: cmd, ack, respond, prompt });
        },
      );
    }
  } else if (slashCommand.enabled) {
    app.command(
      slashCommand.name,
      async ({ command, ack, respond }: SlackCommandMiddlewareArgs) => {
        await handleSlashCommand({
          command,
          ack,
          respond,
          prompt: command.text?.trim() ?? "",
        });
      },
    );
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) void app.stop();
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    await app.start();
    runtime.log?.("slack socket mode connected");
    if (opts.abortSignal?.aborted) return;
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    await app.stop().catch(() => undefined);
  }
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
}) {
  const chunkLimit = Math.min(params.textLimit, 4000);
  for (const payload of params.replies) {
    const threadTs = payload.replyToId ?? params.replyThreadTs;
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;

    if (mediaList.length === 0) {
      for (const chunk of chunkMarkdownText(text, chunkLimit)) {
        const trimmed = chunk.trim();
        if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN))
          continue;
        await sendMessageSlack(params.target, trimmed, {
          token: params.token,
          threadTs,
          accountId: params.accountId,
        });
      }
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSlack(params.target, caption, {
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
        });
      }
    }
    params.runtime.log?.(`delivered reply to ${params.target}`);
  }
}

type SlackRespondFn = (payload: {
  text: string;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

export function isSlackRoomAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  const { groupPolicy, channelAllowlistConfigured, channelAllowed } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!channelAllowlistConfigured) return false;
  return channelAllowed;
}

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
}): string | undefined {
  const { replyToMode, incomingThreadTs, messageTs, hasReplied } = params;
  if (incomingThreadTs) return incomingThreadTs;
  if (!messageTs) return undefined;
  if (replyToMode === "all") {
    // All replies go to thread
    return messageTs;
  }
  if (replyToMode === "first") {
    // "first": only first reply goes to thread
    return hasReplied ? undefined : messageTs;
  }
  // "off": never start a thread
  return undefined;
}

async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
}) {
  const messages: string[] = [];
  const chunkLimit = Math.min(params.textLimit, 4000);
  for (const payload of params.replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text =
      textRaw && !isSilentReplyText(textRaw, SILENT_REPLY_TOKEN)
        ? textRaw
        : undefined;
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [
      text ?? "",
      ...mediaList.map((url) => url.trim()).filter(Boolean),
    ]
      .filter(Boolean)
      .join("\n");
    if (!combined) continue;
    for (const chunk of chunkMarkdownText(combined, chunkLimit)) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    await params.respond({
      text: "No response was generated for that command.",
      response_type: "ephemeral",
    });
    return;
  }

  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const message of messages) {
    await params.respond({ text: message, response_type: responseType });
  }
}
