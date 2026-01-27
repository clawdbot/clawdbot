import crypto from "node:crypto";

import { resolveBlueBubblesAccount } from "./accounts.js";
import {
  extractHandleFromChatGuid,
  normalizeBlueBubblesHandle,
  parseBlueBubblesTarget,
} from "./targets.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesSendTarget,
} from "./types.js";

export type BlueBubblesSendOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: MoltbotConfig;
  /** Message GUID to reply to (reply threading) */
  replyToMessageGuid?: string;
  /** Part index for reply (default: 0) */
  replyToPartIndex?: number;
  /** Effect ID or short name for message effects (e.g., "slam", "balloons") */
  effectId?: string;
};

export type BlueBubblesSendResult = {
  messageId: string;
};

/** Maps short effect names to full Apple effect IDs */
const EFFECT_MAP: Record<string, string> = {
  // Bubble effects
  slam: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
  invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible-ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  "invisible ink": "com.apple.MobileSMS.expressivesend.invisibleink",
  invisibleink: "com.apple.MobileSMS.expressivesend.invisibleink",
  // Screen effects
  echo: "com.apple.messages.effect.CKEchoEffect",
  spotlight: "com.apple.messages.effect.CKSpotlightEffect",
  balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  love: "com.apple.messages.effect.CKHeartEffect",
  heart: "com.apple.messages.effect.CKHeartEffect",
  hearts: "com.apple.messages.effect.CKHeartEffect",
  lasers: "com.apple.messages.effect.CKLasersEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  celebration: "com.apple.messages.effect.CKSparklesEffect",
};

function resolveEffectId(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (EFFECT_MAP[trimmed]) return EFFECT_MAP[trimmed];
  const normalized = trimmed.replace(/[\s_]+/g, "-");
  if (EFFECT_MAP[normalized]) return EFFECT_MAP[normalized];
  const compact = trimmed.replace(/[\s_-]+/g, "");
  if (EFFECT_MAP[compact]) return EFFECT_MAP[compact];
  return raw;
}

function resolveSendTarget(raw: string): BlueBubblesSendTarget {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "handle") {
    return {
      kind: "handle",
      address: normalizeBlueBubblesHandle(parsed.to),
      service: parsed.service,
    };
  }
  if (parsed.kind === "chat_id") {
    return { kind: "chat_id", chatId: parsed.chatId };
  }
  if (parsed.kind === "chat_guid") {
    return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  }
  return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
}

function extractMessageId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const record = payload as Record<string, unknown>;
  const data =
    record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const candidates = [
    record.messageId,
    record.messageGuid,
    record.message_guid,
    record.guid,
    record.id,
    data?.messageId,
    data?.messageGuid,
    data?.message_guid,
    data?.message_id,
    data?.guid,
    data?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "unknown";
}

type BlueBubblesChatRecord = Record<string, unknown>;

function extractChatGuid(chat: BlueBubblesChatRecord): string | null {
  const candidates = [
    chat.chatGuid,
    chat.guid,
    chat.chat_guid,
    chat.identifier,
    chat.chatIdentifier,
    chat.chat_identifier,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractChatId(chat: BlueBubblesChatRecord): number | null {
  const candidates = [chat.chatId, chat.id, chat.chat_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function extractChatIdentifierFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length < 3) return null;
  const identifier = parts[2]?.trim();
  return identifier ? identifier : null;
}

function extractParticipantAddresses(chat: BlueBubblesChatRecord): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const candidate =
        (typeof record.address === "string" && record.address) ||
        (typeof record.handle === "string" && record.handle) ||
        (typeof record.id === "string" && record.id) ||
        (typeof record.identifier === "string" && record.identifier);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

async function queryChats(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  offset: number;
  limit: number;
}): Promise<BlueBubblesChatRecord[]> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/query",
    password: params.password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: params.limit,
        offset: params.offset,
        with: ["participants"],
      }),
    },
    params.timeoutMs,
  );
  if (!res.ok) return [];
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = payload && typeof payload.data !== "undefined" ? (payload.data as unknown) : null;
  return Array.isArray(data) ? (data as BlueBubblesChatRecord[]) : [];
}

