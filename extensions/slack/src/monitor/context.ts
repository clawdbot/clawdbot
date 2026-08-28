// Slack plugin module implements context behavior.
import type { App } from "@slack/bolt";
import { formatAllowlistMatchMeta } from "openclaw/plugin-sdk/allow-from";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type {
  OpenClawConfig,
  SlackReactionNotificationMode,
  SessionScope,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk/config-contracts";
import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { logVerbose, getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackError } from "../errors.js";
import { buildSlackChannelIdCandidates } from "../group-policy.js";
import type { SlackMessageEvent } from "../types.js";
import { createSlackAgentViewState } from "./agent-view-state.js";
import { normalizeAllowList, normalizeAllowListLower, normalizeSlackSlug } from "./allow-list.js";
import {
  createSlackAssistantThreadContextStore,
  type SlackAssistantThreadContext,
} from "./assistant-thread-context.js";
import type { SlackChannelConfigEntries } from "./channel-config.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType } from "./channel-type.js";
import type { SlackIdentityHealth, SlackInstallationIdentity } from "./enterprise-install.js";
import type { SlackEventScope } from "./event-scope.js";
import { readLruMapEntry, writeLruMapEntry } from "./lru-map-cache.js";
import { saveRemoteMedia } from "./media.runtime.js";
import { isSlackChannelAllowedByPolicy } from "./policy.js";
import { isGovSlackClient } from "./slack-client-kind.js";
import {
  type SlackSuggestedPromptsInput,
  updateSlackSuggestedPrompts,
} from "./suggested-prompts.js";
import { createSlackSystemEventRouteResolver } from "./system-event-session.js";

export {
  buildSlackAssistantThreadMetadata,
  parseSlackAssistantThreadMetadata,
} from "./assistant-thread-context.js";
export type { SlackAssistantThreadContext } from "./assistant-thread-context.js";
export { normalizeSlackChannelType, resolveSlackChatType } from "./channel-type.js";
export { DEFAULT_SLACK_SUGGESTED_PROMPTS } from "./suggested-prompts.js";

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

type SlackUserInfo = { name?: string; imageUrl?: string; error?: unknown };
type BuildChannelInboundContext =
  typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;
const SLACK_CHANNEL_CACHE_MAX_ENTRIES = 1024;
const SLACK_USER_CACHE_MAX_ENTRIES = 2048;
const SLACK_AVATAR_CACHE_MAX_ENTRIES = 128;
const SLACK_AVATAR_MAX_BYTES = 256 * 1024;
const SLACK_AVATAR_SSRF_POLICY = {
  allowedHostnames: ["avatars.slack-edge.com", "*.slack-edge.com"],
  hostnameAllowlist: ["avatars.slack-edge.com", "*.slack-edge.com"],
};
const SLACK_CHANNEL_DENIAL_WARNING_TTL_MS = 5 * 60_000;
const SLACK_CHANNEL_DENIAL_WARNING_MAX_ENTRIES = 1024;

export type SlackMonitorContext = {
  cfg: OpenClawConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  buildContext?: BuildChannelInboundContext;
  dispatchReplyFromConfig?: ChannelInboundTurnPlan["dispatchReplyFromConfig"];

  botUserId: string;
  botId?: string;
  identityHealth: SlackIdentityHealth;
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

  logger: ReturnType<typeof getChildLogger>;
  shouldDropMismatchedSlackEvent: (body: unknown) => boolean;
  resolveSlackSystemEventRoute: (params: {
    channelId?: string | null;
    channelType?: string | null;
    senderId?: string | null;
    threadTs?: string | null;
    eventScope?: SlackEventScope;
  }) => { agentId: string; sessionKey: string };
  isChannelAllowed: (params: {
    teamId?: string;
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
  resolveUserName: (userId: string, eventScope?: SlackEventScope) => Promise<SlackUserInfo>;
  resolveUserAvatar: (userId: string, eventScope?: SlackEventScope) => string | undefined;
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
  setSlackSuggestedPrompts: (params: SlackSuggestedPromptsInput) => Promise<boolean>;
  recordSlackAgentView: () => Promise<void>;
  isSlackAgentView: () => Promise<boolean>;
  recordSlackManagedViewThread: (channelId: string, threadTs: string) => Promise<void>;
  isSlackManagedViewThread: (channelId: string, threadTs: string) => Promise<boolean>;
};

export function createSlackMonitorContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
  botToken: string;
  app: App;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;

  botUserId: string;
  botId?: string;
  identityHealth: SlackIdentityHealth;
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
}): SlackMonitorContext {
  const channelHistories = new Map<string, HistoryEntry[]>();
  const logger = getChildLogger({ module: "slack-auto-reply" });
  const channelCache = new Map<string, SlackChannelCacheEntry>();
  const userCache = new Map<string, { name?: string; imageUrl?: string }>();
  const avatarCache = new Map<string, string>();
  const pendingAvatars = new Set<string>();
  // Rate-limit active denials while retaining periodic evidence; bound keys against config churn.
  const channelDenialWarnings = createDedupeCache({
    ttlMs: SLACK_CHANNEL_DENIAL_WARNING_TTL_MS,
    maxSize: SLACK_CHANNEL_DENIAL_WARNING_MAX_ENTRIES,
  });
  const assistantThreadContextStore = createSlackAssistantThreadContextStore({
    accountId: params.accountId,
  });
  const agentViewState = createSlackAgentViewState({
    accountId: params.accountId,
    getTeamId: () => ctx.teamId,
    getApiAppId: () => ctx.apiAppId,
    warn: (action, error) =>
      logger.warn({ error: formatSlackError(error) }, `Slack Agent View state failed to ${action}`),
  });

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

  const resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
    cfg: params.cfg,
    accountId: params.accountId,
    getTeamId: () => ctx.teamId,
    mainKey: params.mainKey,
    threadInheritParent: params.threadInheritParent,
    recallSlackChannelType,
  });

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
      const imageUrl =
        normalizeOptionalString(profile?.image_192) ??
        normalizeOptionalString(profile?.image_512) ??
        normalizeOptionalString(profile?.image_72);
      const entry = { name, imageUrl };
      writeLruMapEntry(userCache, cacheKey, entry, SLACK_USER_CACHE_MAX_ENTRIES);
      return entry;
    } catch (error) {
      return { error };
    }
  };

  const resolveUserAvatar = (userId: string, eventScope?: SlackEventScope) => {
    const client = eventScope?.client ?? params.app.client;
    if (isGovSlackClient(client)) {
      return undefined;
    }
    const imageUrl = readLruMapEntry(userCache, scopedKey(userId, eventScope))?.imageUrl;
    if (!imageUrl) {
      return undefined;
    }
    const cacheKey = scopedKey(`${userId}\0${imageUrl}`, eventScope);
    const cached = readLruMapEntry(avatarCache, cacheKey);
    if (cached) {
      return cached;
    }
    if (pendingAvatars.has(cacheKey) || pendingAvatars.size >= SLACK_AVATAR_CACHE_MAX_ENTRIES) {
      return undefined;
    }
    pendingAvatars.add(cacheKey);
    void saveRemoteMedia({
      url: imageUrl,
      filePathHint: "conversation-avatar.png",
      maxBytes: SLACK_AVATAR_MAX_BYTES,
      ssrfPolicy: SLACK_AVATAR_SSRF_POLICY,
    })
      .then((media) => {
        writeLruMapEntry(avatarCache, cacheKey, media.path, SLACK_AVATAR_CACHE_MAX_ENTRIES);
      })
      .catch((error: unknown) => {
        logger.debug(
          { error: formatSlackError(error), userId },
          "Slack conversation avatar download failed",
        );
      })
      .finally(() => {
        pendingAvatars.delete(cacheKey);
      });
    return undefined;
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

  const setSlackSuggestedPrompts = (input: SlackSuggestedPromptsInput) =>
    updateSlackSuggestedPrompts({
      ...input,
      botToken: params.botToken,
      client: params.app.client,
    });

  const isChannelAllowed = (p: {
    teamId?: string;
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
        ...buildSlackChannelIdCandidates(p.channelId, p.teamId, {
          allowUnscoped: params.installationIdentity?.kind !== "enterprise",
        }),
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
        teamId: p.teamId,
        allowUnscoped: params.installationIdentity?.kind !== "enterprise",
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
          const warningKey = `${params.accountId}:${p.teamId ? `${p.teamId}:` : ""}${p.channelId}:${reason}`;
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

    if (ctx.apiAppId && incomingApiAppId && incomingApiAppId !== ctx.apiAppId) {
      logVerbose(
        `slack: drop event with api_app_id=${incomingApiAppId} (expected ${ctx.apiAppId})`,
      );
      return true;
    }
    if (ctx.teamId && incomingTeamId && incomingTeamId !== ctx.teamId) {
      logVerbose(`slack: drop event with team_id=${incomingTeamId} (expected ${ctx.teamId})`);
      return true;
    }
    return false;
  };

  const channelRuntime = params.channelRuntime as PluginRuntime["channel"] | undefined;
  const ctx: SlackMonitorContext = {
    cfg: params.cfg,
    accountId: params.accountId,
    botToken: params.botToken,
    app: params.app,
    runtime: params.runtime,
    channelRuntime: params.channelRuntime,
    buildContext: channelRuntime?.inbound.buildContext,
    dispatchReplyFromConfig: channelRuntime?.reply?.dispatchReplyFromConfig,
    botUserId: params.botUserId,
    botId: params.botId,
    identityHealth: params.identityHealth,
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
    logger,
    shouldDropMismatchedSlackEvent,
    resolveSlackSystemEventRoute,
    isChannelAllowed,
    resolveChannelName,
    rememberSlackChannelType,
    recallSlackChannelType,
    resolveUserName,
    resolveUserAvatar,
    setSlackThreadStatus,
    getSlackAssistantThreadContext: assistantThreadContextStore.get,
    saveSlackAssistantThreadContext: assistantThreadContextStore.save,
    setSlackSuggestedPrompts,
    recordSlackAgentView: agentViewState.record,
    isSlackAgentView: agentViewState.isEnabled,
    recordSlackManagedViewThread: agentViewState.recordManagedThread,
    isSlackManagedViewThread: agentViewState.isManagedThread,
  };
  return ctx;
}
