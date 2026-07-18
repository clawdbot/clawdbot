// Slack plugin module implements context behavior.
import type { App } from "@slack/bolt";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type {
  OpenClawConfig,
  SlackReactionNotificationMode,
} from "openclaw/plugin-sdk/config-contracts";
import type { SessionScope } from "openclaw/plugin-sdk/config-contracts";
import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk/config-contracts";
import { resolveRuntimeConversationBindingRoute } from "openclaw/plugin-sdk/conversation-runtime";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import type { SlackMessageEvent } from "../types.js";
import { normalizeAllowList, normalizeAllowListLower, normalizeSlackSlug } from "./allow-list.js";
import type { SlackChannelConfigEntries } from "./channel-config.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import { resolveSessionKey } from "./config.runtime.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";
import type { SlackEventScope } from "./event-scope.js";
import { readLruMapEntry, writeLruMapEntry } from "./lru-map-cache.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";

export { normalizeSlackChannelType, resolveSlackChatType } from "./channel-type.js";

export type SlackAssistantSuggestedPrompt = {
  title: string;
  message: string;
};

export type SlackAssistantThreadContext = {
  assistantChannelId: string;
  threadTs: string;
  userId?: string;
  channelId?: string;
  teamId?: string;
  enterpriseId?: string | null;
  updatedAt: number;
};

type SlackChannelInfo = {
  name?: string;
  type?: SlackMessageEvent["channel_type"];
  topic?: string;
  purpose?: string;
};

type SlackChannelCacheEntry = {
  info: SlackChannelInfo;
  metadataLoaded: boolean;
};

const SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT = "assistant_thread_context";
const SLACK_CHANNEL_CACHE_MAX_ENTRIES = 1024;
const SLACK_USER_CACHE_MAX_ENTRIES = 2048;
const SLACK_CHANNEL_DENIAL_WARNING_TTL_MS = 5 * 60_000;
const SLACK_CHANNEL_DENIAL_WARNING_MAX_ENTRIES = 1024;

export function buildSlackAssistantThreadMetadata(
  context: Omit<SlackAssistantThreadContext, "updatedAt">,
) {
  const eventPayload: Record<string, string> = {};
  if (context.channelId) {
    eventPayload.channel_id = context.channelId;
  }
  if (context.teamId) {
    eventPayload.team_id = context.teamId;
  }
  if (context.enterpriseId) {
    eventPayload.enterprise_id = context.enterpriseId;
  }
  return {
    event_type: SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT,
    event_payload: eventPayload,
  };
}

export function parseSlackAssistantThreadMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.event_type !== SLACK_ASSISTANT_THREAD_CONTEXT_METADATA_EVENT) {
    return undefined;
  }
  const payload = metadata.event_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const stringField = (key: string) => {
    const raw = record[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  return {
    channelId: stringField("channel_id"),
    teamId: stringField("team_id"),
    enterpriseId: stringField("enterprise_id"),
  };
}

export type SlackMonitorContext = {
  cfg: OpenClawConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;

  botUserId: string;
  botId?: string;
  teamId: string;
  apiAppId: string;
  installationIdentity: SlackInstallationIdentity;

  historyLimit: number;
  dmHistoryLimit: number;
  channelHistories: Map<string, HistoryEntry[]>;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  allowNameMatching: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  defaultRequireMention: boolean;
  channelsConfig?: SlackChannelConfigEntries;
  channelsConfigKeys: string[];
  groupPolicy: GroupPolicy;
  useAccessGroups: boolean;
  reactionMode: SlackReactionNotificationMode;
  reactionAllowlist: Array<string | number>;
  replyToMode: "off" | "first" | "all" | "batched";
  threadHistoryScope: "thread" | "channel";
  threadInheritParent: boolean;
  slashCommand: Required<import("openclaw/plugin-sdk/config-contracts").SlackSlashCommandConfig>;
  textLimit: number;
  ackReactionScope: string;
  typingReaction: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;

  logger: ReturnType<typeof getChildLogger>;
  shouldDropMismatchedSlackEvent: (body: unknown) => boolean;
  resolveSlackSystemEventSessionKey: (params: {
    channelId?: string | null;
    channelType?: string | null;
    senderId?: string | null;
    threadTs?: string | null;
  }) => string;
  isChannelAllowed: (params: {
    channelId?: string;
    channelName?: string;
    channelType?: SlackMessageEvent["channel_type"];
  }) => boolean;
  resolveChannelName: (
    channelId: string,
    eventScope?: SlackEventScope,
  ) => Promise<SlackChannelInfo>;
  /** Records authoritative event-carried channel type in the channel metadata cache. */
  rememberSlackChannelType: (
    channelId: string | null | undefined,
    channelType: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => void;
  /** Reads event-carried channel type when Slack omits it from later bot/edit/delete events. */
  recallSlackChannelType: (
    channelId: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => SlackMessageEvent["channel_type"] | undefined;
  resolveUserName: (userId: string, eventScope?: SlackEventScope) => Promise<{ name?: string }>;
  setSlackThreadStatus: (params: {
    channelId: string;
    threadTs?: string;
    status: string;
    loadingMessages?: string[];
    eventScope?: SlackEventScope;
  }) => Promise<void>;
  getSlackAssistantThreadContext: (
    channelId: string | undefined,
    threadTs: string | undefined,
    eventScope?: SlackEventScope,
  ) => SlackAssistantThreadContext | undefined;
  saveSlackAssistantThreadContext: (
    context: Omit<SlackAssistantThreadContext, "updatedAt">,
    eventScope?: SlackEventScope,
  ) => void;
  setSlackAssistantSuggestedPrompts: (params: {
    channelId: string;
    threadTs: string;
    title?: string;
    prompts: SlackAssistantSuggestedPrompt[];
  }) => Promise<boolean>;
};

const SLACK_ASSISTANT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const SLACK_ASSISTANT_CONTEXT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export function createSlackMonitorContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;

  botUserId: string;
  botId?: string;
  teamId: string;
  apiAppId: string;
  installationIdentity?: SlackInstallationIdentity;

  historyLimit: number;
  dmHistoryLimit?: number;
  sessionScope: SessionScope;
  mainKey: string;

  dmEnabled: boolean;
  dmPolicy: DmPolicy;
  allowFrom: Array<string | number> | undefined;
  allowNameMatching: boolean;
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
  typingReaction: string;
  mediaMaxBytes: number;
  removeAckAfterReply: boolean;
}): SlackMonitorContext {
  const channelHistories = new Map<string, HistoryEntry[]>();
  const logger = getChildLogger({ module: "slack-auto-reply" });

  const channelCache = new Map<string, SlackChannelCacheEntry>();
  const userCache = new Map<string, { name?: string }>();
  // Rate-limit active denials while retaining periodic evidence; bound keys against config churn.
  const channelDenialWarnings = createDedupeCache({
    ttlMs: SLACK_CHANNEL_DENIAL_WARNING_TTL_MS,
    maxSize: SLACK_CHANNEL_DENIAL_WARNING_MAX_ENTRIES,
  });
  const assistantThreadContexts = new Map<string, SlackAssistantThreadContext>();
  let lastAssistantContextCleanupAt = Date.now();

  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupDmChannels = normalizeAllowList(params.groupDmChannels);
  const groupDmChannelsLower = new Set(
    normalizeAllowListLower(groupDmChannels).map((entry) => entry.replace(/^channel:/, "")),
  );
  const defaultRequireMention = params.defaultRequireMention ?? true;
  const hasChannelAllowlistConfig = Object.keys(params.channelsConfig ?? {}).length > 0;
  const channelsConfigKeys = Object.keys(params.channelsConfig ?? {});

  const scopedKey = (key: string, eventScope?: SlackEventScope) =>
    eventScope ? `${params.accountId}:${eventScope.teamId}:${key}` : key;

  const rememberSlackChannelType = (
    channelId: string | null | undefined,
    channelType: string | null | undefined,
    eventScope?: SlackEventScope,
  ) => {
    const id = normalizeOptionalString(channelId);
    const normalizedType = normalizeOptionalString(channelType)?.toLowerCase();
    if (
      !id ||
      (normalizedType !== "im" &&
        normalizedType !== "mpim" &&
        normalizedType !== "channel" &&
        normalizedType !== "group")
    ) {
      return;
    }
    const cacheKey = scopedKey(id, eventScope);
    const cached = readLruMapEntry(channelCache, cacheKey);
    const type = normalizeSlackChannelType(normalizedType, id);
    if (cached?.info.type === type) {
      return;
    }
    // Type-only entries must not suppress a later conversations.info metadata fill.
    writeLruMapEntry(
      channelCache,
      cacheKey,
      {
        info: { ...cached?.info, type },
        metadataLoaded: cached?.metadataLoaded ?? false,
      },
      SLACK_CHANNEL_CACHE_MAX_ENTRIES,
    );
  };

  const recallSlackChannelType = (
    channelId: string | null | undefined,
    eventScope?: SlackEventScope,
  ): SlackMessageEvent["channel_type"] | undefined => {
    const id = normalizeOptionalString(channelId);
    return id ? readLruMapEntry(channelCache, scopedKey(id, eventScope))?.info.type : undefined;
  };

  const assistantContextKey = (channelId: string, threadTs: string, eventScope?: SlackEventScope) =>
    scopedKey(`${channelId}:${threadTs}`, eventScope);

  const cleanupAssistantThreadContexts = () => {
    const now = Date.now();
    if (now - lastAssistantContextCleanupAt < SLACK_ASSISTANT_CONTEXT_CLEANUP_INTERVAL_MS) {
      return;
    }
    lastAssistantContextCleanupAt = now;
    const cutoff = now - SLACK_ASSISTANT_CONTEXT_TTL_MS;
    for (const [key, entry] of assistantThreadContexts) {
      if (entry.updatedAt < cutoff) {
        assistantThreadContexts.delete(key);
      }
    }
  };

  const getSlackAssistantThreadContext = (
    channelId: string | undefined,
    threadTs: string | undefined,
    eventScope?: SlackEventScope,
  ) => {
    if (!channelId || !threadTs) {
      return undefined;
    }
    const key = assistantContextKey(channelId, threadTs, eventScope);
    const entry = assistantThreadContexts.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() - entry.updatedAt > SLACK_ASSISTANT_CONTEXT_TTL_MS) {
      assistantThreadContexts.delete(key);
      return undefined;
    }
    return entry;
  };

  const saveSlackAssistantThreadContext = (
    context: Omit<SlackAssistantThreadContext, "updatedAt">,
    eventScope?: SlackEventScope,
  ) => {
    cleanupAssistantThreadContexts();
    assistantThreadContexts.set(
      assistantContextKey(context.assistantChannelId, context.threadTs, eventScope),
      {
        ...context,
        updatedAt: Date.now(),
      },
    );
  };

  const resolveSlackSystemEventSessionKey = (p: {
    channelId?: string | null;
    channelType?: string | null;
    senderId?: string | null;
    threadTs?: string | null;
  }) => {
    const channelId = normalizeOptionalString(p.channelId) ?? "";
    const senderId = normalizeOptionalString(p.senderId) ?? "";
    // System events can omit channel_type too; prefer a type already seen on events
    // for this channel over C-prefix inference so they key the same session (#102676).
    const channelType = normalizeSlackChannelType(
      p.channelType ?? recallSlackChannelType(channelId),
      channelId,
    );
    const isDirectMessage = channelType === "im";
    if (!channelId && (!isDirectMessage || !senderId)) {
      return params.mainKey;
    }
    const isGroup = channelType === "mpim";
    const from = isDirectMessage
      ? `slack:${channelId || senderId}`
      : isGroup
        ? `slack:group:${channelId}`
        : `slack:channel:${channelId}`;
    const chatType = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
    // Resolve through shared channel/account bindings so system events route to
    // the same agent session as regular inbound messages.
    try {
      const peerKind = isDirectMessage ? "direct" : isGroup ? "group" : "channel";
      const peerId = isDirectMessage ? senderId : channelId;
      if (peerId) {
        const route = resolveAgentRoute({
          cfg: params.cfg,
          channel: "slack",
          accountId: params.accountId,
          teamId: params.teamId,
          peer: { kind: peerKind, id: peerId },
        });
        const threadTs = normalizeOptionalString(p.threadTs);
        const baseConversationId = isDirectMessage ? `user:${senderId}` : channelId;
        const threadBindingRoute = threadTs
          ? resolveRuntimeConversationBindingRoute({
              route,
              conversation: {
                channel: "slack",
                accountId: params.accountId,
                conversationId: threadTs,
                parentConversationId: baseConversationId,
              },
            })
          : null;
        const runtimeRoute =
          threadBindingRoute?.boundSessionKey || threadBindingRoute?.bindingRecord
            ? threadBindingRoute
            : resolveRuntimeConversationBindingRoute({
                route,
                conversation: {
                  channel: "slack",
                  accountId: params.accountId,
                  conversationId: baseConversationId,
                },
              });
        if (runtimeRoute.boundSessionKey) {
          return runtimeRoute.route.sessionKey;
        }
        return resolveThreadSessionKeys({
          baseSessionKey: runtimeRoute.route.sessionKey,
          threadId: threadTs,
          parentSessionKey:
            threadTs && params.threadInheritParent ? runtimeRoute.route.sessionKey : undefined,
        }).sessionKey;
      }
    } catch {
      // Fall through to legacy key derivation.
    }

    const legacySessionKey = resolveSessionKey(
      params.sessionScope,
      { From: from, ChatType: chatType, Provider: "slack" },
      params.mainKey,
      resolveDefaultAgentId(params.cfg),
    );
    return resolveThreadSessionKeys({
      baseSessionKey: legacySessionKey,
      threadId: normalizeOptionalString(p.threadTs),
      parentSessionKey:
        normalizeOptionalString(p.threadTs) && params.threadInheritParent
          ? legacySessionKey
          : undefined,
    }).sessionKey;
  };

  const resolveChannelName = async (channelId: string, eventScope?: SlackEventScope) => {
    const cacheKey = scopedKey(channelId, eventScope);
    const cached = readLruMapEntry(channelCache, cacheKey);
    if (cached?.metadataLoaded) {
      return cached.info;
    }
    try {
      const info = await (eventScope?.client ?? params.app.client).conversations.info({
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
      const entry: SlackChannelCacheEntry = {
        // An event-carried type is authoritative and may be the only mpDM signal
        // available to later bot, edit, and delete events with restricted scopes.
        info: { name, type: cached?.info.type ?? type, topic, purpose },
        metadataLoaded: true,
      };
      writeLruMapEntry(channelCache, cacheKey, entry, SLACK_CHANNEL_CACHE_MAX_ENTRIES);
      return entry.info;
    } catch {
      return cached?.info ?? {};
    }
  };

  const resolveUserName = async (userId: string, eventScope?: SlackEventScope) => {
    const cacheKey = scopedKey(userId, eventScope);
    const cached = readLruMapEntry(userCache, cacheKey);
    if (cached) {
      return cached;
    }
    try {
      const info = await (eventScope?.client ?? params.app.client).users.info({
        token: params.botToken,
        user: userId,
      });
      const profile = info.user?.profile;
      const name = profile?.display_name || profile?.real_name || info.user?.name || undefined;
      const entry = { name };
      writeLruMapEntry(userCache, cacheKey, entry, SLACK_USER_CACHE_MAX_ENTRIES);
      return entry;
    } catch {
      return {};
    }
  };

  const setSlackThreadStatus = async (p: {
    channelId: string;
    threadTs?: string;
    status: string;
    loadingMessages?: string[];
    eventScope?: SlackEventScope;
  }) => {
    if (!p.threadTs) {
      return;
    }
    try {
      await (p.eventScope?.client ?? params.app.client).assistant.threads.setStatus({
        token: params.botToken,
        channel_id: p.channelId,
        thread_ts: p.threadTs,
        status: p.status,
        ...(p.loadingMessages?.length ? { loading_messages: p.loadingMessages.slice(0, 10) } : {}),
      });
    } catch (err) {
      logVerbose(`slack status update failed for channel ${p.channelId}: ${formatSlackError(err)}`);
    }
  };

  const setSlackAssistantSuggestedPrompts = async (p: {
    channelId: string;
    threadTs: string;
    title?: string;
    prompts: SlackAssistantSuggestedPrompt[];
  }) => {
    const prompts = p.prompts
      .map((prompt) => ({
        title: prompt.title.trim(),
        message: prompt.message.trim(),
      }))
      .filter((prompt) => prompt.title && prompt.message)
      .slice(0, 4);
    if (prompts.length === 0) {
      return false;
    }
    try {
      await params.app.client.assistant.threads.setSuggestedPrompts({
        token: params.botToken,
        channel_id: p.channelId,
        thread_ts: p.threadTs,
        ...(p.title?.trim() ? { title: p.title.trim() } : {}),
        prompts,
      });
      return true;
    } catch (err) {
      logVerbose(
        `slack suggested prompts update failed for channel ${p.channelId}: ${formatSlackError(err)}`,
      );
      return false;
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

    if (isDirectMessage && !params.dmEnabled) {
      return false;
    }
    if (isGroupDm && !params.groupDmEnabled) {
      return false;
    }

    if (isGroupDm && groupDmChannels.length > 0) {
      const candidates = [
        p.channelId,
        p.channelName ? `#${p.channelName}` : undefined,
        p.channelName,
        p.channelName ? normalizeSlackSlug(p.channelName) : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeLowercaseStringOrEmpty(value));
      const permitted =
        groupDmChannelsLower.has("*") ||
        candidates.some((candidate) => groupDmChannelsLower.has(candidate));
      if (!permitted) {
        return false;
      }
    }

    if (isRoom && p.channelId) {
      const channelConfig = resolveSlackChannelConfig({
        channelId: p.channelId,
        channelName: p.channelName,
        channels: params.channelsConfig,
        channelKeys: channelsConfigKeys,
        defaultRequireMention,
        allowNameMatching: params.allowNameMatching,
      });
      const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
      const channelAllowed = channelConfig?.allowed !== false;
      const channelAllowlistConfigured = hasChannelAllowlistConfig;
      const allowedByPolicy = isSlackChannelAllowedByPolicy({
        groupPolicy: params.groupPolicy,
        channelAllowlistConfigured,
        channelAllowed,
      });
      const explicitlyDisabled =
        params.groupPolicy !== "disabled" &&
        channelConfig?.allowed === false &&
        channelConfig.matchSource !== undefined;
      // Open policy still honors an explicit room disable; unlisted rooms remain open.
      const shouldDrop = !allowedByPolicy || (params.groupPolicy === "open" && explicitlyDisabled);
      if (shouldDrop) {
        if (explicitlyDisabled) {
          const reason = "channel_not_allowed";
          const warningKey = `${params.accountId}:${p.channelId}:${reason}`;
          if (!channelDenialWarnings.peek(warningKey)) {
            channelDenialWarnings.check(warningKey);
            logger.warn(
              {
                provider: "slack",
                accountId: params.accountId,
                channelId: p.channelId,
                reason,
                cause: "channel_disabled",
                groupPolicy: params.groupPolicy,
                matchSource: channelConfig.matchSource,
                matchKey: channelConfig.matchKey,
              },
              "Slack channel denied by configuration",
            );
          }
        }
        logVerbose(
          `slack: drop channel ${p.channelId} (groupPolicy=${params.groupPolicy}, ${channelMatchMeta})`,
        );
        return false;
      }
      logVerbose(`slack: allow channel ${p.channelId} (${channelMatchMeta})`);
    }

    return true;
  };

  const shouldDropMismatchedSlackEvent = (body: unknown) => {
    if (!body || typeof body !== "object") {
      return false;
    }
    const raw = body as {
      api_app_id?: unknown;
      team_id?: unknown;
      team?: { id?: unknown };
    };
    const incomingApiAppId = typeof raw.api_app_id === "string" ? raw.api_app_id : "";
    const incomingTeamId =
      typeof raw.team_id === "string"
        ? raw.team_id
        : typeof raw.team?.id === "string"
          ? raw.team.id
          : "";

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
    channelRuntime: params.channelRuntime,
    botUserId: params.botUserId,
    botId: params.botId,
    teamId: params.teamId,
    apiAppId: params.apiAppId,
    installationIdentity: params.installationIdentity ?? {
      kind: "degraded",
      reason: "auth_test_failed",
    },
    historyLimit: params.historyLimit,
    dmHistoryLimit: Math.max(0, params.dmHistoryLimit ?? 0),
    channelHistories,
    sessionScope: params.sessionScope,
    mainKey: params.mainKey,
    dmEnabled: params.dmEnabled,
    dmPolicy: params.dmPolicy,
    allowFrom,
    allowNameMatching: params.allowNameMatching,
    groupDmEnabled: params.groupDmEnabled,
    groupDmChannels,
    defaultRequireMention,
    channelsConfig: params.channelsConfig,
    channelsConfigKeys,
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
    typingReaction: params.typingReaction,
    mediaMaxBytes: params.mediaMaxBytes,
    removeAckAfterReply: params.removeAckAfterReply,
    logger,
    shouldDropMismatchedSlackEvent,
    resolveSlackSystemEventSessionKey,
    isChannelAllowed,
    resolveChannelName,
    rememberSlackChannelType,
    recallSlackChannelType,
    resolveUserName,
    setSlackThreadStatus,
    getSlackAssistantThreadContext,
    saveSlackAssistantThreadContext,
    setSlackAssistantSuggestedPrompts,
  };
}
