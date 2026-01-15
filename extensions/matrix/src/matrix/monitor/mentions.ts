import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events.js";

import { matchesMentionPatterns } from "../../../../../src/auto-reply/reply/mentions.js";

export function resolveMentions(params: {
  content: RoomMessageEventContent;
  userId?: string | null;
  text?: string;
  mentionRegexes: RegExp[];
}) {
  const mentions = params.content["m.mentions"] as
    | { user_ids?: string[]; room?: boolean }
    | undefined;
  const mentionedUsers = Array.isArray(mentions?.user_ids)
    ? new Set(mentions.user_ids)
    : new Set<string>();
  const wasMentioned =
    Boolean(mentions?.room) ||
    (params.userId ? mentionedUsers.has(params.userId) : false) ||
    matchesMentionPatterns(params.text ?? "", params.mentionRegexes);
  return { wasMentioned, hasExplicitMention: Boolean(mentions) };
}
