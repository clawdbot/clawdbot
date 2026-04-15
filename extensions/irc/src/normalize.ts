import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/text-runtime";
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

export function normalizeIrcAllowlist(entries?: Array<string | number>): string[] {
  return (entries ?? []).map((entry) => normalizeIrcAllowEntry(String(entry))).filter(Boolean);
}

export function formatIrcSenderId(message: IrcInboundMessage): string {
  const base = message.senderNick.trim();
  const user = message.senderUser?.trim();
  const host = message.senderHost?.trim();
  if (user && host) {
    return `${base}!${user}@${host}`;
  }
  if (user) {
    return `${base}!${user}`;
  }
  if (host) {
    return `${base}@${host}`;
  }
  return base;
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

export function resolveIrcAllowlistMatch(params: {
  allowFrom: string[];
  message: IrcInboundMessage;
  allowNameMatching?: boolean;
}): { allowed: boolean; source?: string } {
  const allowFrom = new Set(params.allowFrom.map(normalizeLowercaseStringOrEmpty).filter(Boolean));
  if (allowFrom.has("*")) {
    return { allowed: true, source: "wildcard" };
  }
  const candidates = buildIrcAllowlistCandidates(params.message, {
    allowNameMatching: params.allowNameMatching,
  });
  for (const candidate of candidates) {
    if (allowFrom.has(candidate)) {
      return { allowed: true, source: candidate };
    }
  }
  return { allowed: false };
}
