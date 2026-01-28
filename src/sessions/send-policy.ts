import type { MoltbotConfig } from "../config/config.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import { normalizeChatType } from "../channels/chat-type.js";

export type SessionSendPolicyDecision = "allow" | "deny";

export function normalizeSendPolicy(raw?: string | null): SessionSendPolicyDecision | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === "allow") return "allow";
  if (value === "deny") return "deny";
  return undefined;
}

function normalizeMatchValue(raw?: string | null) {
  const value = raw?.trim().toLowerCase();
  return value ? value : undefined;
}

function deriveChannelFromKey(key?: string) {
  if (!key) return undefined;
  const parts = key.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    return normalizeMatchValue(parts[0]);
  }
  return undefined;
}

function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  if (!key) return undefined;
  if (key.includes(":group:")) return "group";
  if (key.includes(":channel:")) return "channel";
  return undefined;
}

export function resolveSendPolicy(params: {
  cfg: MoltbotConfig;
  entry?: SessionEntry;
  sessionKey?: string;
  channel?: string;
  chatType?: SessionChatType;
}): SessionSendPolicyDecision {
  const override = normalizeSendPolicy(params.entry?.sendPolicy);
  if (override) return override;

  const policy = params.cfg.session?.sendPolicy;
  if (!policy) return "allow";

  const channel =
    normalizeMatchValue(params.channel) ??
    normalizeMatchValue(params.entry?.channel) ??
    normalizeMatchValue(params.entry?.lastChannel) ??
    deriveChannelFromKey(params.sessionKey);
  const chatType =
    normalizeChatType(params.chatType ?? params.entry?.chatType) ??
    normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
  const sessionKey = params.sessionKey ?? "";

  let allowedMatch = false;
  for (const rule of policy.rules ?? []) {
    if (!rule) continue;
    const action = normalizeSendPolicy(rule.action) ?? "allow";
    const match = rule.match ?? {};
    const matchChannel = normalizeMatchValue(match.channel);
    const matchChatType = normalizeChatType(match.chatType);
    const matchPrefix = normalizeMatchValue(match.keyPrefix);

    if (matchChannel && matchChannel !== channel) continue;
    if (matchChatType && matchChatType !== chatType) continue;
    if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
    if (action === "deny") return "deny";
    allowedMatch = true;
  }

  if (allowedMatch) return "allow";

  const fallback = normalizeSendPolicy(policy.default);
  return fallback ?? "allow";
}
