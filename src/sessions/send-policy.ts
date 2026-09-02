// Session send policy helpers decide when session output can be sent to targets.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionDeliveryChannel } from "../utils/delivery-context.shared.js";
import {
  hasAmbiguousCanonicalSessionPeerShape,
  parseCanonicalSessionPeerShape,
} from "./session-chat-type-shared.js";
import { deriveSessionChatType } from "./session-chat-type.js";

/** Session send-policy decision after config and per-session overrides are evaluated. */
export type SessionSendPolicyDecision = "allow" | "deny";

/** Normalizes raw send-policy text into a decision. */
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
  const parts = key.split(":");
  // Canonical agent session keys: agent:<agentId>:<sessionKey...>
  if (parts[0] === "agent") {
    if (parts.length < 3 || !parts[1] || !parts[2]) {
      return undefined;
    }
    return parts.slice(2).join(":");
  }
  return key;
}

function deriveChannelFromKey(key?: string) {
  const normalizedKey = stripAgentSessionKeyPrefix(key);
  if (!normalizedKey) {
    return undefined;
  }
  return normalizeMatchValue(parseCanonicalSessionPeerShape(normalizedKey)?.channel);
}

function deriveChatTypeFromKey(key?: string): SessionChatType | undefined {
  const normalizedKey = normalizeOptionalLowercaseString(stripAgentSessionKeyPrefix(key));
  if (!normalizedKey || normalizedKey.startsWith("agent:")) {
    return undefined;
  }
  const derived = deriveSessionChatType(normalizedKey);
  if (derived !== "unknown") {
    return derived;
  }
  return undefined;
}

function hasAmbiguousPeerShape(key?: string): boolean {
  const normalizedKey = normalizeOptionalLowercaseString(stripAgentSessionKeyPrefix(key));
  return normalizedKey ? hasAmbiguousCanonicalSessionPeerShape(normalizedKey) : false;
}

/** Resolves whether a session send is allowed by entry override and config rules. */
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
  // The legacy key grammar cannot distinguish a peer-kind-shaped account id
  // from a channel peer. Never let that ambiguity satisfy an allow policy.
  if (hasAmbiguousPeerShape(params.sessionKey)) {
    return "deny";
  }

  const rawSessionKey = params.sessionKey ?? "";
  const strippedSessionKey = stripAgentSessionKeyPrefix(rawSessionKey) ?? "";
  const rawSessionKeyNorm = normalizeLowercaseStringOrEmpty(rawSessionKey);
  const strippedSessionKeyNorm = normalizeLowercaseStringOrEmpty(strippedSessionKey);
  let channel: string | undefined;
  let chatType: SessionChatType | undefined;
  const getChannel = () => {
    channel ??=
      normalizeMatchValue(params.channel) ??
      normalizeMatchValue(sessionDeliveryChannel(params.entry)) ??
      deriveChannelFromKey(params.sessionKey);
    return channel;
  };
  const getChatType = () => {
    chatType ??=
      normalizeChatType(params.chatType ?? params.entry?.chatType) ??
      normalizeChatType(deriveChatTypeFromKey(params.sessionKey));
    return chatType;
  };

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

    if (matchChannel && matchChannel !== getChannel()) {
      continue;
    }
    if (matchChatType && matchChatType !== getChatType()) {
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
