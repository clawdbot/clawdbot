import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-types";
import type { SessionBindingRecord } from "openclaw/plugin-sdk/conversation-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import type { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ChannelType, Client, User } from "../internal/discord.js";
import type { DiscordChannelConfigResolved, DiscordGuildEntryResolved } from "./allow-list.js";
import type { DiscordChannelInfo } from "./message-utils.js";
import type { DiscordThreadBindingLookup } from "./reply-delivery.js";
import type { DiscordSenderIdentity } from "./sender-identity.js";

export type { DiscordSenderIdentity } from "./sender-identity.js";
import type { DiscordThreadChannel } from "./threading.js";

type LoadedConfig = OpenClawConfig;
export type RuntimeEnv = import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;

export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;

type DiscordMessagePreflightSharedFields = {
  cfg: LoadedConfig;
  discordConfig: NonNullable<
    import("openclaw/plugin-sdk/config-types").OpenClawConfig["channels"]
  >["discord"];
  accountId: string;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  abortSignal?: AbortSignal;
  guildHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  ackReactionScope: "all" | "direct" | "group-all" | "group-mentions" | "off" | "none";
  groupPolicy: "open" | "disabled" | "allowlist";
};

export type DiscordMessagePreflightContext = DiscordMessagePreflightSharedFields & {
  data: DiscordMessageEvent;
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId: string;
  author: User;
  sender: DiscordSenderIdentity;
  canonicalMessageId?: string;
  memberRoleIds: string[];

  channelInfo: DiscordChannelInfo | null;
  channelName?: string;

  isGuildMessage: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;

  commandAuthorized: boolean;
  baseText: string;
  messageText: string;
  preflightAudioTranscript?: string;
  wasMentioned: boolean;

  route: ReturnType<typeof resolveAgentRoute>;
  threadBinding?: SessionBindingRecord;
  boundSessionKey?: string;
  boundAgentId?: string;

  guildInfo: DiscordGuildEntryResolved | null;
  guildSlug: string;

  threadChannel: DiscordThreadChannel | null;
  threadParentId?: string;
  threadParentName?: string;
  threadParentType?: ChannelType;
  threadName?: string | null;

  configChannelName?: string;
  configChannelSlug: string;
  displayChannelName?: string;
  displayChannelSlug: string;

  baseSessionKey: string;
  channelConfig: DiscordChannelConfigResolved | null;
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;

  shouldRequireMention: boolean;
  hasAnyMention: boolean;
  allowTextCommands: boolean;
  shouldBypassMention: boolean;
  effectiveWasMentioned: boolean;
  canDetectMention: boolean;

  historyEntry?: HistoryEntry;
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
};

export type DiscordMessagePreflightParams = DiscordMessagePreflightSharedFields & {
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  ackReactionScope: DiscordMessagePreflightContext["ackReactionScope"];
  groupPolicy: DiscordMessagePreflightContext["groupPolicy"];
  threadBindings: DiscordThreadBindingLookup;
  discordRestFetch?: typeof fetch;
  data: DiscordMessageEvent;
  client: Client;
};
