import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SilentReplyPolicy } from "../../shared/silent-reply-policy.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";
import { extractExplicitGroupId } from "./group-id.js";

let groupsRuntimePromise: Promise<typeof import("./groups.runtime.js")> | null = null;

type DiscordGroupConfig = {
  requireMention?: boolean;
  slug?: string;
  channels?: Record<string, DiscordGroupConfig>;
};

type DiscordConfigWithGuilds = {
  accounts?: Record<string, { guilds?: Record<string, DiscordGroupConfig> }>;
  guilds?: Record<string, DiscordGroupConfig>;
};

function loadGroupsRuntime() {
  groupsRuntimePromise ??= import("./groups.runtime.js");
  return groupsRuntimePromise;
}

async function resolveRuntimeChannelId(raw?: string | null): Promise<string | null> {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return null;
  }
  const { getChannelPlugin, normalizeChannelId } = await loadGroupsRuntime();
  try {
    if (getChannelPlugin(normalized)) {
      return normalized;
    }
  } catch {
    // Plugin registry may not be initialized in shared/test contexts.
  }
  try {
    return normalizeChannelId(raw) ?? normalized;
  } catch {
    return normalized;
  }
}

function normalizeDiscordSlug(value?: string | null) {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveDiscordGuilds(
  cfg: OpenClawConfig,
  accountId?: string | null,
): Record<string, DiscordGroupConfig> | undefined {
  const discord = cfg.channels?.discord as DiscordConfigWithGuilds | undefined;
  if (!discord) {
    return undefined;
  }
  const normalizedAccountId = normalizeOptionalString(accountId);
  const accountGuilds = normalizedAccountId
    ? discord.accounts?.[normalizedAccountId]?.guilds
    : undefined;
  return accountGuilds ?? discord.guilds;
}

function resolveDiscordGuildEntry(
  guilds: Record<string, DiscordGroupConfig> | undefined,
  groupSpace?: string | null,
): DiscordGroupConfig | undefined {
  if (!guilds || Object.keys(guilds).length === 0) {
    return undefined;
  }
  const space = normalizeOptionalString(groupSpace) ?? "";
  if (space && guilds[space]) {
    return guilds[space];
  }
  const slug = normalizeDiscordSlug(space);
  if (slug && guilds[slug]) {
    return guilds[slug];
  }
  if (slug) {
    const match = Object.values(guilds).find((entry) => normalizeDiscordSlug(entry?.slug) === slug);
    if (match) {
      return match;
    }
  }
  return guilds["*"];
}

function resolveDiscordChannelEntry(
  channels: Record<string, DiscordGroupConfig> | undefined,
  params: { groupId?: string | null; groupChannel?: string | null },
): DiscordGroupConfig | undefined {
  if (!channels || Object.keys(channels).length === 0) {
    return undefined;
  }
  const groupId = normalizeOptionalString(params.groupId);
  const groupChannel = normalizeOptionalString(params.groupChannel);
  const channelSlug = normalizeDiscordSlug(groupChannel);
  return (
    (groupId ? channels[groupId] : undefined) ??
    (channelSlug ? (channels[channelSlug] ?? channels[`#${channelSlug}`]) : undefined) ??
    (groupChannel ? channels[groupChannel] : undefined) ??
    channels["*"]
  );
}

function resolveDiscordRequireMentionFallback(params: {
  cfg: OpenClawConfig;
  channel: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
}): boolean | undefined {
  if (params.channel !== "discord") {
    return undefined;
  }
  const guildEntry = resolveDiscordGuildEntry(
    resolveDiscordGuilds(params.cfg, params.accountId),
    params.groupSpace,
  );
  const channelEntry = resolveDiscordChannelEntry(guildEntry?.channels, params);
  if (typeof channelEntry?.requireMention === "boolean") {
    return channelEntry.requireMention;
  }
  if (typeof guildEntry?.requireMention === "boolean") {
    return guildEntry.requireMention;
  }
  return undefined;
}

export async function resolveGroupRequireMention(params: {
  cfg: OpenClawConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): Promise<boolean> {
  const { cfg, ctx, groupResolution } = params;
  const rawChannel = groupResolution?.channel ?? normalizeOptionalString(ctx.Provider);
  const channel = await resolveRuntimeChannelId(rawChannel);
  if (!channel) {
    return true;
  }
  const rawGroupId = (ctx.From ?? "").trim();
  const groupId =
    groupResolution?.id ?? extractExplicitGroupId(rawGroupId) ?? (rawGroupId || undefined);
  const groupChannel =
    normalizeOptionalString(ctx.GroupChannel) ?? normalizeOptionalString(ctx.GroupSubject);
  const groupSpace = normalizeOptionalString(ctx.GroupSpace);
  let requireMention: boolean | undefined;
  const runtime = await loadGroupsRuntime();
  try {
    requireMention = runtime.getChannelPlugin(channel)?.groups?.resolveRequireMention?.({
      cfg,
      groupId,
      groupChannel,
      groupSpace,
      accountId: ctx.AccountId,
    });
  } catch {
    requireMention = undefined;
  }
  if (typeof requireMention === "boolean") {
    return requireMention;
  }
  const discordRequireMention = resolveDiscordRequireMentionFallback({
    cfg,
    channel,
    groupId,
    groupChannel,
    groupSpace,
    accountId: ctx.AccountId,
  });
  if (typeof discordRequireMention === "boolean") {
    return discordRequireMention;
  }
  return resolveChannelGroupRequireMention({
    cfg,
    channel,
    groupId,
    accountId: ctx.AccountId,
  });
}

export function defaultGroupActivation(requireMention: boolean): "always" | "mention" {
  return !requireMention ? "always" : "mention";
}

function resolveProviderLabel(rawProvider: string | undefined): string {
  const providerKey = normalizeOptionalLowercaseString(rawProvider) ?? "";
  if (!providerKey) {
    return "chat";
  }
  if (isInternalMessageChannel(providerKey)) {
    return "WebChat";
  }
  const labels: Record<string, string> = {
    imessage: "iMessage",
    whatsapp: "WhatsApp",
  };
  const label = labels[providerKey];
  if (label) {
    return label;
  }
  return `${providerKey.at(0)?.toUpperCase() ?? ""}${providerKey.slice(1)}`;
}

export function buildGroupChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPolicy?: SilentReplyPolicy;
  silentReplyRewrite?: boolean;
  silentToken?: string;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";

  const lines: string[] = [];
  lines.push(`You are in a ${providerLabel} group chat.`);
  if (messageToolOnly) {
    lines.push(
      "Normal final replies are private and are not automatically sent to this group chat. To post visible output here, use the message tool with action=send; the target defaults to this group chat.",
    );
  } else {
    lines.push(
      "Your replies are automatically sent to this group chat. Do not use the message tool to send to this same group - just reply normally.",
    );
  }
  lines.push(
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.",
  );
  lines.push(
    "Write like a human. Avoid Markdown tables. Minimize empty lines and use normal chat conventions, not document-style spacing. Don't type literal \\n sequences; use real line breaks sparingly.",
  );
  lines.push(
    "When subagent or session-spawn tools are available and a directly requested group-chat task will require several tool calls, prefer delegating bounded side investigations early so the channel gets a responsive path forward. Keep the critical path local, avoid subagents for simple one-step work, and only surface concise group-visible updates when they add value.",
  );
  const canUseSilentReply =
    !messageToolOnly &&
    params.silentToken &&
    (params.silentReplyPolicy !== "disallow" || params.silentReplyRewrite === true);
  if (messageToolOnly) {
    lines.push(
      "If no visible group response is needed, do not call message(action=send). Your normal final answer stays private and will not be posted to the group.",
    );
  }
  if (canUseSilentReply) {
    if (params.silentReplyPolicy === "allow") {
      lines.push(
        `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so OpenClaw stays silent.`,
      );
      lines.push("Be extremely selective: reply only when directly addressed or clearly helpful.");
    } else {
      lines.push(
        `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so OpenClaw can send a short fallback reply.`,
      );
    }
    lines.push(
      "Do not add any other words, punctuation, tags, markdown/code blocks, or explanations.",
    );
    lines.push(
      `If you only react or otherwise handle the message without a text reply, your final answer must still be exactly "${params.silentToken}". Never say that you are staying quiet, keeping channel noise low, making a context-only note, or sending no channel reply.`,
    );
    lines.push(
      `Any prose describing silence is wrong; the whole final answer must be only "${params.silentToken}".`,
    );
  }
  return lines.join(" ");
}

export function buildDirectChatContext(params: {
  sessionCtx: TemplateContext;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  silentReplyPolicy?: SilentReplyPolicy;
  silentReplyRewrite?: boolean;
  silentToken: string;
}): string {
  const providerLabel = resolveProviderLabel(params.sessionCtx.Provider);
  const messageToolOnly = params.sourceReplyDeliveryMode === "message_tool_only";
  const lines: string[] = [];
  lines.push(`You are in a ${providerLabel} direct conversation.`);
  if (messageToolOnly) {
    lines.push(
      "Normal final replies are private and are not automatically sent to this conversation. To post visible output here, use the message tool with action=send; the target defaults to this conversation.",
    );
    lines.push(
      "If no visible direct response is needed, do not call message(action=send). Your normal final answer stays private and will not be posted to the conversation.",
    );
    return lines.join(" ");
  }
  lines.push("Your replies are automatically sent to this conversation.");
  if (params.silentReplyPolicy === "allow") {
    lines.push(
      `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so OpenClaw stays silent.`,
    );
  } else if (params.silentReplyRewrite === true) {
    lines.push(
      `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so OpenClaw can send a short fallback reply.`,
    );
  } else {
    lines.push(`Do not use "${params.silentToken}" as your final answer in this conversation.`);
  }
  return lines.join(" ");
}

export function resolveGroupSilentReplyBehavior(params: {
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentReplyPolicy?: SilentReplyPolicy;
  silentReplyRewrite?: boolean;
}): {
  activation: "always" | "mention";
  canUseSilentReply: boolean;
  allowEmptyAssistantReplyAsSilent: boolean;
} {
  const activation =
    normalizeGroupActivation(params.sessionEntry?.groupActivation) ?? params.defaultActivation;
  const canUseSilentReply =
    params.silentReplyPolicy !== "disallow" || params.silentReplyRewrite === true;
  return {
    activation,
    canUseSilentReply,
    allowEmptyAssistantReplyAsSilent: params.silentReplyPolicy === "allow",
  };
}

export function buildGroupIntro(params: {
  cfg: OpenClawConfig;
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentToken: string;
  silentReplyPolicy?: SilentReplyPolicy;
  silentReplyRewrite?: boolean;
}): string {
  const { activation } = resolveGroupSilentReplyBehavior(params);
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  return `${activationLine} Address the specific sender noted in the message context.`;
}
