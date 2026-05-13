import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  type ChatSenderAllowParams,
  createAllowedChatSenderMatcher,
  type ParsedChatTarget,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
} from "./target-parsing-helpers.js";

export type IMessageService = "imessage" | "sms" | "auto";

export type IMessageTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string; service: IMessageService };

export type IMessageAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: IMessageService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];

export function normalizeIMessageHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("imessage:")) {
    return normalizeIMessageHandle(trimmed.slice(9));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeIMessageHandle(trimmed.slice(4));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeIMessageHandle(trimmed.slice(5));
  }

  // Normalize chat_id/chat_guid/chat_identifier prefixes case-insensitively
  for (const prefix of CHAT_ID_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return `chat_id:${value}`;
    }
  }
  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return `chat_guid:${value}`;
    }
  }
  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      const value = trimmed.slice(prefix.length).trim();
      return `chat_identifier:${value}`;
    }
  }

  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  const normalized = normalizeE164(trimmed);
  if (normalized) {
    return normalized;
  }
  return trimmed.replace(/\s+/g, "");
}

export function parseIMessageTarget(raw: string): IMessageTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("iMessage target is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedChatTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
    parseTarget: parseIMessageTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  const chatTarget = parseChatTargetPrefixesOrThrow({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
  });
  if (chatTarget) {
    return chatTarget;
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function looksLikeIMessageExplicitTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (/^(imessage:|sms:|auto:)/.test(lower)) {
    return true;
  }
  return (
    CHAT_ID_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    CHAT_GUID_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    CHAT_IDENTIFIER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

export function inferIMessageTargetChatType(raw: string): "direct" | "group" | undefined {
  try {
    const parsed = parseIMessageTarget(raw);
    if (parsed.kind === "handle") {
      return "direct";
    }
    return "group";
  } catch {
    return undefined;
  }
}

export function parseIMessageAllowTarget(raw: string): IMessageAllowTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "handle", handle: "" };
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedOrChatAllowTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    parseAllowTarget: parseIMessageAllowTarget,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  return { kind: "handle", handle: normalizeIMessageHandle(trimmed) };
}

const isAllowedIMessageSenderMatcher = createAllowedChatSenderMatcher({
  normalizeSender: normalizeIMessageHandle,
  parseAllowTarget: parseIMessageAllowTarget,
  allowConversationTargets: false,
});

export function isAllowedIMessageSender(params: ChatSenderAllowParams): boolean {
  return isAllowedIMessageSenderMatcher({ ...params, allowConversationTargets: false });
}

const isAllowedIMessageReplyContextSenderMatcher = createAllowedChatSenderMatcher({
  normalizeSender: normalizeIMessageHandle,
  parseAllowTarget: parseIMessageAllowTarget,
  allowConversationTargets: true,
});

export function isAllowedIMessageReplyContextSender(params: ChatSenderAllowParams): boolean {
  return isAllowedIMessageReplyContextSenderMatcher(params);
}

export function formatIMessageChatTarget(chatId?: number | null): string {
  if (!chatId || !Number.isFinite(chatId)) {
    return "";
  }
  return `chat_id:${chatId}`;
}
