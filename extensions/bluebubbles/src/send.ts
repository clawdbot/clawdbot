import crypto from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { createBlueBubblesClient, createBlueBubblesClientFromParts } from "./client.js";
import {
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
  isMacOS26OrHigher,
} from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { warnBlueBubbles } from "./runtime.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { extractHandleFromChatGuid, normalizeBlueBubblesHandle } from "./targets.js";
import { DEFAULT_SEND_TIMEOUT_MS, type BlueBubblesSendTarget } from "./types.js";

export type BlueBubblesSendOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
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
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  if (EFFECT_MAP[trimmed]) {
    return EFFECT_MAP[trimmed];
  }
  const normalized = trimmed.replace(/[\s_]+/g, "-");
  if (EFFECT_MAP[normalized]) {
    return EFFECT_MAP[normalized];
  }
  const compact = trimmed.replace(/[\s_-]+/g, "");
  if (EFFECT_MAP[compact]) {
    return EFFECT_MAP[compact];
  }
  return raw;
}

type PrivateApiDecision = {
  canUsePrivateApi: boolean;
  throwEffectDisabledError: boolean;
  warningMessage?: string;
};

function resolvePrivateApiDecision(params: {
  privateApiStatus: boolean | null;
  wantsReplyThread: boolean;
  wantsEffect: boolean;
  accountId?: string;
}): PrivateApiDecision {
  const { privateApiStatus, wantsReplyThread, wantsEffect, accountId } = params;
  const needsPrivateApi = wantsReplyThread || wantsEffect;
  // On macOS 26 Tahoe, AppleScript Messages.app automation is broken
  // (`-1700` error) for outbound sends. Prefer Private API even for plain
  // text when it is available so sends still reach the recipient.
  // (#53159 Bug B, #64480)
  const forceOnMacOS26 =
    isMacOS26OrHigher(accountId) && isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
  const canUsePrivateApi =
    (needsPrivateApi || forceOnMacOS26) && isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);
  const throwEffectDisabledError = wantsEffect && privateApiStatus === false;
  if (!needsPrivateApi || privateApiStatus !== null) {
    return { canUsePrivateApi, throwEffectDisabledError };
  }
  const requested = [
    wantsReplyThread ? "reply threading" : null,
    wantsEffect ? "message effects" : null,
  ]
    .filter(Boolean)
    .join(" + ");
  return {
    canUsePrivateApi,
    throwEffectDisabledError,
    warningMessage: `Private API status unknown; sending without ${requested}. Run a status probe to restore private-api features.`,
  };
}

async function parseBlueBubblesMessageResponse(res: Response): Promise<BlueBubblesSendResult> {
  const body = await res.text();
  if (!body) {
    return { messageId: "ok" };
  }
  try {
    const parsed = JSON.parse(body) as unknown;
    return { messageId: extractBlueBubblesMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
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
    const value = normalizeOptionalString(candidate);
    if (value) {
      return value;
    }
  }
  return null;
}

function extractChatId(chat: BlueBubblesChatRecord): number | null {
  const candidates = [chat.chatId, chat.id, chat.chat_id];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function extractChatIdentifierFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length < 3) {
    return null;
  }
  return normalizeOptionalString(parts[2]) ?? null;
}

