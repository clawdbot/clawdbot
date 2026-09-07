/**
 * Detects whether a ClickClack group message contains a direct mention of the
 * current account.
 *
 * Pure helper – no side effects, no runtime imports.
 */

import {
  buildMentionRegexes,
  normalizeMentionText,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type ClickClackMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
};

const CLICKCLACK_MENTION_PATTERN = /(?:^|[^a-z0-9_@-])@([a-z0-9][a-z0-9_-]{1,31})(?![a-z0-9_-])/giu;

function buildLocalMentionRegexes(params: {
  cfg?: OpenClawConfig;
  mentionPatterns: string[];
  channelId?: string;
}): RegExp[] {
  if (params.mentionPatterns.length === 0) {
    return [];
  }
  const cfg = params.cfg;
  const syntheticCfg = {
    ...cfg,
    messages: {
      ...cfg?.messages,
      groupChat: {
        ...cfg?.messages?.groupChat,
        mentionPatterns: params.mentionPatterns,
      },
    },
  } as OpenClawConfig;
  return buildMentionRegexes(syntheticCfg, undefined, {
    provider: "clickclack",
    conversationId: params.channelId,
  });
}

function resolveMentionHandles(body: string): string[] {
  return [...body.matchAll(CLICKCLACK_MENTION_PATTERN)]
    .map((match) => match[1]?.toLowerCase())
    .filter((handle): handle is string => Boolean(handle));
}

/**
 * Builds mention facts for a ClickClack message.
 *
 * Rules:
 * - DMs always have canDetectMention: false, wasMentioned: false
 *   (DMs bypass mention gating).
 * - Group messages: canDetectMention: true when body text is available.
 * - Checks the message body against shared and account-local mention patterns.
 * - If botHandle is provided and the message body contains its ClickClack
 *   `@handle`, treat it as a mention.
 * - Shared patterns default to the routed agent's identity name when none are configured.
 */
export function resolveClickClackMentionFacts(params: {
  isDirect: boolean;
  body?: string;
  mentionPatterns: string[];
  botHandle?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  channelId?: string;
}): ClickClackMentionFacts {
  const { isDirect, body, mentionPatterns, botHandle, cfg, agentId, channelId } = params;

  if (isDirect) {
    return {
      canDetectMention: false,
      wasMentioned: false,
    };
  }

  if (!body) {
    return {
      canDetectMention: true,
      wasMentioned: false,
      hasAnyMention: false,
    };
  }

  const sharedMentionRegexes = buildMentionRegexes(cfg, agentId, {
    provider: "clickclack",
    conversationId: channelId,
  });
  const localMentionRegexes = buildLocalMentionRegexes({
    cfg,
    mentionPatterns,
    channelId,
  });
  const mentionRegexes = [...sharedMentionRegexes, ...localMentionRegexes];
  const bodyForRegex = normalizeMentionText(body);
  const hasConfiguredMention = mentionRegexes.some((regex) => regex.test(bodyForRegex));

  const mentionHandles = resolveMentionHandles(body);
  const normalizedBotHandle = botHandle?.replace(/^@/u, "").trim().toLowerCase();
  const hasHandleMention = normalizedBotHandle
    ? mentionHandles.includes(normalizedBotHandle)
    : false;
  const wasMentioned = hasHandleMention || hasConfiguredMention;

  return {
    canDetectMention: true,
    wasMentioned,
    hasAnyMention: mentionHandles.length > 0 || hasConfiguredMention,
  };
}
