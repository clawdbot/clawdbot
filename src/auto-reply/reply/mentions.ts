import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveMentionPatterns(identity?: { name?: string; emoji?: string }) {
  const patterns: string[] = [];
  const name = identity?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join(String.raw`\s+`) : escapeRegExp(name);
    patterns.push(String.raw`\b@?${re}\b`);
  }
  const emoji = identity?.emoji?.trim();
  if (emoji) {
    patterns.push(escapeRegExp(emoji));
  }
  return patterns;
}

const BACKSPACE_CHAR = "\u0008";

export const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

function normalizeMentionPattern(pattern: string): string {
  if (!pattern.includes(BACKSPACE_CHAR)) return pattern;
  return pattern.split(BACKSPACE_CHAR).join("\\b");
}

function normalizeMentionPatterns(patterns: string[]): string[] {
  return patterns.map(normalizeMentionPattern);
}

function resolveMentionPatterns(cfg: MoltbotConfig | undefined, agentId?: string): string[] {
  if (!cfg) return [];
  const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentGroupChat = agentConfig?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
    return agentGroupChat.mentionPatterns ?? [];
  }
  const globalGroupChat = cfg.messages?.groupChat;
  if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    return globalGroupChat.mentionPatterns ?? [];
  }
  const derived = deriveMentionPatterns(agentConfig?.identity);
  return derived.length > 0 ? derived : [];
}

export function buildMentionRegexes(cfg: MoltbotConfig | undefined, agentId?: string): RegExp[] {
  const patterns = normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId));
  return patterns
    .map((pattern) => {
      try {
        return new RegExp(pattern, "i");
      } catch {
        return null;
      }
    })
    .filter((value): value is RegExp => Boolean(value));
}

export function normalizeMentionText(text: string): string {
  return (text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").toLowerCase();
}

export function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean {
  if (mentionRegexes.length === 0) return false;
  const cleaned = normalizeMentionText(text ?? "");
  if (!cleaned) return false;
  return mentionRegexes.some((re) => re.test(cleaned));
}

export type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};

export function matchesMentionWithExplicit(params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
}): boolean {
  const cleaned = normalizeMentionText(params.text ?? "");
  const explicit = params.explicit?.isExplicitlyMentioned === true;
  const explicitAvailable = params.explicit?.canResolveExplicit === true;
  const hasAnyMention = params.explicit?.hasAnyMention === true;
  if (hasAnyMention && explicitAvailable) {
    return explicit || params.mentionRegexes.some((re) => re.test(cleaned));
  }
  if (!cleaned) return explicit;
  return explicit || params.mentionRegexes.some((re) => re.test(cleaned));
}

export function stripStructuralPrefixes(text: string): string {
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  const afterMarker = text.includes(CURRENT_MESSAGE_MARKER)
    ? text.slice(text.indexOf(CURRENT_MESSAGE_MARKER) + CURRENT_MESSAGE_MARKER.length).trimStart()
    : text;

  return afterMarker
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: MoltbotConfig | undefined,
  agentId?: string,
): string {
  let result = text;
  const providerId = ctx.Provider ? normalizeChannelId(ctx.Provider) : null;
  const providerMentions = providerId ? getChannelDock(providerId)?.mentions : undefined;
  const patterns = normalizeMentionPatterns([
    ...resolveMentionPatterns(cfg, agentId),
    ...(providerMentions?.stripPatterns?.({ ctx, cfg, agentId }) ?? []),
  ]);
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "gi");
      result = result.replace(re, " ");
    } catch {
      // ignore invalid regex
    }
  }
  if (providerMentions?.stripMentions) {
    result = providerMentions.stripMentions({
      text: result,
      ctx,
      cfg,
      agentId,
    });
  }
  // Generic mention patterns like @123456789 or plain digits
  result = result.replace(/@[0-9+]{5,}/g, " ");
  return result.replace(/\s+/g, " ").trim();
}