function extractParticipantAddresses(chat: BlueBubblesChatRecord): string[] {
  const raw =
    (Array.isArray(chat.participants) ? chat.participants : null) ??
    (Array.isArray(chat.handles) ? chat.handles : null) ??
    (Array.isArray(chat.participantHandles) ? chat.participantHandles : null);
  if (!raw) {
    return [];
  }
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
      if (candidate) {
        out.push(candidate);
      }
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
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesChatRecord[]> {
  const client = createBlueBubblesClientFromParts({
    baseUrl: params.baseUrl,
    password: params.password,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    timeoutMs: params.timeoutMs,
  });
  const res = await client.request({
    method: "POST",
    path: "/api/v1/chat/query",
    body: {
      limit: params.limit,
      offset: params.offset,
      with: ["participants"],
    },
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    return [];
  }
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const data = payload && payload.data !== undefined ? (payload.data as unknown) : null;
  return Array.isArray(data) ? (data as BlueBubblesChatRecord[]) : [];
}

export async function resolveChatGuidForTarget(params: {
  baseUrl: string;
  password: string;
  timeoutMs?: number;
  target: BlueBubblesSendTarget;
  allowPrivateNetwork?: boolean;
}): Promise<string | null> {
  if (params.target.kind === "chat_guid") {
    return params.target.chatGuid;
  }

  const normalizedHandle =
    params.target.kind === "handle" ? normalizeBlueBubblesHandle(params.target.address) : "";
  const targetChatId = params.target.kind === "chat_id" ? params.target.chatId : null;
  const targetChatIdentifier =
    params.target.kind === "chat_identifier" ? params.target.chatIdentifier : null;

  const limit = 500;
  // When matching by handle, prefer the caller's requested service. A user may
  // have both an `iMessage;-;<handle>` and `SMS;-;<handle>` chat:
  //   - default / `service: "imessage"` / `service: "auto"` -> prefer iMessage
  //     so we never silently downgrade to SMS when iMessage is available.
  //   - explicit `service: "sms"` (e.g. caller passed `sms:+15551234567`) ->
  //     prefer SMS so explicit SMS intent is respected.
  //
  // A direct `<preferred>;-;<handle>` match is the strongest signal and
  // returns immediately. Everything else is recorded as a ranked fallback.
  const preferredService: "iMessage" | "SMS" =
    params.target.kind === "handle" && params.target.service === "sms" ? "SMS" : "iMessage";
  const preferredPrefix = `${preferredService};-;`;
  const otherPrefix = preferredService === "iMessage" ? "SMS;-;" : "iMessage;-;";

  // Note: a direct `preferredPrefix` match `return`s immediately below, so we
  // only need to remember the other-service and unknown-service direct fallbacks.
  let directHandleOtherServiceMatch: string | null = null;
  let directHandleUnknownServiceMatch: string | null = null;
  let participantPreferredMatch: string | null = null;
  let participantOtherServiceMatch: string | null = null;
  let participantUnknownServiceMatch: string | null = null;
  for (let offset = 0; offset < 5000; offset += limit) {
    const chats = await queryChats({
      baseUrl: params.baseUrl,
      password: params.password,
      timeoutMs: params.timeoutMs,
      offset,
      limit,
      allowPrivateNetwork: params.allowPrivateNetwork,
    });
    if (chats.length === 0) {
      break;
    }
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
          if (guid === targetChatIdentifier) {
            return guid;
          }

          // Primary match: BlueBubbles `chat_identifier:*` targets correspond to the
          // third component of the chat GUID: `service;(+|-) ;identifier`.
          const guidIdentifier = extractChatIdentifierFromChatGuid(guid);
          if (guidIdentifier && guidIdentifier === targetChatIdentifier) {
            return guid;
          }
        }

        const identifier =
          typeof chat.identifier === "string"
            ? chat.identifier
            : typeof chat.chatIdentifier === "string"
              ? chat.chatIdentifier
              : typeof chat.chat_identifier === "string"
                ? chat.chat_identifier
                : "";
        if (identifier && identifier === targetChatIdentifier) {
          return guid ?? extractChatGuid(chat);
        }
      }
      if (normalizedHandle) {
        const guid = extractChatGuid(chat);
        const directHandle = guid ? extractHandleFromChatGuid(guid) : null;
        if (directHandle && directHandle === normalizedHandle && guid) {
          // A direct `<preferredPrefix><handle>` is the strongest signal and we
          // can return immediately. Other services are remembered as fallbacks
          // and we keep scanning in case a preferred-service chat exists later.
          if (guid.startsWith(preferredPrefix)) {
            return guid;
          }
          if (guid.startsWith(otherPrefix)) {
            if (!directHandleOtherServiceMatch) {
              directHandleOtherServiceMatch = guid;
            }
          } else if (!directHandleUnknownServiceMatch) {
            // Unknown service; treat as a last-resort direct match.
            directHandleUnknownServiceMatch = guid;
          }
        }
        if (guid) {
          // Only consider DM chats (`;-;` separator) as participant matches.
          // Group chats (`;+;` separator) should never match when searching by handle/phone.
          // This prevents routing "send to +1234567890" to a group chat that contains that number.
          const isDmChat = guid.includes(";-;");
          if (isDmChat) {
            const participants = extractParticipantAddresses(chat).map((entry) =>
              normalizeBlueBubblesHandle(entry),
            );
            if (participants.includes(normalizedHandle)) {
              if (guid.startsWith(preferredPrefix)) {
                if (!participantPreferredMatch) {
                  participantPreferredMatch = guid;
                }
              } else if (guid.startsWith(otherPrefix)) {
                if (!participantOtherServiceMatch) {
                  participantOtherServiceMatch = guid;
                }
              } else if (!participantUnknownServiceMatch) {
                participantUnknownServiceMatch = guid;
              }
            }
          }
        }
      }
    }
    // We deliberately do NOT break early on participant or non-preferred direct
    // matches: a higher-priority direct `<preferredPrefix><handle>` chat may
    // still exist on a later page, and only that branch can short-circuit.
  }
  return (
    participantPreferredMatch ??
    directHandleOtherServiceMatch ??
    participantOtherServiceMatch ??
    directHandleUnknownServiceMatch ??
    participantUnknownServiceMatch
  );
}

