export type BlueBubblesService = "imessage" | "sms" | "auto";

export type BlueBubblesTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; to: string; service: BlueBubblesService };

export type BlueBubblesAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: BlueBubblesService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

export function normalizeBlueBubblesHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("imessage:")) return normalizeBlueBubblesHandle(trimmed.slice(9));
  if (lowered.startsWith("sms:")) return normalizeBlueBubblesHandle(trimmed.slice(4));
  if (lowered.startsWith("auto:")) return normalizeBlueBubblesHandle(trimmed.slice(5));
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  return trimmed.replace(/\s+/g, "");
}

export function parseBlueBubblesTarget(raw: string): BlueBubblesTarget {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("BlueBubbles target is required");
  const lower = trimmed.toLowerCase();

  for (const { prefix, service } of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = stripPrefix(trimmed, prefix);
      if (!remainder) throw new Error(`${prefix} target is required`);
      const remainderLower = remainder.toLowerCase();
      const isChatTarget =
        CHAT_ID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        CHAT_GUID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        CHAT_IDENTIFIER_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
        remainderLower.startsWith("group:");
      if (isChatTarget) {
        return parseBlueBubblesTarget(remainder);
      }
      return { kind: "handle", to: remainder, service };
    }
  }

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (!Number.isFinite(chatId)) {
        throw new Error(`Invalid chat_id: ${value}`);
      }
      return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_guid is required");
      return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (!value) throw new Error("chat_identifier is required");
      return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) {
      return { kind: "chat_id", chatId };
    }
    if (!value) throw new Error("group target is required");
    return { kind: "chat_guid", chatGuid: value };
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function parseBlueBubblesAllowTarget(raw: string): BlueBubblesAllowTarget {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "handle", handle: "" };
  const lower = trimmed.toLowerCase();

  for (const { prefix } of SERVICE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = stripPrefix(trimmed, prefix);
      if (!remainder) return { kind: "handle", handle: "" };
      return parseBlueBubblesAllowTarget(remainder);
    }
  }

  for (const prefix of CHAT_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      const chatId = Number.parseInt(value, 10);
      if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    }
  }

  for (const prefix of CHAT_GUID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_guid", chatGuid: value };
    }
  }

  for (const prefix of CHAT_IDENTIFIER_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const value = stripPrefix(trimmed, prefix);
      if (value) return { kind: "chat_identifier", chatIdentifier: value };
    }
  }

  if (lower.startsWith("group:")) {
    const value = stripPrefix(trimmed, "group:");
    const chatId = Number.parseInt(value, 10);
    if (Number.isFinite(chatId)) return { kind: "chat_id", chatId };
    if (value) return { kind: "chat_guid", chatGuid: value };
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
  const allowFrom = params.allowFrom.map((entry) => String(entry).trim());
  if (allowFrom.length === 0) return true;
  if (allowFrom.includes("*")) return true;

  const senderNormalized = normalizeBlueBubblesHandle(params.sender);
  const chatId = params.chatId ?? undefined;
  const chatGuid = params.chatGuid?.trim();
  const chatIdentifier = params.chatIdentifier?.trim();

  for (const entry of allowFrom) {
    if (!entry) continue;
    const parsed = parseBlueBubblesAllowTarget(entry);
    if (parsed.kind === "chat_id" && chatId !== undefined) {
      if (parsed.chatId === chatId) return true;
    } else if (parsed.kind === "chat_guid" && chatGuid) {
      if (parsed.chatGuid === chatGuid) return true;
    } else if (parsed.kind === "chat_identifier" && chatIdentifier) {
      if (parsed.chatIdentifier === chatIdentifier) return true;
    } else if (parsed.kind === "handle" && senderNormalized) {
      if (parsed.handle === senderNormalized) return true;
    }
  }
  return false;
}

export function formatBlueBubblesChatTarget(params: {
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
}): string {
  if (params.chatId && Number.isFinite(params.chatId)) {
    return `chat_id:${params.chatId}`;
  }
  const guid = params.chatGuid?.trim();
  if (guid) return `chat_guid:${guid}`;
  const identifier = params.chatIdentifier?.trim();
  if (identifier) return `chat_identifier:${identifier}`;
  return "";
}