export async function resolveChatGuidForTarget(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  target: BlueBubblesSendTarget;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") return params.target.chatGuid;

  const normalizedHandle =
    params.target.kind === "handle" ? normalizeBlueBubblesHandle(params.target.address) : "";
  const targetChatId = params.target.kind === "chat_id" ? params.target.chatId : null;
  const targetChatIdentifier =
    params.target.kind === "chat_identifier" ? params.target.chatIdentifier : null;

  const limit = 500;
  let participantMatch: string | null = null;
  for (let offset = 0; offset < 5000; offset += limit) {
    const chats = await queryChats({
      baseUrl: params.baseUrl,
      password: params.password,
      timeoutMs: params.timeoutMs,
      offset,
      limit,
    });
    if (chats.length === 0) break;
    for (const chat of chats) {
      if (targetChatId != null) {
        const chatId = extractChatId(chat);
        if (chatId != null && chatId === targetChatId) {
          return extractChatGuid(chat);
        }
      }
      if (targetChatIdentifier) {
        const guid = extractChatGuid(chat);
        if (guid) {
          // Back-compat: some callers might pass a full chat GUID.
          if (guid === targetChatIdentifier) return guid;

          // Primary match: BlueBubbles `chat_identifier:*` targets correspond to the
          // third component of the chat GUID: `service;(+|-) ;identifier`.
          const guidIdentifier = extractChatIdentifierFromChatGuid(guid);
          if (guidIdentifier && guidIdentifier === targetChatIdentifier) return guid;
        }

        const identifier =
          typeof chat.identifier === "string"
            ? chat.identifier
            : typeof chat.chatIdentifier === "string"
              ? chat.chatIdentifier
              : typeof chat.chat_identifier === "string"
                ? chat.chat_identifier
                : "";
        if (identifier && identifier === targetChatIdentifier) return guid ?? extractChatGuid(chat);
      }
      if (normalizedHandle) {
        const guid = extractChatGuid(chat);
        const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
        if (directHandle && directHandle === normalizedHandle) {
          return guid;
        }
        if (!participantMatch && guid) {
          // Only consider DM chats (`;-;` separator) as participant matches.
          // Group chats (`;+;` separator) should never match when searching by handle/phone.
          // This prevents routing "send to +1234567890" to a group chat that contains that number.
          const isDmChat = guid.includes(";-;");
          if (isDmChat) {
            const participants = extractParticipantAddresses(chat).map((entry) =>
              normalizeBlueBubblesHandle(entry),
            );
            if (participants.includes(normalizedHandle)) {
              participantMatch = guid;
            }
          }
        }
      }
    }
  }
  return participantMatch;
}

/**
 * Creates a new chat (DM) and optionally sends an initial message.
 * Requires Private API to be enabled in BlueBubbles.
 */
async function createNewChatWithMessage(params: {
  baseUrl: string;
  password: string;
  address: string;
  message: string;
  timeoutMs?: number;
}): Promise<BlueBubblesSendResult> {
  const url = buildBlueBubblesApiUrl({
    baseUrl: params.baseUrl,
    path: "/api/v1/chat/new",
    password: params.password,
  });
  const payload = {
    addresses: [params.address],
    message: params.message,
  };
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    params.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text();
    // Check for Private API not enabled error
    if (res.status === 400 || res.status === 403 || errorText.toLowerCase().includes("private api")) {
      throw new Error(
        `BlueBubbles send failed: Cannot create new chat - Private API must be enabled. Original error: ${errorText || res.status}`,
      );
    }
    throw new Error(`BlueBubbles create chat failed (${res.status}): ${errorText || "unknown"}`);
  }
  const body = await res.text();
  if (!body) return { messageId: "ok" };
  try {
    const parsed = JSON.parse(body) as unknown;
    return { messageId: extractMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}

export async function sendMessageBlueBubbles(
  to: string,
  text: string,
  opts: BlueBubblesSendOpts = {},
): Promise<BlueBubblesSendResult> {
  const trimmedText = text ?? "";
  if (!trimmedText.trim()) {
    throw new Error("BlueBubbles send requires text");
  }

  const account = resolveBlueBubblesAccount({
    cfg: opts.cfg ?? {},
    accountId: opts.accountId,
  });
  const baseUrl = opts.serverUrl?.trim() || account.config.serverUrl?.trim();
  const password = opts.password?.trim() || account.config.password?.trim();
  if (!baseUrl) throw new Error("BlueBubbles serverUrl is required");
  if (!password) throw new Error("BlueBubbles password is required");

  const target = resolveSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
  });
  if (!chatGuid) {
    // If target is a phone number/handle and no existing chat found,
    // auto-create a new DM chat using the /api/v1/chat/new endpoint
    if (target.kind === "handle") {
      return createNewChatWithMessage({
        baseUrl,
        password,
        address: target.address,
        message: trimmedText,
        timeoutMs: opts.timeoutMs,
      });
    }
    throw new Error(
      "BlueBubbles send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
  }
  const effectId = resolveEffectId(opts.effectId);
  const needsPrivateApi = Boolean(opts.replyToMessageGuid || effectId);
  const payload: Record<string, unknown> = {
    chatGuid,
    tempGuid: crypto.randomUUID(),
    message: trimmedText,
  };
  if (needsPrivateApi) {
    payload.method = "private-api";
  }

  // Add reply threading support
  if (opts.replyToMessageGuid) {
    payload.selectedMessageGuid = opts.replyToMessageGuid;
    payload.partIndex = typeof opts.replyToPartIndex === "number" ? opts.replyToPartIndex : 0;
  }

  // Add message effects support
  if (effectId) {
    payload.effectId = effectId;
  }

  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/text",
    password,
  });
  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    opts.timeoutMs,
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles send failed (${res.status}): ${errorText || "unknown"}`);
  }
  const body = await res.text();
  if (!body) return { messageId: "ok" };
  try {
    const parsed = JSON.parse(body) as unknown;
    return { messageId: extractMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}
