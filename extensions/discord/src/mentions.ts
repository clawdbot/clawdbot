// Discord plugin module implements mentions behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveDiscordDirectoryUserId } from "./directory-cache.js";

type DiscordMentionAliasesConfig = Record<string, string>;

const MENTION_CANDIDATE_PATTERN = /(^|[\s([{"'.,;:!?])@([a-z0-9_.-]{2,32}(?:#[0-9]{4})?)/gi;
const DISCORD_RESERVED_MENTIONS = new Set(["everyone", "here"]);
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;
const DISCORD_BROADCAST_MENTION_PATTERN = /@(everyone|here)\b/;

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
  const target = expectDefined(values.at(0), "single Discord mention target");
  if (target.kind === "user") {
    return `<@${target.id}>`;
  }
  if (target.kind === "role") {
    return `<@&${target.id}>`;
  }
  return `<#${target.id}>`;
}

function normalizeHandleKey(raw: string): string | null {
  let handle = normalizeOptionalString(raw) ?? "";
  if (!handle) {
    return null;
  }
  if (handle.startsWith("@")) {
    handle = normalizeOptionalString(handle.slice(1)) ?? "";
  }
  if (!handle || /\s/.test(handle)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(handle);
}

function resolveConfiguredMentionAlias(
  handle: string,
  mentionAliases?: DiscordMentionAliasesConfig | null,
): string | undefined {
  const key = normalizeHandleKey(handle);
  if (!key || !mentionAliases) {
    return undefined;
  }
  const withoutDiscriminator = key.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
  for (const [rawAlias, rawUserId] of Object.entries(mentionAliases)) {
    const alias = normalizeHandleKey(rawAlias);
    if (!alias) {
      continue;
    }
    const aliasWithoutDiscriminator = alias.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
    if (
      alias === key ||
      (withoutDiscriminator && withoutDiscriminator !== key && alias === withoutDiscriminator) ||
      (aliasWithoutDiscriminator &&
        aliasWithoutDiscriminator !== alias &&
        aliasWithoutDiscriminator === key)
    ) {
      const userId = normalizeSnowflake(rawUserId);
      if (userId) {
        return userId;
      }
    }
  }
  return undefined;
}

function rewritePlainTextMentions(
  text: string,
  params: {
    accountId?: string | null;
    mentionAliases?: DiscordMentionAliasesConfig | null;
  },
): string {
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
    const userId =
      resolveConfiguredMentionAlias(handle, params.mentionAliases) ??
      resolveDiscordDirectoryUserId({
        accountId: params.accountId,
        handle,
      });
    if (!userId) {
      return match;
    }
    return `${String(prefix ?? "")}${formatMention({ userId })}`;
  });
}

function countBacktickRun(text: string, index: number): number {
  let cursor = index;
  while (text[cursor] === "`") {
    cursor += 1;
  }
  return cursor - index;
}

function findSameLineBacktickRun(
  text: string,
  startIndex: number,
  runLength: number,
): number | null {
  const delimiter = "`".repeat(runLength);
  const newlineIndex = text.indexOf("\n", startIndex);
  const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
  const closeIndex = text.indexOf(delimiter, startIndex);
  return closeIndex !== -1 && closeIndex < lineEnd ? closeIndex + runLength : null;
}

function findFenceEnd(text: string, startIndex: number, runLength: number): number {
  let searchIndex = startIndex + runLength;
  while (searchIndex < text.length) {
    const newlineIndex = text.indexOf("\n", searchIndex);
    if (newlineIndex === -1) {
      return text.length;
    }
    let lineCursor = newlineIndex + 1;
    while (text[lineCursor] === " " && lineCursor - newlineIndex <= 3) {
      lineCursor += 1;
    }
    const closingRunLength = countBacktickRun(text, lineCursor);
    if (closingRunLength >= runLength) {
      return lineCursor + closingRunLength;
    }
    searchIndex = lineCursor + Math.max(closingRunLength, 1);
  }
  return text.length;
}

function findNextMarkdownCodeSegment(
  text: string,
  startIndex: number,
): { startIndex: number; endIndex: number } | null {
  let searchIndex = startIndex;
  while (searchIndex < text.length) {
    const segmentStart = text.indexOf("`", searchIndex);
    if (segmentStart === -1) {
      return null;
    }
    const runLength = countBacktickRun(text, segmentStart);
    const inlineEndIndex = findSameLineBacktickRun(text, segmentStart + runLength, runLength);
    if (inlineEndIndex !== null) {
      return { startIndex: segmentStart, endIndex: inlineEndIndex };
    }
    if (runLength >= 3) {
      return {
        startIndex: segmentStart,
        endIndex: findFenceEnd(text, segmentStart, runLength),
      };
    }
    searchIndex = segmentStart + runLength;
  }
  return null;
}

export function rewriteDiscordKnownMentions(
  text: string,
  params: {
    accountId?: string | null;
    mentionAliases?: DiscordMentionAliasesConfig | null;
  },
): string {
  if (!text.includes("@")) {
    return text;
  }
  let rewritten = "";
  let offset = 0;
  let segment = findNextMarkdownCodeSegment(text, offset);
  while (segment) {
    rewritten += rewritePlainTextMentions(text.slice(offset, segment.startIndex), params);
    rewritten += text.slice(segment.startIndex, segment.endIndex);
    offset = segment.endIndex;
    segment = findNextMarkdownCodeSegment(text, offset);
  }
  rewritten += rewritePlainTextMentions(text.slice(offset), params);
  return rewritten;
}

/** Whether text carries an `@everyone`/`@here` broadcast mention. */
export function discordTextHasBroadcastMention(text: string): boolean {
  return DISCORD_BROADCAST_MENTION_PATTERN.test(text);
}
