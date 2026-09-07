import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Irc helper module supports normalize behavior.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { hasIrcControlChars } from "./control-chars.js";
import type { IrcInboundMessage } from "./types.js";

const IRC_TARGET_PATTERN = /^[^\s:]+$/u;

export function isChannelTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("&");
}

export function normalizeIrcMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  let target = trimmed;
  const lowered = normalizeLowercaseStringOrEmpty(target);
  if (lowered.startsWith("irc:")) {
    target = target.slice("irc:".length).trim();
  }
  if (normalizeLowercaseStringOrEmpty(target).startsWith("channel:")) {
    target = target.slice("channel:".length).trim();
    if (!target.startsWith("#") && !target.startsWith("&")) {
      target = `#${target}`;
    }
  }
  if (normalizeLowercaseStringOrEmpty(target).startsWith("user:")) {
    target = target.slice("user:".length).trim();
  }
  if (!target || !looksLikeIrcTargetId(target)) {
    return undefined;
  }
  return target;
}

export function resolveIrcOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const target = normalizeIrcMessagingTarget(params.target);
  if (!target) {
    return null;
  }
  const chatType = isChannelTarget(target) ? "group" : "direct";
  // Server-specific casemapping and nick changes mean the outbound spelling is
  // not a stable inbound peer identity, even when delivery succeeds.
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "irc",
    accountId: params.accountId,
    recipientSessionExact: chatType === "direct" ? "direct-alias" : false,
    peer: { kind: chatType, id: target },
    chatType,
    from: `irc:${target}`,
    to: target,
  });
}

export function looksLikeIrcTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (hasIrcControlChars(trimmed)) {
    return false;
  }
  return IRC_TARGET_PATTERN.test(trimmed);
}

export function normalizeIrcAllowEntry(raw: string): string {
  let value = normalizeLowercaseStringOrEmpty(raw);
  if (!value) {
    return "";
  }
  if (value.startsWith("irc:")) {
    value = value.slice("irc:".length);
  }
  if (value.startsWith("user:")) {
    value = value.slice("user:".length);
  }
  return value.trim();
}

export function buildIrcAllowlistCandidates(
  message: IrcInboundMessage,
  params?: { allowNameMatching?: boolean },
): string[] {
  const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
  const user = normalizeOptionalLowercaseString(message.senderUser);
  const host = normalizeOptionalLowercaseString(message.senderHost);
  const candidates = new Set<string>();
  if (nick && params?.allowNameMatching === true) {
    candidates.add(nick);
  }
  if (nick && user) {
    candidates.add(`${nick}!${user}`);
  }
  if (nick && host) {
    candidates.add(`${nick}@${host}`);
  }
  if (nick && user && host) {
    candidates.add(`${nick}!${user}@${host}`);
  }
  return [...candidates];
}
