import type { IncomingMessage, ServerResponse } from "node:http";

import { loadCoreChannelDeps } from "./core-bridge.js";
import { markBlueBubblesChatRead, sendBlueBubblesTyping } from "./chat.js";
import { resolveChatGuidForTarget, sendMessageBlueBubbles } from "./send.js";
import { formatBlueBubblesChatTarget, isAllowedBlueBubblesSender, normalizeBlueBubblesHandle } from "./targets.js";
import type { BlueBubblesAccountConfig, CoreConfig } from "./types.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";

export type BlueBubblesRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type BlueBubblesMonitorOptions = {
  account: ResolvedBlueBubblesAccount;
  config: CoreConfig;
  runtime: BlueBubblesRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  webhookPath?: string;
};

const DEFAULT_WEBHOOK_PATH = "/bluebubbles-webhook";
const DEFAULT_TEXT_LIMIT = 4000;

function logVerbose(
  deps: Awaited<ReturnType<typeof loadCoreChannelDeps>>,
  runtime: BlueBubblesRuntimeEnv,
  message: string,
): void {
  if (deps.shouldLogVerbose()) {
    runtime.log?.(`[bluebubbles] ${message}`);
  }
}

type WebhookTarget = {
  account: ResolvedBlueBubblesAccount;
  config: CoreConfig;
  runtime: BlueBubblesRuntimeEnv;
  deps: Awaited<ReturnType<typeof loadCoreChannelDeps>>;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

function normalizeWebhookPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (withSlash.length > 1 && withSlash.endsWith("/")) {
    return withSlash.slice(0, -1);
  }
  return withSlash;
}

export function registerBlueBubblesWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = webhookTargets.get(key) ?? [];
  const next = [...existing, normalizedTarget];
  webhookTargets.set(key, next);
  return () => {
    const updated = (webhookTargets.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      webhookTargets.set(key, updated);
    } else {
      webhookTargets.delete(key);
    }
  };
}

