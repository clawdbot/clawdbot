import { buildMentionRegexes, normalizeMentionText } from "openclaw/plugin-sdk/channel-inbound";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  getComparableIdentityValues,
  getMentionIdentities,
  getSelfIdentity,
  identitiesOverlap,
  type WhatsAppIdentity,
} from "../identity.js";
import { isSelfChatMode, normalizeE164 } from "../text-runtime.js";
import type { WebInboundMsg } from "./types.js";

export type MentionConfig = {
  mentionRegexes: RegExp[];
  allowFrom?: Array<string | number>;
  isSelfChat?: boolean;
};

export type MentionTargets = {
  normalizedMentions: WhatsAppIdentity[];
  self: WhatsAppIdentity;
};

export function buildMentionConfig(
  cfg: ReturnType<typeof loadConfig>,
  agentId?: string,
): MentionConfig {
  const mentionRegexes = buildMentionRegexes(cfg, agentId);
  return { mentionRegexes, allowFrom: cfg.channels?.whatsapp?.allowFrom };
}

export function resolveMentionTargets(msg: WebInboundMsg, authDir?: string): MentionTargets {
  const normalizedMentions = getMentionIdentities(msg, authDir);
  const self = getSelfIdentity(msg, authDir);
  return { normalizedMentions, self };
}

export function isBotMentionedFromTargets(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
  targets: MentionTargets,
): boolean {
  const clean = (text: string) =>
    // Remove zero-width and directionality markers WhatsApp injects around display names
    normalizeMentionText(text);

  const isSelfChat =
    typeof mentionCfg.isSelfChat === "boolean"
      ? mentionCfg.isSelfChat
      : isSelfChatMode(targets.self.e164, mentionCfg.allowFrom);

  const hasMentions = targets.normalizedMentions.length > 0;
  if (hasMentions && !isSelfChat) {
    for (const mention of targets.normalizedMentions) {
      if (identitiesOverlap(targets.self, mention)) {
        return true;
      }
    }
    // If the message explicitly mentions someone else, do not fall back to regex matches.
    return false;
  } else if (hasMentions && isSelfChat) {
    // Self-chat mode: ignore WhatsApp @mention JIDs, otherwise @mentioning the owner in group chats triggers the bot.
  }
  const bodyClean = clean(msg.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) {
    return true;
  }

  // Fallback: detect body containing our own number (with or without +, spacing)
  if (targets.self.e164) {
    const selfDigits = targets.self.e164.replace(/\D/g, "");
    if (selfDigits) {
      const bodyDigits = bodyClean.replace(/[^\d]/g, "");
      if (bodyDigits.includes(selfDigits)) {
        return true;
      }
      const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
      const pattern = new RegExp(`\\+?${selfDigits}`, "i");
      if (pattern.test(bodyNoSpace)) {
        return true;
      }
    }
  }

  return false;
}

export function debugMention(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
  authDir?: string,
): { wasMentioned: boolean; details: Record<string, unknown> } {
  const mentionTargets = resolveMentionTargets(msg, authDir);
  const result = isBotMentionedFromTargets(msg, mentionCfg, mentionTargets);
  const details = {
    from: msg.from,
    body: msg.body,
    bodyClean: normalizeMentionText(msg.body),
    mentionedJids: msg.mentions ?? msg.mentionedJids ?? null,
    normalizedMentionedJids: mentionTargets.normalizedMentions.length
      ? mentionTargets.normalizedMentions.map((identity) => getComparableIdentityValues(identity))
      : null,
    selfJid: msg.self?.jid ?? msg.selfJid ?? null,
    selfLid: msg.self?.lid ?? msg.selfLid ?? null,
    selfE164: msg.self?.e164 ?? msg.selfE164 ?? null,
    resolvedSelf: mentionTargets.self,
  };
  return { wasMentioned: result, details };
}

export function resolveOwnerList(mentionCfg: MentionConfig, selfE164?: string | null) {
  const allowFrom = mentionCfg.allowFrom;
  const raw =
    Array.isArray(allowFrom) && allowFrom.length > 0 ? allowFrom : selfE164 ? [selfE164] : [];
  return raw
    .filter((entry): entry is string => Boolean(entry && entry !== "*"))
    .map((entry) => normalizeE164(entry))
    .filter((entry): entry is string => Boolean(entry));
}
