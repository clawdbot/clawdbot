import { normalizeChatType } from "../channels/chat-type.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

export type SessionSendPolicyDecision = "allow" | "deny";

export function normalizeSendPolicy(raw?: string | null): SessionSendPolicyDecision | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (value === "allow") {
    return "allow";
  }
  if (value === "deny") {
    return "deny";
  }
  return undefined;
}

function normalizeMatchValue(raw?: string | null) {
  const value = normalizeOptionalLowercaseString(raw);
  return value ? value : undefined;
}

function stripAgentSessionKeyPrefix(key?: string): string | undefined {
  if (!key) {
    return undefined;
  }
  const parts = key.split(":").filter(Boolean);
  // Canonical agent session keys: agent:<agentId>:<sessionKey...>
  if (parts.length >= 3 && parts[0] === "agent") {
    return parts.slice(2).join(":");
  }
  return key;
}

function deriveChannelFromKey(key?: string) {
  const normalizedKey = stripAgentSessionKeyPrefix(key);
  if (!normalizedKey) {
    return undefined;
  }
  const parts = normalizedKey.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  const normalizedKey = normalizeOptionalLowercaseString(stripAgentSessionKeyPrefix(key));
  if (!normalizedKey) {
    return undefined;
  }
  const tokens = new Set(normalizedKey.split(":").filter(Boolean));
  if (tokens.has("group")) {
    return "group";
  }
  if (tokens.has("channel")) {
    return "channel";
  }
  if (tokens.has("direct") || tokens.has("dm")) {
    return "direct";
  }
  if (/^group:[^:]+$/u.test(normalizedKey)) {
    return "group";
  }
  if (/^[0-9]+(?:-[0-9]+)*@g\.us$/u.test(normalizedKey)) {
    return "group";
  }
  if (/^whatsapp:(?!.*:group:).+@g\.us$/u.test(normalizedKey)) {
    return "group";
  }
  if (/^discord:(?:[^:]+:)?guild-[^:]+:channel-[^:]+$/u.test(normalizedKey)) {
    return "channel";
  }
  return undefined;
}

export function resolveSendPolicy(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
}): SessionSendPolicyDecision {
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) {
    return override;
  }

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) {
    return "allow";
  }

  const channel =
    normalizeMatchValue(params.channel) ??
    normalizeMatchValue(params.entry?.channel) ??
    normalizeMatchValue(params.entry?.lastChannel) ??
    deriveChannelFromKey(params.sessionKey);
  const chatType =
    normalizeChatType(params.chatType ?? params.entry?.chatType) ??
    normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = normalizeLowercaseStringOrEmpty(rawSessionKey);
  const strippedSessionKeyNorm = normalizeLowercaseStringOrEmpty(strippedSessionKey);

  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    if (!rule) {
      continue;
    }
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchChannel = normalizeMatchValue(match.channel);
    const matchChatType = normalizeChatType(match.chatType);
    const matchPrefix = normalizeMatchValue(match.keyPrefix);
    const matchRawPrefix = normalizeMatchValue(match.rawKeyPrefix);

    if (matchChannel && matchChannel !== channel) {
      continue;
    }
    if (matchChatType && matchChatType !== chatType) {
      continue;
    }
    if (matchRawPrefix && !rawSessionKeyNorm.startsWith(matchRawPrefix)) {
      continue;
    }
    if (
      matchPrefix &&
      !rawSessionKeyNorm.startsWith(matchPrefix) &&
      !strippedSessionKeyNorm.startsWith(matchPrefix)
    ) {
      continue;
    }
    if (action === "deny") {
      return "deny";
    }
    allowedMatch = true;
  }

  if (allowedMatch) {
    return "allow";
  }

  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
