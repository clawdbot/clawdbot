import { isAllowedParsedChatSender } from "openclaw/plugin-sdk/allow-from";
import {
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  type ParsedChatTarget,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
} from "openclaw/plugin-sdk/channel-targets";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";

export type BlueBubblesService = "imessage" | "sms" | "auto";

export type BlueBubblesTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string; service: BlueBubblesService };

export type BlueBubblesAllowTarget = ParsedChatTarget | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: BlueBubblesService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];
const CHAT_IDENTIFIER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_IDENTIFIER_HEX_RE = /^[0-9a-f]{24,64}$/i;

function parseRawChatGuid(value: string): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(";");
  if (parts.length !== 3) {
    return null;
  }
  const service = normalizeOptionalString(parts[0]);
  const separator = normalizeOptionalString(parts[1]);
  const identifier = normalizeOptionalString(parts[2]);
  if (!service || !identifier) {
    return null;
  }
  if (separator !== "+" && separator !== "-") {
    return null;
  }
  return `${service};${separator};${identifier}`;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function stripBlueBubblesPrefix(value: string): string {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return "";
  }
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("bluebubbles:")) {
    return trimmed;
  }
  return trimmed.slice("bluebubbles:".length).trim();
}

function looksLikeRawChatIdentifier(value: string): boolean {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return false;
  }
  if (/^chat\d+$/i.test(trimmed)) {
    return true;
  }
  return CHAT_IDENTIFIER_UUID_RE.test(trimmed) || CHAT_IDENTIFIER_HEX_RE.test(trimmed);
}

function parseGroupTarget(params: {
  trimmed: string;
  lower: string;
  requireValue: boolean;
}): { kind: "chat_id"; chatId: number } | { kind: "chat_guid"; chatGuid: string } | null {
  if (!params.lower.startsWith("group:")) {
    return null;
  }
  const value = stripPrefix(params.trimmed, "group:");
  const chatId = Number.parseInt(value, 10);
  if (Number.isFinite(chatId)) {
    return { kind: "chat_id", chatId };
  }
  if (value) {
    return { kind: "chat_guid", chatGuid: value };
  }
  if (params.requireValue) {
    throw new Error("group target is required");
  }
  return null;
}

function parseRawChatIdentifierTarget(
  trimmed: string,
): { kind: "chat_identifier"; chatIdentifier: string } | null {
  if (/^chat\d+$/i.test(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  if (looksLikeRawChatIdentifier(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  return null;
}

export function normalizeBlueBubblesHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("imessage:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(9));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(4));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(5));
  }
  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  return trimmed.replace(/\s+/g, "");
}

/**
 * Extracts the handle from a chat_guid if it's a DM (1:1 chat).
 * BlueBubbles chat_guid format for DM: "service;-;handle" (e.g., "iMessage;-;+19257864429")
 * Group chat format: "service;+;groupId" (has "+" instead of "-")
 */
export function extractHandleFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  // DM format: service;-;handle (3 parts, middle is "-")
  if (parts.length === 3 && parts[1] === "-") {
    const handle = normalizeOptionalString(parts[2]);
    if (handle) {
      return normalizeBlueBubblesHandle(handle);
    }
  }
  return null;
}

export function normalizeBlueBubblesMessagingTarget(raw: string): string | undefined {
  let trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  trimmed = stripBlueBubblesPrefix(trimmed);
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = parseBlueBubblesTarget(trimmed);
    if (parsed.kind === "chat_id") {
      return `chat_id:${parsed.chatId}`;
    }
    if (parsed.kind === "chat_guid") {
      // For DM chat_guids, normalize to just the handle for easier comparison.
      // This allows "chat_guid:iMessage;-;+1234567890" to match "+1234567890".
      const handle = extractHandleFromChatGuid(parsed.chatGuid);
      if (handle) {
        return handle;
      }
      // For group chats or unrecognized formats, keep the full chat_guid
      return `chat_guid:${parsed.chatGuid}`;
    }
    if (parsed.kind === "chat_identifier") {
      return `chat_identifier:${parsed.chatIdentifier}`;
    }
    const handle = normalizeBlueBubblesHandle(parsed.to);
    if (!handle) {
      return undefined;
    }
    return parsed.service === "auto" ? handle : `${parsed.service}:${handle}`;
  } catch {
    return trimmed;
  }
}

export function looksLikeBlueBubblesTargetId(raw: string, normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = stripBlueBubblesPrefix(trimmed);
  if (!candidate) {
    return false;
  }
  if (parseRawChatGuid(candidate)) {
    return true;
  }
  const lowered = normalizeLowercaseStringOrEmpty(candidate);
  if (/^(imessage|sms|auto):/.test(lowered)) {
    return true;
  }
  if (
    /^(chat_id|chatid|chat|chat_guid|chatguid|guid|chat_identifier|chatidentifier|chatident|group):/.test(
      lowered,
    )
  ) {
    return true;
  }
  // Recognize chat<digits> patterns (e.g., "chat660250192681427962") as chat IDs
  if (/^chat\d+$/i.test(candidate)) {
    return true;
  }
  if (looksLikeRawChatIdentifier(candidate)) {
    return true;
  }
  if (candidate.includes("@")) {
    return true;
  }
  const digitsOnly = candidate.replace(/[\s().-]/g, "");
  if (/^\+?\d{3,}$/.test(digitsOnly)) {
    return true;
  }
  if (normalized) {
    const normalizedTrimmed = normalizeOptionalString(normalized);
    if (!normalizedTrimmed) {
      return false;
    }
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalizedTrimmed);
    if (
      /^(imessage|sms|auto):/.test(normalizedLower) ||
      /^(chat_id|chat_guid|chat_identifier):/.test(normalizedLower)
    ) {
      return true;
    }
  }
  return false;
}

