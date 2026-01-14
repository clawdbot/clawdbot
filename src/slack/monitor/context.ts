import type { App } from "@slack/bolt";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type {
  ClawdbotConfig,
  SlackReactionNotificationMode,
} from "../../config/config.js";
import { resolveSessionKey, type SessionScope } from "../../config/sessions.js";
import type { DmPolicy, GroupPolicy } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { getChildLogger } from "../../logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { SlackMessageEvent } from "../types.js";

import {
  normalizeAllowList,
  normalizeAllowListLower,
  normalizeSlackSlug,
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { isSlackRoomAllowedByPolicy } from "./policy.js";

export type SlackMonitorContext = {
  cfg: ClawdbotConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;

  botUserId: string;
  teamId: string;

  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  channelsConfig?: Record<
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
  groupPolicy: GroupPolicy;
  useAccessGroups: boolean;
  reactionMode: SlackReactionNotificationMode;
  reactionAllowlist: Array<string | number>;
  replyToMode: "off" | "first" | "all";
  slashCommand: Required<
    import("../../config/config.js").SlackSlashCommandConfig
  >;
  textLimit: number;
  ackReactionScope: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;

  logger: ReturnType<typeof getChildLogger>;
  markMessageSeen: (channelId: string | undefined, ts?: string) => boolean;
  resolveSlackSystemEventSessionKey: (params: {
    channelId?: string | null;
    channelType?: string | null;
  }) => string;
  isChannelAllowed: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => boolean;
  resolveChannelName: (channelId: string) => Promise<{
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  }>;
  resolveUserName: (userId: string) => Promise<{ name?: string }>;
  setSlackThreadStatus: (params: {
    channelId: string;
    threadTs?: string;
    status: string;
  }) => Promise<void>;
};

export function createSlackMonitorContext(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;

  botUserId: string;
  teamId: string;

  historyLimit: number;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: Array<string | number> | undefined;
  groupDmEnabled: boolean;
  groupDmChannels: Array<string | number> | undefined;
  channelsConfig?: SlackMonitorContext["channelsConfig"];
  groupPolicy: SlackMonitorContext["groupPolicy"];
  useAccessGroups: boolean;
  reactionMode: SlackReactionNotificationMode;
  reactionAllowlist: Array<string | number>;
  replyToMode: SlackMonitorContext["replyToMode"];
  slashCommand: SlackMonitorContext["slashCommand"];
  textLimit: number;
  ackReactionScope: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;
}): SlackMonitorContext {
  const channelHistories = new Map<string, HistoryEntry[]>();
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
  const seenMessages = createDedupeCache({ ttlMs: 60_000, maxSize: 500 });

  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupDmChannels = normalizeAllowList(params.groupDmChannels);

  const markMessageSeen = (channelId: string | undefined, ts?: string) => {
    if (!channelId || !ts) return false;
    return seenMessages.check(`${channelId}:${ts}`);
  };

  const resolveSlackSystemEventSessionKey = (p: {
    channelId?: string | null;
    channelType?: string | null;
  }) => {
    const channelId = p.channelId?.trim() ?? "";
    if (!channelId) return params.mainKey;
    const channelType = p.channelType?.trim().toLowerCase() ?? "";
    const isRoom = channelType === "channel" || channelType === "group";
    const isGroup = channelType === "mpim";
    const from = isRoom
      ? `slack:channel:${channelId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:${channelId}`;
    const chatType = isRoom ? "room" : isGroup ? "group" : "direct";
    return resolveSessionKey(
      params.sessionScope,
      { From: from, ChatType: chatType, Provider: "slack" },
      params.mainKey,
    );
  };

  const resolveChannelName = async (channelId: string) => {
    const cached = channelCache.get(channelId);
    if (cached) return cached;
    try {
      const info = await params.app.client.conversations.info({
        token: params.botToken,
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
      const info = await params.app.client.users.info({
        token: params.botToken,
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

  const setSlackThreadStatus = async (p: {
    channelId: string;
    threadTs?: string;
    status: string;
  }) => {
    if (!p.threadTs) return;
    const payload = {
      token: params.botToken,
      channel_id: p.channelId,
      thread_ts: p.threadTs,
      status: p.status,
    };
    const client = params.app.client as unknown as {
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
        `slack status update failed for channel ${p.channelId}: ${String(err)}`,
      );
    }
  };

  const isChannelAllowed = (p: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => {
    const channelType = p.channelType;
    const isDirectMessage = channelType === "im";
    const isGroupDm = channelType === "mpim";
    const isRoom = channelType === "channel" || channelType === "group";

    if (isDirectMessage && !params.dmEnabled) return false;
    if (isGroupDm && !params.groupDmEnabled) return false;

    if (isGroupDm && groupDmChannels.length > 0) {
      const allowList = normalizeAllowListLower(groupDmChannels);
      const candidates = [
        p.channelId,
        p.channelName ? `#${p.channelName}` : undefined,
        p.channelName,
        p.channelName ? normalizeSlackSlug(p.channelName) : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase());
      const permitted =
        allowList.includes("*") ||
        candidates.some((candidate) => allowList.includes(candidate));
      if (!permitted) return false;
    }

    if (isRoom && p.channelId) {
      const channelConfig = resolveSlackChannelConfig({
        channelId: p.channelId,
        channelName: p.channelName,
        channels: params.channelsConfig,
      });
      const channelAllowed = channelConfig?.allowed !== false;
      const channelAllowlistConfigured =
        Boolean(params.channelsConfig) &&
        Object.keys(params.channelsConfig ?? {}).length > 0;
      if (
        !isSlackRoomAllowedByPolicy({
          groupPolicy: params.groupPolicy,
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

  return {
    cfg: params.cfg,
    accountId: params.accountId,
    botToken: params.botToken,
    app: params.app,
    runtime: params.runtime,
    botUserId: params.botUserId,
    teamId: params.teamId,
    historyLimit: params.historyLimit,
    channelHistories,
    sessionScope: params.sessionScope,
    mainKey: params.mainKey,
    dmEnabled: params.dmEnabled,
    dmPolicy: params.dmPolicy,
    allowFrom,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels,
    channelsConfig: params.channelsConfig,
    groupPolicy: params.groupPolicy,
    useAccessGroups: params.useAccessGroups,
    reactionMode: params.reactionMode,
    reactionAllowlist: params.reactionAllowlist,
    replyToMode: params.replyToMode,
    slashCommand: params.slashCommand,
    textLimit: params.textLimit,
    ackReactionScope: params.ackReactionScope,
    mediaMaxBytes: params.mediaMaxBytes,
    removeAckAfterReply: params.removeAckAfterReply,
    logger,
    markMessageSeen,
    resolveSlackSystemEventSessionKey,
    isChannelAllowed,
    resolveChannelName,
    resolveUserName,
    setSlackThreadStatus,
  };
}
