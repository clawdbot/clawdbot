import type { App } from "@slack/bolt";
import type { HistoryEntry } from "../../auto-reply/reply/history.js";
import type { MoltbotConfig, SlackReactionNotificationMode } from "../../config/config.js";
import { resolveSessionKey, type SessionScope } from "../../config/sessions.js";
import type { DmPolicy, GroupPolicy } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { getChildLogger } from "../../logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { SlackMessageEvent } from "../types.js";
import { formatAllowlistMatchMeta } from "../../channels/allowlist-match.js";

import { normalizeAllowList, normalizeAllowListLower, normalizeSlackSlug } from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";

export function inferSlackChannelType(
  channelId?: string | null,
): SlackMessageEvent["channel_type"] | undefined {
  const trimmed = channelId?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("D")) return "im";
  if (trimmed.startsWith("C")) return "channel";
  if (trimmed.startsWith("G")) return "group";
  return undefined;
}

export function normalizeSlackChannelType(
  channelType?: string | null,
  channelId?: string | null,
): SlackMessageEvent["channel_type"] {
  const normalized = channelType?.trim().toLowerCase();
  if (
    normalized === "im" ||
    normalized === "mpim" ||
    normalized === "channel" ||
    normalized === "group"
  ) {
    return normalized;
  }
  return inferSlackChannelType(channelId) ?? "channel";
}

export type SlackMonitorContext = {
  cfg: MoltbotConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;

  botUserId: string;
  teamId: string;
  apiAppId: string;

  historyLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  defaultRequireMention: boolean;
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
  threadHistoryScope: "thread" | "channel";
  threadInheritParent: boolean;
  slashCommand: Required<import("../../config/config.js").SlackSlashCommandConfig>;
  textLimit: number;
  ackReactionScope: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;

  logger: ReturnType<typeof getChildLogger>;
  markMessageSeen: (channelId: string | undefined, ts?: string) => boolean;
  shouldDropMismatchedSlackEvent: (body: unknown) => boolean;
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
  cfg: MoltbotConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;

  botUserId: string;
  teamId: string;
  apiAppId: string;

  historyLimit: number;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: Array<string | number> | undefined;
  groupDmEnabled: boolean;
  groupDmChannels: Array<string | number> | undefined;
  defaultRequireMention?: boolean;
  channelsConfig?: SlackMonitorContext["channelsConfig"];
  groupPolicy: SlackMonitorContext["groupPolicy"];
  useAccessGroups: boolean;
  reactionMode: SlackReactionNotificationMode;
  reactionAllowlist: Array<string | number>;
  replyToMode: SlackMonitorContext["replyToMode"];
  threadHistoryScope: SlackMonitorContext["threadHistoryScope"];
  threadInheritParent: SlackMonitorContext["threadInheritParent"];
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
  const defaultRequireMention = params.defaultRequireMention ?? true;

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
    const channelType = normalizeSlackChannelType(p.channelType, channelId);
    const isDirectMessage = channelType === "im";
    const isGroup = channelType === "mpim";
    const from = isDirectMessage
      ? `slack:${channelId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:channel:${channelId}`;
    const chatType = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
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
      const name = info.channel && "name" in info.channel ? info.channel.name : undefined;
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
      const topic = channel && "topic" in channel ? (channel.topic?.value ?? undefined) : undefined;
      const purpose =
        channel && "purpose" in channel ? (channel.purpose?.value ?? undefined) : undefined;
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
      const name = profile?.display_name || profile?.real_name || info.user?.name || undefined;
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
      logVerbose(`slack status update failed for channel ${p.channelId}: ${String(err)}`);
    }
  };

  const isChannelAllowed = (p: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => {
    const channelType = normalizeSlackChannelType(p.channelType, p.channelId);
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
        allowList.includes("*") || candidates.some((candidate) => allowList.includes(candidate));
      if (!permitted) return false;
    }

    if (isRoom && p.channelId) {
      const channelConfig = resolveSlackChannelConfig({
        channelId: p.channelId,
        channelName: p.channelName,
        channels: params.channelsConfig,
        defaultRequireMention,
      });
      const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
      const channelAllowed = channelConfig?.allowed !== false;
      const channelAllowlistConfigured =
        Boolean(params.channelsConfig) && Object.keys(params.channelsConfig ?? {}).length > 0;
      if (
        !isSlackChannelAllowedByPolicy({
          groupPolicy: params.groupPolicy,
          channelAllowlistConfigured,
          channelAllowed,
        })
      ) {
        logVerbose(
          `slack: drop channel ${p.channelId} (groupPolicy=${params.groupPolicy}, ${channelMatchMeta})`,
        );
        return false;
      }
      // When groupPolicy is "open", only block channels that are EXPLICITLY denied
      // (i.e., have a matching config entry with allow:false). Channels not in the
      // config (matchSource undefined) should be allowed under open policy.
      const hasExplicitConfig = Boolean(channelConfig?.matchSource);
      if (!channelAllowed && (params.groupPolicy !== "open" || hasExplicitConfig)) {
        logVerbose(`slack: drop channel ${p.channelId} (${channelMatchMeta})`);
        return false;
      }
      logVerbose(`slack: allow channel ${p.channelId} (${channelMatchMeta})`);
    }

    return true;
  };

  const shouldDropMismatchedSlackEvent = (body: unknown) => {
    if (!body || typeof body !== "object") return false;
    const raw = body as { api_app_id?: unknown; team_id?: unknown };
    const incomingApiAppId = typeof raw.api_app_id === "string" ? raw.api_app_id : "";
    const incomingTeamId = typeof raw.team_id === "string" ? raw.team_id : "";

    if (params.apiAppId && incomingApiAppId && incomingApiAppId !== params.apiAppId) {
      logVerbose(
        `slack: drop event with api_app_id=${incomingApiAppId} (expected ${params.apiAppId})`,
      );
      return true;
    }
    if (params.teamId && incomingTeamId && incomingTeamId !== params.teamId) {
      logVerbose(`slack: drop event with team_id=${incomingTeamId} (expected ${params.teamId})`);
      return true;
    }
    return false;
  };

  return {
    cfg: params.cfg,
    accountId: params.accountId,
    botToken: params.botToken,
    app: params.app,
    runtime: params.runtime,
    botUserId: params.botUserId,
    teamId: params.teamId,
    apiAppId: params.apiAppId,
    historyLimit: params.historyLimit,
    channelHistories,
    sessionScope: params.sessionScope,
    mainKey: params.mainKey,
    dmEnabled: params.dmEnabled,
    dmPolicy: params.dmPolicy,
    allowFrom,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels,
    defaultRequireMention,
    channelsConfig: params.channelsConfig,
    groupPolicy: params.groupPolicy,
    useAccessGroups: params.useAccessGroups,
    reactionMode: params.reactionMode,
    reactionAllowlist: params.reactionAllowlist,
    replyToMode: params.replyToMode,
    threadHistoryScope: params.threadHistoryScope,
    threadInheritParent: params.threadInheritParent,
    slashCommand: params.slashCommand,
    textLimit: params.textLimit,
    ackReactionScope: params.ackReactionScope,
    mediaMaxBytes: params.mediaMaxBytes,
    removeAckAfterReply: params.removeAckAfterReply,
    logger,
    markMessageSeen,
    shouldDropMismatchedSlackEvent,
    resolveSlackSystemEventSessionKey,
    isChannelAllowed,
    resolveChannelName,
    resolveUserName,
    setSlackThreadStatus,
  };
}