/**
 * Creates a new DM chat for the given address and returns the chat GUID.
 * Requires Private API to be enabled in BlueBubbles.
 *
 * If a `message` is provided it is sent as the initial message in the new chat;
 * otherwise an empty-string message body is used (BlueBubbles still creates the
 * chat but will not deliver a visible bubble).
 */
export async function createChatForHandle(params: {
  baseUrl: string;
  password: string;
  address: string;
  message?: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<{ chatGuid: string | null; messageId: string }> {
  const client = createBlueBubblesClientFromParts({
    baseUrl: params.baseUrl,
    password: params.password,
    allowPrivateNetwork: params.allowPrivateNetwork === true,
    timeoutMs: params.timeoutMs,
  });
  const payload = {
    addresses: [params.address],
    message: params.message ?? "",
    tempGuid: `temp-${crypto.randomUUID()}`,
  };
  const res = await client.request({
    method: "POST",
    path: "/api/v1/chat/new",
    body: payload,
    timeoutMs: params.timeoutMs,
  });
  if (!res.ok) {
    const errorText = await res.text();
    if (
      res.status === 400 ||
      res.status === 403 ||
      normalizeLowercaseStringOrEmpty(errorText).includes("private api")
    ) {
      throw new Error(
        `BlueBubbles send failed: Cannot create new chat - Private API must be enabled. Original error: ${errorText || res.status}`,
      );
    }
    throw new Error(`BlueBubbles create chat failed (${res.status}): ${errorText || "unknown"}`);
  }
  const body = await res.text();
  let messageId = "ok";
  let chatGuid: string | null = null;
  if (body) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      messageId = extractBlueBubblesMessageId(parsed);
      // Extract chatGuid from the response data
      const data = parsed.data as Record<string, unknown> | undefined;
      if (data) {
        chatGuid =
          (typeof data.chatGuid === "string" && data.chatGuid) ||
          (typeof data.guid === "string" && data.guid) ||
          null;
        // Also try nested chats array (some BB versions nest it)
        if (!chatGuid) {
          const chats = data.chats ?? data.chat;
          if (Array.isArray(chats) && chats.length > 0) {
            const first = chats[0] as Record<string, unknown> | undefined;
            chatGuid =
              (typeof first?.guid === "string" && first.guid) ||
              (typeof first?.chatGuid === "string" && first.chatGuid) ||
              null;
          } else if (chats && typeof chats === "object" && !Array.isArray(chats)) {
            const chatObj = chats as Record<string, unknown>;
            chatGuid =
              (typeof chatObj.guid === "string" && chatObj.guid) ||
              (typeof chatObj.chatGuid === "string" && chatObj.chatGuid) ||
              null;
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  }
  return { chatGuid, messageId };
}

/**
 * Creates a new chat (DM) and sends an initial message.
 * Requires Private API to be enabled in BlueBubbles.
 */
async function createNewChatWithMessage(params: {
  baseUrl: string;
  password: string;
  address: string;
  message: string;
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}): Promise<BlueBubblesSendResult> {
  const result = await createChatForHandle({
    baseUrl: params.baseUrl,
    password: params.password,
    address: params.address,
    message: params.message,
    timeoutMs: params.timeoutMs,
    allowPrivateNetwork: params.allowPrivateNetwork,
  });
  return { messageId: result.messageId };
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
  // Strip markdown early and validate - ensures messages like "***" or "---" don't become empty
  const strippedText = stripMarkdown(trimmedText);
  if (!strippedText.trim()) {
    throw new Error("BlueBubbles send requires text (message was empty after markdown removal)");
  }

  const { baseUrl, password, accountId, allowPrivateNetwork, sendTimeoutMs } =
    resolveBlueBubblesServerAccount({
      cfg: opts.cfg ?? {},
      accountId: opts.accountId,
      serverUrl: opts.serverUrl,
      password: opts.password,
    });
  // Send-path timeout: explicit caller override > per-account config > 30s default.
  // Kept separate from the default 10s client timeout so chat lookups, probes,
  // and health checks stay snappy while actual sends can ride out macOS 26
  // Private API stalls. (#67486)
  const effectiveSendTimeoutMs = opts.timeoutMs ?? sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  let privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);

  const target = resolveBlueBubblesSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
    allowPrivateNetwork,
  });
  if (!chatGuid) {
    // If target is a phone number/handle and no existing chat found,
    // auto-create a new DM chat using the /api/v1/chat/new endpoint
    if (target.kind === "handle") {
      return createNewChatWithMessage({
        baseUrl,
        password,
        address: target.address,
        message: strippedText,
        timeoutMs: effectiveSendTimeoutMs,
        allowPrivateNetwork,
      });
    }
    throw new Error(
      "BlueBubbles send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
  }
  const effectId = resolveEffectId(opts.effectId);
  const wantsReplyThread = normalizeOptionalString(opts.replyToMessageGuid) !== undefined;
  const wantsEffect = Boolean(effectId);

  // Lazy refresh: when the cache has expired, fetch server info before
  // making the decision. Originally scoped to reply/effect features (#43764)
  // to avoid silent degradation after the 10-minute cache TTL expires. Now
  // always fires on null status, because `isMacOS26OrHigher()` reads from
  // the same cache and plain-text sends on macOS 26 need Private API too —
  // without this, `forceOnMacOS26` silently falls back to broken AppleScript
  // after TTL expiry or on a cold cache. (#64480, Greptile/Codex PR #69070)
  if (privateApiStatus === null) {
    try {
      await fetchBlueBubblesServerInfo({
        baseUrl,
        password,
        accountId,
        timeoutMs: opts.timeoutMs ?? 5000,
        allowPrivateNetwork,
      });
      privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);
    } catch {
      // Refresh failed — proceed with null status (existing graceful degradation)
    }
  }

  const privateApiDecision = resolvePrivateApiDecision({
    privateApiStatus,
    wantsReplyThread,
    wantsEffect,
    accountId,
  });
  if (privateApiDecision.throwEffectDisabledError) {
    throw new Error(
      "BlueBubbles send failed: reply/effect requires Private API, but it is disabled on the BlueBubbles server.",
    );
  }
  if (privateApiDecision.warningMessage) {
    warnBlueBubbles(privateApiDecision.warningMessage);
  }
  // Always set `method` explicitly. BB Server's behavior on an omitted
  // `method` is version-dependent and silently drops on some setups (e.g.
  // macOS without Private API — message lands in Messages.app locally but
  // never reaches the phone). (#64480)
  const payload: Record<string, unknown> = {
    chatGuid,
    tempGuid: crypto.randomUUID(),
    message: strippedText,
    method: privateApiDecision.canUsePrivateApi ? "private-api" : "apple-script",
  };

  // Add reply threading support
  if (wantsReplyThread && privateApiDecision.canUsePrivateApi) {
    payload.selectedMessageGuid = opts.replyToMessageGuid;
    payload.partIndex = typeof opts.replyToPartIndex === "number" ? opts.replyToPartIndex : 0;
  }

  // Add message effects support
  if (effectId && privateApiDecision.canUsePrivateApi) {
    payload.effectId = effectId;
  }

  const client = createBlueBubblesClient({
    cfg: opts.cfg ?? {},
    accountId: opts.accountId,
    serverUrl: opts.serverUrl,
    password: opts.password,
  });
  const res = await client.request({
    method: "POST",
    path: "/api/v1/message/text",
    body: payload,
    timeoutMs: effectiveSendTimeoutMs,
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles send failed (${res.status}): ${errorText || "unknown"}`);
  }
  return parseBlueBubblesMessageResponse(res);
}
