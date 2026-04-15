import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";

const MARKDOWN_CODE_SEGMENT_PATTERN = /```[\s\S]*?```|`[^`\n]*`/g;
const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);

function normalizeSnowflake(value: string | number | bigint): string | null {
  const text = normalizeOptionalStringifiedId(value) ?? "";
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

export function formatMention(params: {
  userId?: string | number | bigint | null;
  roleId?: string | number | bigint | null;
  channelId?: string | number | bigint | null;
}): string {
  const userId = params.userId == null ? null : normalizeSnowflake(params.userId);
  const roleId = params.roleId == null ? null : normalizeSnowflake(params.roleId);
  const channelId = params.channelId == null ? null : normalizeSnowflake(params.channelId);
  const values = [
    userId ? { kind: "user" as const, id: userId } : null,
    roleId ? { kind: "role" as const, id: roleId } : null,
    channelId ? { kind: "channel" as const, id: channelId } : null,
  ].filter((entry): entry is { kind: "user" | "role" | "channel"; id: string } => Boolean(entry));
  if (values.length !== 1) {
    throw new Error("formatMention requires exactly one of userId, roleId, or channelId");
  }
  const target = values[0];
  if (target.kind === "user") {
    return `<@${target.id}>`;
  }
  if (target.kind === "role") {
    return `<@&${target.id}>`;
  }
  return `<#${target.id}>`;
}

function rewritePlainTextMentions(text: string, accountId?: string | null): string {
  if (!text.includes("@")) {
    return text;
  }
  return text.replace(MENTION_CANDIDATE_PATTERN, (match, prefix, rawHandle) => {
    const handle = normalizeOptionalString(rawHandle) ?? "";
    if (!handle) {
      return match;
    }
    const lookup = normalizeLowercaseStringOrEmpty(handle);
    if (DISCORD_RESERVED_MENTIONS.has(lookup)) {
      return match;
    }
    const userId = resolveDiscordDirectoryUserId({
      accountId,
      handle,
    });
    if (!userId) {
      return match;
    }
    return `${String(prefix ?? "")}${formatMention({ userId })}`;
  });
}

export function rewriteDiscordKnownMentions(
  text: string,
  params: { accountId?: string | null },
): string {
  if (!text.includes("@")) {
    return text;
  }
  let rewritten = "";
  let offset = 0;
  MARKDOWN_CODE_SEGMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MARKDOWN_CODE_SEGMENT_PATTERN)) {
    const matchIndex = match.index ?? 0;
    rewritten += rewritePlainTextMentions(text.slice(offset, matchIndex), params.accountId);
    rewritten += match[0];
    offset = matchIndex + match[0].length;
  }
  rewritten += rewritePlainTextMentions(text.slice(offset), params.accountId);
  return rewritten;
}