async function readJsonBody(req: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  return await new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => {
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve({ ok: false, error: "payload too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw.trim()) {
          resolve({ ok: false, error: "empty payload" });
          return;
        }
        try {
          resolve({ ok: true, value: JSON.parse(raw) as unknown });
          return;
        } catch {
          const params = new URLSearchParams(raw);
          const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
          if (payload) {
            resolve({ ok: true, value: JSON.parse(payload) as unknown });
            return;
          }
          throw new Error("invalid json");
        }
      } catch (err) {
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    req.on("error", (err) => {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumberLike(record: Record<string, unknown> | null, key: string): number | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readFirstChatRecord(message: Record<string, unknown>): Record<string, unknown> | null {
  const chats = message["chats"];
  if (!Array.isArray(chats) || chats.length === 0) return null;
  const first = chats[0];
  return asRecord(first);
}

type NormalizedWebhookMessage = {
  text: string;
  senderId: string;
  senderName?: string;
  messageId?: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
};

type NormalizedWebhookReaction = {
  action: "added" | "removed";
  emoji: string;
  senderId: string;
  senderName?: string;
  messageId: string;
  timestamp?: number;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  chatName?: string;
  fromMe?: boolean;
};

const REACTION_TYPE_MAP = new Map<number, { emoji: string; action: "added" | "removed" }>([
  [2000, { emoji: "❤️", action: "added" }],
  [2001, { emoji: "👍", action: "added" }],
  [2002, { emoji: "👎", action: "added" }],
  [2003, { emoji: "😂", action: "added" }],
  [2004, { emoji: "‼️", action: "added" }],
  [2005, { emoji: "❓", action: "added" }],
  [3000, { emoji: "❤️", action: "removed" }],
  [3001, { emoji: "👍", action: "removed" }],
  [3002, { emoji: "👎", action: "removed" }],
  [3003, { emoji: "😂", action: "removed" }],
  [3004, { emoji: "‼️", action: "removed" }],
  [3005, { emoji: "❓", action: "removed" }],
]);

function maskSecret(value: string): string {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function extractMessagePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const dataRaw = payload.data ?? payload.payload ?? payload.event;
  const data =
    asRecord(dataRaw) ??
    (typeof dataRaw === "string" ? (asRecord(JSON.parse(dataRaw)) ?? null) : null);
  const messageRaw = payload.message ?? data?.message ?? data;
  const message =
    asRecord(messageRaw) ??
    (typeof messageRaw === "string" ? (asRecord(JSON.parse(messageRaw)) ?? null) : null);
  if (!message) return null;
  return message;
}

function normalizeWebhookMessage(payload: Record<string, unknown>): NormalizedWebhookMessage | null {
  const message = extractMessagePayload(payload);
  if (!message) return null;

  const text =
    readString(message, "text") ??
    readString(message, "body") ??
    readString(message, "subject") ??
    "";

  const handleValue = message.handle ?? message.sender;
  const handle =
    asRecord(handleValue) ??
    (typeof handleValue === "string" ? { address: handleValue } : null);
  const senderId =
    readString(handle, "address") ??
    readString(handle, "handle") ??
    readString(handle, "id") ??
    readString(message, "senderId") ??
    readString(message, "sender") ??
    readString(message, "from") ??
    "";

  const senderName =
    readString(handle, "displayName") ??
    readString(handle, "name") ??
    readString(message, "senderName") ??
    undefined;

  const chat = asRecord(message.chat) ?? asRecord(message.conversation) ?? null;
  const chatFromList = readFirstChatRecord(message);
  const chatGuid =
    readString(message, "chatGuid") ??
    readString(message, "chat_guid") ??
    readString(chat, "guid") ??
    readString(chatFromList, "guid");
  const chatIdentifier =
    readString(message, "chatIdentifier") ??
    readString(message, "chat_identifier") ??
    readString(chat, "identifier") ??
    readString(chatFromList, "chatIdentifier") ??
    readString(chatFromList, "chat_identifier") ??
    readString(chatFromList, "identifier");
  const chatId =
    readNumber(message, "chatId") ??
    readNumber(message, "chat_id") ??
    readNumber(chat, "id") ??
    readNumber(chatFromList, "id");
  const chatName =
    readString(message, "chatName") ??
    readString(chat, "displayName") ??
    readString(chat, "name") ??
    readString(chatFromList, "displayName") ??
    readString(chatFromList, "name") ??
    undefined;

  const chatParticipants = chat ? chat["participants"] : undefined;
  const messageParticipants = message["participants"];
  const chatsParticipants = chatFromList ? chatFromList["participants"] : undefined;
  const participants = Array.isArray(chatParticipants)
    ? chatParticipants
    : Array.isArray(messageParticipants)
      ? messageParticipants
      : Array.isArray(chatsParticipants)
        ? chatsParticipants
        : [];
  const participantsCount = participants.length;
  const isGroup =
    readBoolean(message, "isGroup") ??
    readBoolean(message, "is_group") ??
    readBoolean(chat, "isGroup") ??
    readBoolean(message, "group") ??
    (participantsCount > 2 ? true : false);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const messageId =
    readString(message, "guid") ??
    readString(message, "id") ??
    readString(message, "messageId") ??
    undefined;

  const timestampRaw =
    readNumber(message, "date") ??
    readNumber(message, "dateCreated") ??
    readNumber(message, "timestamp");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  const normalizedSender = normalizeBlueBubblesHandle(senderId);
  if (!normalizedSender) return null;

  return {
    text,
    senderId: normalizedSender,
    senderName,
    messageId,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
  };
}

function normalizeWebhookReaction(payload: Record<string, unknown>): NormalizedWebhookReaction | null {
  const message = extractMessagePayload(payload);
  if (!message) return null;

  const associatedGuid =
    readString(message, "associatedMessageGuid") ??
    readString(message, "associated_message_guid") ??
    readString(message, "associatedMessageId");
  const associatedType =
    readNumberLike(message, "associatedMessageType") ??
    readNumberLike(message, "associated_message_type");
  if (!associatedGuid || associatedType === undefined) return null;

  const mapping = REACTION_TYPE_MAP.get(associatedType);
  const emoji = mapping?.emoji ?? `reaction:${associatedType}`;
  const action = mapping?.action ?? "added";

  const handleValue = message.handle ?? message.sender;
  const handle =
    asRecord(handleValue) ??
    (typeof handleValue === "string" ? { address: handleValue } : null);
  const senderId =
    readString(handle, "address") ??
    readString(handle, "handle") ??
    readString(handle, "id") ??
    readString(message, "senderId") ??
    readString(message, "sender") ??
    readString(message, "from") ??
    "";
  const senderName =
    readString(handle, "displayName") ??
    readString(handle, "name") ??
    readString(message, "senderName") ??
    undefined;

  const chat = asRecord(message.chat) ?? asRecord(message.conversation) ?? null;
  const chatFromList = readFirstChatRecord(message);
  const chatGuid =
    readString(message, "chatGuid") ??
    readString(message, "chat_guid") ??
    readString(chat, "guid") ??
    readString(chatFromList, "guid");
  const chatIdentifier =
    readString(message, "chatIdentifier") ??
    readString(message, "chat_identifier") ??
    readString(chat, "identifier") ??
    readString(chatFromList, "chatIdentifier") ??
    readString(chatFromList, "chat_identifier") ??
    readString(chatFromList, "identifier");
  const chatId =
    readNumberLike(message, "chatId") ??
    readNumberLike(message, "chat_id") ??
    readNumberLike(chat, "id") ??
    readNumberLike(chatFromList, "id");
  const chatName =
    readString(message, "chatName") ??
    readString(chat, "displayName") ??
    readString(chat, "name") ??
    readString(chatFromList, "displayName") ??
    readString(chatFromList, "name") ??
    undefined;

  const chatParticipants = chat ? chat["participants"] : undefined;
  const messageParticipants = message["participants"];
  const chatsParticipants = chatFromList ? chatFromList["participants"] : undefined;
  const participants = Array.isArray(chatParticipants)
    ? chatParticipants
    : Array.isArray(messageParticipants)
      ? messageParticipants
      : Array.isArray(chatsParticipants)
        ? chatsParticipants
        : [];
  const participantsCount = participants.length;
  const isGroup =
    readBoolean(message, "isGroup") ??
    readBoolean(message, "is_group") ??
    readBoolean(chat, "isGroup") ??
    readBoolean(message, "group") ??
    (participantsCount > 2 ? true : false);

  const fromMe = readBoolean(message, "isFromMe") ?? readBoolean(message, "is_from_me");
  const timestampRaw =
    readNumberLike(message, "date") ??
    readNumberLike(message, "dateCreated") ??
    readNumberLike(message, "timestamp");
  const timestamp =
    typeof timestampRaw === "number"
      ? timestampRaw > 1_000_000_000_000
        ? timestampRaw
        : timestampRaw * 1000
      : undefined;

  const normalizedSender = normalizeBlueBubblesHandle(senderId);
  if (!normalizedSender) return null;

  return {
    action,
    emoji,
    senderId: normalizedSender,
    senderName,
    messageId: associatedGuid,
    timestamp,
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    chatName,
    fromMe,
  };
}

export async function handleBlueBubblesWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const body = await readJsonBody(req, 1024 * 1024);
  if (!body.ok) {
    res.statusCode = body.error === "payload too large" ? 413 : 400;
    res.end(body.error ?? "invalid payload");
    console.warn(`[bluebubbles] webhook rejected: ${body.error ?? "invalid payload"}`);
    return true;
  }

  const payload = asRecord(body.value) ?? {};
  const firstTarget = targets[0];
  if (firstTarget) {
    logVerbose(
      firstTarget.deps,
      firstTarget.runtime,
      `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`,
    );
  }
  const eventTypeRaw = payload.type;
  const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw.trim() : "";
  const allowedEventTypes = new Set([
    "new-message",
    "updated-message",
    "message-reaction",
    "reaction",
  ]);
  if (eventType && !allowedEventTypes.has(eventType)) {
    res.statusCode = 200;
    res.end("ok");
    if (firstTarget) {
      logVerbose(firstTarget.deps, firstTarget.runtime, `webhook ignored type=${eventType}`);
    }
    return true;
  }
  const reaction = normalizeWebhookReaction(payload);
  if (
    (eventType === "updated-message" ||
      eventType === "message-reaction" ||
      eventType === "reaction") &&
    !reaction
  ) {
    res.statusCode = 200;
    res.end("ok");
    if (firstTarget) {
      logVerbose(
        firstTarget.deps,
        firstTarget.runtime,
        `webhook ignored ${eventType || "event"} without reaction`,
      );
    }
    return true;
  }
  const message = reaction ? null : normalizeWebhookMessage(payload);
  if (!message && !reaction) {
    res.statusCode = 400;
    res.end("invalid payload");
    console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
    return true;
  }

  const matching = targets.filter((target) => {
    const token = target.account.config.password?.trim();
    if (!token) return true;
    const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
    const headerToken =
      req.headers["x-guid"] ??
      req.headers["x-password"] ??
      req.headers["x-bluebubbles-guid"] ??
      req.headers["authorization"];
    const guid =
      (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
    if (guid && guid.trim() === token) return true;
    const remote = req.socket?.remoteAddress ?? "";
    if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") {
      return true;
    }
    return false;
  });

  if (matching.length === 0) {
    res.statusCode = 401;
    res.end("unauthorized");
    console.warn(
      `[bluebubbles] webhook rejected: unauthorized guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`,
    );
    return true;
  }

  for (const target of matching) {
    target.statusSink?.({ lastInboundAt: Date.now() });
    if (reaction) {
      processReaction(reaction, target).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`,
        );
      });
    } else if (message) {
      processMessage(message, target).catch((err) => {
        target.runtime.error?.(
          `[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
        );
      });
    }
  }

  res.statusCode = 200;
  res.end("ok");
  if (reaction) {
    if (firstTarget) {
      logVerbose(
        firstTarget.deps,
        firstTarget.runtime,
        `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`,
      );
    }
  } else if (message) {
    if (firstTarget) {
      logVerbose(
        firstTarget.deps,
        firstTarget.runtime,
        `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
      );
    }
  }
  return true;
}

async function processMessage(
  message: NormalizedWebhookMessage,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, deps, statusSink } = target;
  if (message.fromMe) return;

  const text = message.text.trim();
  if (!text) {
    logVerbose(deps, runtime, `drop: empty text sender=${message.senderId}`);
    return;
  }
  logVerbose(
    deps,
    runtime,
    `msg sender=${message.senderId} group=${message.isGroup} textLen=${text.length} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
  );

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await deps.readChannelAllowFromStore("bluebubbles").catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const effectiveGroupAllowFrom = [
    ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
    ...storeAllowFrom,
  ]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  if (message.isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(deps, runtime, "Blocked BlueBubbles group message (groupPolicy=disabled)");
      return;
    }
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        logVerbose(deps, runtime, "Blocked BlueBubbles group message (no allowlist)");
        return;
      }
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveGroupAllowFrom,
        sender: message.senderId,
        chatId: message.chatId ?? undefined,
        chatGuid: message.chatGuid ?? undefined,
        chatIdentifier: message.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        logVerbose(
          deps,
          runtime,
          `Blocked BlueBubbles sender ${message.senderId} (not in groupAllowFrom)`,
        );
        logVerbose(
          deps,
          runtime,
          `drop: group sender not allowed sender=${message.senderId} allowFrom=${effectiveGroupAllowFrom.join(",")}`,
        );
        return;
      }
    }
  } else {
    if (dmPolicy === "disabled") {
      logVerbose(deps, runtime, `Blocked BlueBubbles DM from ${message.senderId}`);
      logVerbose(deps, runtime, `drop: dmPolicy disabled sender=${message.senderId}`);
      return;
    }
    if (dmPolicy !== "open") {
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveAllowFrom,
        sender: message.senderId,
        chatId: message.chatId ?? undefined,
        chatGuid: message.chatGuid ?? undefined,
        chatIdentifier: message.chatIdentifier ?? undefined,
      });
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await deps.upsertChannelPairingRequest({
            channel: "bluebubbles",
            id: message.senderId,
            meta: { name: message.senderName },
          });
          runtime.log?.(
            `[bluebubbles] pairing request sender=${message.senderId} created=${created}`,
          );
          if (created) {
            logVerbose(deps, runtime, `bluebubbles pairing request sender=${message.senderId}`);
            try {
              await sendMessageBlueBubbles(
                message.senderId,
                deps.buildPairingReply({
                  channel: "bluebubbles",
                  idLine: `Your BlueBubbles sender id: ${message.senderId}`,
                  code,
                }),
                { cfg: config, accountId: account.accountId },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(
                deps,
                runtime,
                `bluebubbles pairing reply failed for ${message.senderId}: ${String(err)}`,
              );
              runtime.error?.(
                `[bluebubbles] pairing reply failed sender=${message.senderId}: ${String(err)}`,
              );
            }
          }
        } else {
          logVerbose(
            deps,
            runtime,
            `Blocked unauthorized BlueBubbles sender ${message.senderId} (dmPolicy=${dmPolicy})`,
          );
          logVerbose(
            deps,
            runtime,
            `drop: dm sender not allowed sender=${message.senderId} allowFrom=${effectiveAllowFrom.join(",")}`,
          );
        }
        return;
      }
    }
  }

  const chatId = message.chatId ?? undefined;
  const chatGuid = message.chatGuid ?? undefined;
  const chatIdentifier = message.chatIdentifier ?? undefined;
  const peerId = message.isGroup
    ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group")
    : message.senderId;

  const route = deps.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const rawBody = text.trim();
  const fromLabel = message.isGroup
    ? `group:${peerId}`
    : message.senderName || `user:${message.senderId}`;
  const body = deps.formatAgentEnvelope({
    channel: "BlueBubbles",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const baseUrl = account.config.serverUrl?.trim();
  const password = account.config.password?.trim();
  let chatGuidForActions = chatGuid;
  if (!chatGuidForActions && baseUrl && password) {
    const target =
      message.isGroup && (chatId || chatIdentifier)
        ? chatId
          ? { kind: "chat_id", chatId }
          : { kind: "chat_identifier", chatIdentifier: chatIdentifier ?? "" }
        : { kind: "handle", address: message.senderId };
    if (target.kind !== "chat_identifier" || target.chatIdentifier) {
      chatGuidForActions =
        (await resolveChatGuidForTarget({
          baseUrl,
          password,
          target,
        })) ?? undefined;
    }
  }

  if (chatGuidForActions && baseUrl && password) {
    try {
      await markBlueBubblesChatRead(chatGuidForActions, {
        cfg: config,
        accountId: account.accountId,
      });
      logVerbose(deps, runtime, `marked read chatGuid=${chatGuidForActions}`);
    } catch (err) {
      runtime.error?.(`[bluebubbles] mark read failed: ${String(err)}`);
    }
  } else {
    logVerbose(deps, runtime, "mark read skipped (missing chatGuid or credentials)");
  }

  const outboundTarget = message.isGroup
    ? formatBlueBubblesChatTarget({
        chatId,
        chatGuid: chatGuidForActions ?? chatGuid,
        chatIdentifier,
      }) || peerId
    : chatGuidForActions
      ? formatBlueBubblesChatTarget({ chatGuid: chatGuidForActions })
      : message.senderId;

  const ctxPayload = {
    Body: body,
    BodyForAgent: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    BodyForCommands: rawBody,
    From: message.isGroup ? `group:${peerId}` : `bluebubbles:${message.senderId}`,
    To: `bluebubbles:${outboundTarget}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderName || undefined,
    SenderId: message.senderId,
    Provider: "bluebubbles",
    Surface: "bluebubbles",
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: "bluebubbles",
    OriginatingTo: `bluebubbles:${outboundTarget}`,
  };

  await deps.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const textLimit =
          account.config.textChunkLimit && account.config.textChunkLimit > 0
            ? account.config.textChunkLimit
            : DEFAULT_TEXT_LIMIT;
        const chunks = deps.chunkMarkdownText(payload.text ?? "", textLimit);
        if (!chunks.length && payload.text) chunks.push(payload.text);
        if (!chunks.length) return;
        for (const chunk of chunks) {
          await sendMessageBlueBubbles(outboundTarget, chunk, {
            cfg: config,
            accountId: account.accountId,
          });
          statusSink?.({ lastOutboundAt: Date.now() });
        }
      },
      onReplyStart: async () => {
        if (!chatGuidForActions) return;
        if (!baseUrl || !password) return;
        logVerbose(deps, runtime, `typing start chatGuid=${chatGuidForActions}`);
        try {
          await sendBlueBubblesTyping(chatGuidForActions, true, {
            cfg: config,
            accountId: account.accountId,
          });
        } catch (err) {
          runtime.error?.(`[bluebubbles] typing start failed: ${String(err)}`);
        }
      },
      onIdle: () => {
        if (!chatGuidForActions) return;
        if (!baseUrl || !password) return;
        logVerbose(deps, runtime, `typing stop chatGuid=${chatGuidForActions}`);
        void sendBlueBubblesTyping(chatGuidForActions, false, {
          cfg: config,
          accountId: account.accountId,
        }).catch((err) => {
          runtime.error?.(`[bluebubbles] typing stop failed: ${String(err)}`);
        });
      },
      onError: (err, info) => {
        runtime.error?.(`BlueBubbles ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

async function processReaction(
  reaction: NormalizedWebhookReaction,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime, deps } = target;
  if (reaction.fromMe) return;

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const groupPolicy = account.config.groupPolicy ?? "allowlist";
  const configAllowFrom = (account.config.allowFrom ?? []).map((entry) => String(entry));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((entry) => String(entry));
  const storeAllowFrom = await deps.readChannelAllowFromStore("bluebubbles").catch(() => []);
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom]
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const effectiveGroupAllowFrom = [
    ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
    ...storeAllowFrom,
  ]
    .map((entry) => String(entry).trim())
    .filter(Boolean);

  if (reaction.isGroup) {
    if (groupPolicy === "disabled") return;
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) return;
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveGroupAllowFrom,
        sender: reaction.senderId,
        chatId: reaction.chatId ?? undefined,
        chatGuid: reaction.chatGuid ?? undefined,
        chatIdentifier: reaction.chatIdentifier ?? undefined,
      });
      if (!allowed) return;
    }
  } else {
    if (dmPolicy === "disabled") return;
    if (dmPolicy !== "open") {
      const allowed = isAllowedBlueBubblesSender({
        allowFrom: effectiveAllowFrom,
        sender: reaction.senderId,
        chatId: reaction.chatId ?? undefined,
        chatGuid: reaction.chatGuid ?? undefined,
        chatIdentifier: reaction.chatIdentifier ?? undefined,
      });
      if (!allowed) return;
    }
  }

  const chatId = reaction.chatId ?? undefined;
  const chatGuid = reaction.chatGuid ?? undefined;
  const chatIdentifier = reaction.chatIdentifier ?? undefined;
  const peerId = reaction.isGroup
    ? chatGuid ?? chatIdentifier ?? (chatId ? String(chatId) : "group")
    : reaction.senderId;

  const route = deps.resolveAgentRoute({
    cfg: config,
    channel: "bluebubbles",
    accountId: account.accountId,
    peer: {
      kind: reaction.isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const senderLabel = reaction.senderName || reaction.senderId;
  const chatLabel = reaction.isGroup ? ` in group:${peerId}` : "";
  const text = `BlueBubbles reaction ${reaction.action}: ${reaction.emoji} by ${senderLabel}${chatLabel} on msg ${reaction.messageId}`;
  deps.enqueueSystemEvent(text, {
    sessionKey: route.sessionKey,
    contextKey: `bluebubbles:reaction:${reaction.action}:${peerId}:${reaction.messageId}:${reaction.senderId}:${reaction.emoji}`,
  });
  logVerbose(deps, runtime, `reaction event enqueued: ${text}`);
}

export async function monitorBlueBubblesProvider(
  options: BlueBubblesMonitorOptions,
): Promise<{ stop: () => void }> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const deps = await loadCoreChannelDeps();
  const path = options.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;

  const unregister = registerBlueBubblesWebhookTarget({
    account,
    config,
    runtime,
    deps,
    path,
    statusSink,
  });

  const stop = () => {
    unregister();
  };

  if (abortSignal?.aborted) {
    stop();
  } else {
    abortSignal?.addEventListener("abort", stop, { once: true });
  }

  runtime.log?.(
    `[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`,
  );

  return { stop };
}

export function resolveWebhookPathFromConfig(config?: BlueBubblesAccountConfig): string {
  const raw = config?.webhookPath?.trim();
  if (raw) return normalizeWebhookPath(raw);
  return DEFAULT_WEBHOOK_PATH;
}
