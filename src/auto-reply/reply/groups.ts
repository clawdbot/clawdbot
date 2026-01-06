import type { ClawdbotConfig } from "../../config/config.js";
import { resolveProviderGroupRequireMention } from "../../config/group-policy.js";
import type {
  GroupKeyResolution,
  SessionEntry,
} from "../../config/sessions.js";
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
  const surface = groupResolution?.surface ?? ctx.Surface?.trim().toLowerCase();
  const groupId = groupResolution?.id ?? ctx.From?.replace(/^group:/, "");
  const groupRoom = ctx.GroupRoom?.trim() ?? ctx.GroupSubject?.trim();
  const groupSpace = ctx.GroupSpace?.trim();
  if (
    surface === "telegram" ||
    surface === "whatsapp" ||
    surface === "imessage"
  ) {
    return resolveProviderGroupRequireMention({
      cfg,
      surface,
      groupId,
    });
  }
  if (surface === "discord") {
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
  if (surface === "slack") {
    const channels = cfg.slack?.channels ?? {};
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
  const surface = params.sessionCtx.Surface?.trim().toLowerCase();
  const surfaceLabel = (() => {
    if (!surface) return "chat";
    if (surface === "whatsapp") return "WhatsApp";
    if (surface === "telegram") return "Telegram";
    if (surface === "discord") return "Discord";
    if (surface === "webchat") return "WebChat";
    return `${surface.at(0)?.toUpperCase() ?? ""}${surface.slice(1)}`;
  })();
  const subjectLine = subject
    ? `You are replying inside the ${surfaceLabel} group "${subject}".`
    : `You are replying inside a ${surfaceLabel} group chat.`;
  const membersLine = members ? `Group members: ${members}.` : undefined;
  const activationLine =
    activation === "always"
      ? "Activation: always-on (you receive every group message)."
      : "Activation: trigger-only (you are invoked only when explicitly mentioned; recent context may be included).";
  const silenceLine =
    activation === "always"
      ? `If no response is needed, reply with exactly "${params.silentToken}" (no other text) so Clawdbot stays silent.`
      : undefined;
  const cautionLine =
    activation === "always"
      ? "Be extremely selective: reply only when you are directly addressed, asked a question, or can add clear value. Otherwise stay silent."
      : undefined;
  const lurkLine =
    "Be a good group participant: lurk and follow the conversation, but only chime in when you have something genuinely helpful or relevant to add. Don't feel obligated to respond to every message — quality over quantity. Even when lurking silently, you can use emoji reactions to acknowledge messages, show support, or react to humor — reactions are always appreciated and don't clutter the chat.";
  return [
    subjectLine,
    membersLine,
    activationLine,
    silenceLine,
    cautionLine,
    lurkLine,
  ]
    .filter(Boolean)
    .join(" ")
    .concat(" Address the specific sender noted in the message context.");
}
