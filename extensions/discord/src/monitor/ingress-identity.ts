import {
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentifierKind,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeDiscordAllowList } from "./allow-list.js";

const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];
const DISCORD_USER_ID_KIND = "stable-id" satisfies ChannelIngressIdentifierKind;
const DISCORD_USER_NAME_KIND = "username" satisfies ChannelIngressIdentifierKind;

function normalizeDiscordIdEntry(entry: string): string | null {
  const text = entry.trim();
  if (!text) {
    return null;
  }
  const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
  if (/^\d+$/.test(maybeId)) {
    return maybeId;
  }
  const prefix = DISCORD_ALLOW_LIST_PREFIXES.find((entryPrefix) => text.startsWith(entryPrefix));
  if (prefix) {
    const candidate = text.slice(prefix.length).trim();
    return candidate || null;
  }
  return null;
}

function normalizeDiscordNameEntry(entry: string): string | null {
  const text = entry.trim();
  if (!text || text === "*" || normalizeDiscordIdEntry(text) || /#\d{4}$/.test(text)) {
    return null;
  }
  const nameSlug = normalizeDiscordAllowList([text], DISCORD_ALLOW_LIST_PREFIXES)
    ?.names.values()
    .next().value;
  return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}

function normalizeDiscordTagEntry(entry: string): string | null {
  const text = entry.trim();
  return /#\d{4}$/.test(text) ? normalizeDiscordNameSubject(text) : null;
}

function normalizeDiscordNameSubject(value: string): string | null {
  const nameSlug = normalizeDiscordAllowList([value], DISCORD_ALLOW_LIST_PREFIXES)
    ?.names.values()
    .next().value;
  return typeof nameSlug === "string" && nameSlug ? nameSlug : null;
}

export const discordIngressIdentity = defineStableChannelIngressIdentity({
  resolveParticipant: (subject) => {
    const kind = subject.aliases?.participantKind;
    const id = subject.stableId;
    return typeof id === "string" &&
      id &&
      (kind === "user" || kind === "bot" || kind === "pluralkit-member")
      ? { domain: kind === "pluralkit-member" ? "pluralkit" : "discord", idKind: kind, id }
      : undefined;
  },
  key: "discordUserId",
  kind: DISCORD_USER_ID_KIND,
  // Discord binds author/user.id on events delivered over the authenticated bot-token session.
  authentication: "verified",
  normalizeEntry: normalizeDiscordIdEntry,
  normalizeSubject: (value) => value.trim() || null,
  sensitivity: "pii",
  aliases: (
    [
      ["discordUserName", normalizeDiscordNameEntry],
      ["discordUserTag", normalizeDiscordTagEntry],
    ] as const
  ).map(([key, normalizeEntry]) => ({
    key,
    kind: DISCORD_USER_NAME_KIND,
    normalizeEntry,
    normalizeSubject: normalizeDiscordNameSubject,
    authentication: "mutable",
    sensitivity: "pii",
  })),
});
