import type { ClawdbotConfig } from "../../config/config.js";
import { resolveProviderGroupRequireMention } from "../../config/group-policy.js";
import type {
  GroupKeyResolution,
  SessionEntry,
} from "../../config/sessions.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import { normalizeGroupActivation } from "../group-activation.js";
import type { TemplateContext } from "../templating.js";

function normalizeDiscordSlug(value?: string | null) {
  if (!value) return "";
  let text = value.trim().toLowerCase();
  if (!text) return "";
  text = text.replace(/^[@#]+/, "");
  text = text.replace(/[\s_]+/g, "-");
  text = text.replace(/[^a-z0-9-]+/g, "-");
  text = text.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return text;
}

function normalizeSlackSlug(raw?: string | null) {
  const trimmed = raw?.trim().toLowerCase() ?? "";
  if (!trimmed) return "";
  const dashed = trimmed.replace(/\s+/g, "-");
  const cleaned = dashed.replace(/[^a-z0-9#@._+-]+/g, "-");
  return cleaned.replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "");
}

function parseTelegramGroupId(value?: string | null) {
  const raw = value?.trim() ?? "";
  if (!raw) return { chatId: undefined, topicId: undefined };
  const parts = raw.split(":").filter(Boolean);
  if (
    parts.length >= 3 &&
    parts[1] === "topic" &&
    /^-?\d+$/.test(parts[0]) &&
    /^\d+$/.test(parts[2])
  ) {
    return { chatId: parts[0], topicId: parts[2] };
  }
  if (parts.length >= 2 && /^-?\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    return { chatId: parts[0], topicId: parts[1] };
  }
  return { chatId: raw, topicId: undefined };
}

function resolveTelegramRequireMention(params: {
  cfg: ClawdbotConfig;
  chatId?: string;
  topicId?: string;
}): boolean | undefined {
  const { cfg, chatId, topicId } = params;
  if (!chatId) return undefined;
  const groupConfig = cfg.telegram?.groups?.[chatId];
  const groupDefault = cfg.telegram?.groups?.["*"];
  const topicConfig =
    topicId && groupConfig?.topics ? groupConfig.topics[topicId] : undefined;
  const defaultTopicConfig =
    topicId && groupDefault?.topics ? groupDefault.topics[topicId] : undefined;
  if (typeof topicConfig?.requireMention === "boolean") {
    return topicConfig.requireMention;
  }
  if (typeof defaultTopicConfig?.requireMention === "boolean") {
    return defaultTopicConfig.requireMention;
  }
  if (typeof groupConfig?.requireMention === "boolean") {
    return groupConfig.requireMention;
  }
  if (typeof groupDefault?.requireMention === "boolean") {
    return groupDefault.requireMention;
  }
  return undefined;
}

function resolveDiscordGuildEntry(
  guilds: NonNullable<ClawdbotConfig["discord"]>["guilds"],
  groupSpace?: string,
) {
  if (!guilds || Object.keys(guilds).length === 0) return null;
  const space = groupSpace?.trim();
  if (space && guilds[space]) return guilds[space];
  const normalized = normalizeDiscordSlug(space);
  if (normalized && guilds[normalized]) return guilds[normalized];
  if (normalized) {
    const match = Object.values(guilds).find(
      (entry) => normalizeDiscordSlug(entry?.slug ?? undefined) === normalized,
    );
    if (match) return match;
  }
  return guilds["*"] ?? null;
}

export function resolveGroupRequireMention(params: {
  cfg: ClawdbotConfig;
  ctx: TemplateContext;
  groupResolution?: GroupKeyResolution;
}): boolean {
  const { cfg, ctx, groupResolution } = params;
  const provider =
    groupResolution?.provider ?? ctx.Provider?.trim().toLowerCase();
  const groupId = groupResolution?.id ?? ctx.From?.replace(/^group:/, "");
  const groupRoom = ctx.GroupRoom?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  if (provider === "telegram") {
    const { chatId, topicId } = parseTelegramGroupId(groupId);
    const requireMention = resolveTelegramRequireMention({
      cfg,
      chatId,
      topicId,
    });
    if (typeof requireMention === "boolean") return requireMention;
    return resolveProviderGroupRequireMention({
      cfg,
      provider,
      groupId: chatId ?? groupId,
    });
  }
  if (provider === "whatsapp" || provider === "imessage") {
    return resolveProviderGroupRequireMention({
      cfg,
      provider,
      groupId,
    });
  }
  if (provider === "discord") {
    const guildEntry = resolveDiscordGuildEntry(
      cfg.discord?.guilds,
      groupSpace,
    );
    const channelEntries = guildEntry?.channels;
    if (channelEntries && Object.keys(channelEntries).length > 0) {
      const channelSlug = normalizeDiscordSlug(groupRoom);
      const entry =
        (groupId ? channelEntries[groupId] : undefined) ??
        (channelSlug
          ? (channelEntries[channelSlug] ?? channelEntries[`#${channelSlug}`])
          : undefined) ??
        (groupRoom
          ? channelEntries[normalizeDiscordSlug(groupRoom)]
          : undefined);
      if (entry && typeof entry.requireMention === "boolean") {
        return entry.requireMention;
      }
    }
    if (typeof guildEntry?.requireMention === "boolean") {
      return guildEntry.requireMention;
    }
    return true;
  }
  if (provider === "slack") {
    const account = resolveSlackAccount({ cfg, accountId: ctx.AccountId });
    const channels = account.channels ?? {};
    const keys = Object.keys(channels);
    if (keys.length === 0) return true;
    const channelId = groupId?.trim();
    const channelName = groupRoom?.replace(/^#/, "");
    const normalizedName = normalizeSlackSlug(channelName);
    const candidates = [
      channelId ?? "",
      channelName ? `#${channelName}` : "",
      channelName ?? "",
      normalizedName,
    ].filter(Boolean);
    let matched: { requireMention?: boolean } | undefined;
    for (const candidate of candidates) {
      if (candidate && channels[candidate]) {
        matched = channels[candidate];
        break;
      }
    }
    const fallback = channels["*"];
    const resolved = matched ?? fallback;
    if (typeof resolved?.requireMention === "boolean") {
      return resolved.requireMention;
    }
    return true;
  }
  return true;
}

export function defaultGroupActivation(
  requireMention: boolean,
): "always" | "mention" {
  return requireMention === false ? "always" : "mention";
}

export function buildGroupIntro(params: {
  sessionCtx: TemplateContext;
  sessionEntry?: SessionEntry;
  defaultActivation: "always" | "mention";
  silentToken: string;
}): string {
  const activation =
    normalizeGroupActivation(params.sessionEntry?.groupActivation) ??
    params.defaultActivation;
  const subject = params.sessionCtx.GroupSubject?.trim();
  const members = params.sessionCtx.GroupMembers?.trim();
  const provider = params.sessionCtx.Provider?.trim().toLowerCase();
  const providerLabel = (() => {
    if (!provider) return "chat";
    if (provider === "whatsapp") return "WhatsApp";
    if (provider === "telegram") return "Telegram";
    if (provider === "discord") return "Discord";
    if (provider === "webchat") return "WebChat";
    return `${provider.at(0)?.toUpperCase() ?? ""}${provider.slice(1)}`;
  })();
  const subjectLine = subject
    ? `You are replying inside the ${providerLabel} group "${subject}".`
    : `You are replying inside a ${providerLabel} group chat.`;
  const membersLine = members ? `Group members: ${members}.` : undefined;
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const whatsappIdsLine =
    provider === "whatsapp"
      ? "WhatsApp IDs: SenderId is the participant JID; [message_id: ...] is the message id for reactions (use SenderId as participant)."
      : undefined;
  const silenceLine =
    activation === "always"
      ? `If no response is needed, reply with exactly "${params.silentToken}" (and nothing else) so Clawdbot stays silent. Do not add any other words, punctuation, tags, markdown/code blocks, or explanations.`
      : undefined;
  const cautionLine =
    activation === "always"
      ? "Be extremely selective: reply only when directly addressed or clearly helpful. Otherwise stay silent."
      : undefined;
  const lurkLine =
    "Be a good group participant: mostly lurk and follow the conversation; reply only when directly addressed or you can add clear value. Emoji reactions are welcome when available.";
  return [
    subjectLine,
    membersLine,
    activationLine,
    whatsappIdsLine,
    silenceLine,
    cautionLine,
    lurkLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