export function looksLikeBlueBubblesExplicitTargetId(raw: string, normalized?: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const candidate = stripBlueBubblesPrefix(trimmed);
  if (!candidate) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(candidate);
  if (/^(imessage|sms|auto):/.test(lowered)) {
    return true;
  }
  if (
    /^(chat_id|chatid|chat|chat_guid|chatguid|guid|chat_identifier|chatidentifier|chatident|group):/.test(
      lowered,
    )
  ) {
    return true;
  }
  if (parseRawChatGuid(candidate) || looksLikeRawChatIdentifier(candidate)) {
    return true;
  }
  if (normalized) {
    const normalizedTrimmed = normalized.trim();
    if (!normalizedTrimmed) {
      return false;
    }
    const normalizedLower = normalizeLowercaseStringOrEmpty(normalizedTrimmed);
    if (
      /^(imessage|sms|auto):/.test(normalizedLower) ||
      /^(chat_id|chat_guid|chat_identifier):/.test(normalizedLower)
    ) {
      return true;
    }
  }
  return false;
}

export function inferBlueBubblesTargetChatType(raw: string): "direct" | "group" | undefined {
  try {
    const parsed = parseBlueBubblesTarget(raw);
    if (parsed.kind === "handle") {
      return "direct";
    }
    if (parsed.kind === "chat_guid") {
      return parsed.chatGuid.includes(";+;") ? "group" : "direct";
    }
    if (parsed.kind === "chat_id" || parsed.kind === "chat_identifier") {
      return "group";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function parseBlueBubblesTarget(raw: string): BlueBubblesTarget {
  const trimmed = stripBlueBubblesPrefix(raw);
  if (!trimmed) {
    throw new Error("BlueBubbles target is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    isChatTarget: (remainderLower) =>
      CHAT_ID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      CHAT_GUID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      CHAT_IDENTIFIER_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      remainderLower.startsWith("group:"),
    parseTarget: parseBlueBubblesTarget,
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

  const groupTarget = parseGroupTarget({ trimmed, lower, requireValue: true });
  if (groupTarget) {
    return groupTarget;
  }

  const rawChatGuid = parseRawChatGuid(trimmed);
  if (rawChatGuid) {
    return { kind: "chat_guid", chatGuid: rawChatGuid };
  }

  const rawChatIdentifierTarget = parseRawChatIdentifierTarget(trimmed);
  if (rawChatIdentifierTarget) {
    return rawChatIdentifierTarget;
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function parseBlueBubblesAllowTarget(raw: string): BlueBubblesAllowTarget {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return { kind: "handle", handle: "" };
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedAllowTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    parseAllowTarget: parseBlueBubblesAllowTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  const chatTarget = parseChatAllowTargetPrefixes({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
  });
  if (chatTarget) {
    return chatTarget;
  }

  const groupTarget = parseGroupTarget({ trimmed, lower, requireValue: false });
  if (groupTarget) {
    return groupTarget;
  }

  const rawChatIdentifierTarget = parseRawChatIdentifierTarget(trimmed);
  if (rawChatIdentifierTarget) {
    return rawChatIdentifierTarget;
  }

  return { kind: "handle", handle: normalizeBlueBubblesHandle(trimmed) };
}

export function isAllowedBlueBubblesSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): boolean {
  return isAllowedParsedChatSender({
    allowFrom: params.allowFrom,
    sender: params.sender,
    chatId: params.chatId,
    chatGuid: params.chatGuid,
    chatIdentifier: params.chatIdentifier,
    normalizeSender: normalizeBlueBubblesHandle,
    parseAllowTarget: parseBlueBubblesAllowTarget,
  });
}

export function formatBlueBubblesChatTarget(params: {
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string {
  if (params.chatId && Number.isFinite(params.chatId)) {
    return `chat_id:${params.chatId}`;
  }
  const guid = normalizeOptionalString(params.chatGuid);
  if (guid) {
    return `chat_guid:${guid}`;
  }
  const identifier = normalizeOptionalString(params.chatIdentifier);
  if (identifier) {
    return `chat_identifier:${identifier}`;
  }
  return "";
}
