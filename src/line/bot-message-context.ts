import type {
  MessageEvent,
  TextEventMessage,
  StickerEventMessage,
  LocationEventMessage,
  EventSource,
  PostbackEvent,
} from "@line/bot-sdk";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { formatLocationText, toLocationContext } from "../channels/location.js";
import type { MoltbotConfig } from "../config/config.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { ResolvedLineAccount } from "./types.js";

interface MediaRef {
  path: string;
  contentType?: string;
}

interface BuildLineMessageContextParams {
  event: MessageEvent;
  allMedia: MediaRef[];
  cfg: MoltbotConfig;
  account: ResolvedLineAccount;
}

function getSourceInfo(source: EventSource): {
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
} {
  const userId =
    source.type === "user"
      ? source.userId
      : source.type === "group"
        ? source.userId
        : source.type === "room"
          ? source.userId
          : undefined;
  const groupId = source.type === "group" ? source.groupId : undefined;
  const roomId = source.type === "room" ? source.roomId : undefined;
  const isGroup = source.type === "group" || source.type === "room";

  return { userId, groupId, roomId, isGroup };
}

function buildPeerId(source: EventSource): string {
  if (source.type === "group" && source.groupId) {
    return `group:${source.groupId}`;
  }
  if (source.type === "room" && source.roomId) {
    return `room:${source.roomId}`;
  }
  if (source.type === "user" && source.userId) {
    return source.userId;
  }
  return "unknown";
}

// Common LINE sticker package descriptions
const STICKER_PACKAGES: Record<string, string> = {
  "1": "Moon & James",
  "2": "Cony & Brown",
  "3": "Brown & Friends",
  "4": "Moon Special",
  "11537": "Cony",
  "11538": "Brown",
  "11539": "Moon",
  "6136": "Cony's Happy Life",
  "6325": "Brown's Life",
  "6359": "Choco",
  "6362": "Sally",
  "6370": "Edward",
  "789": "LINE Characters",
};

function describeStickerKeywords(sticker: StickerEventMessage): string {
  // Use sticker keywords if available (LINE provides these for some stickers)
  const keywords = (sticker as StickerEventMessage & { keywords?: string[] }).keywords;
  if (keywords && keywords.length > 0) {
    return keywords.slice(0, 3).join(", ");
  }

  // Use sticker text if available
  const stickerText = (sticker as StickerEventMessage & { text?: string }).text;
  if (stickerText) {
    return stickerText;
  }

  return "";
}

function extractMessageText(message: MessageEvent["message"]): string {
  if (message.type === "text") {
    return (message as TextEventMessage).text;
  }
  if (message.type === "location") {
    const loc = message as LocationEventMessage;
    return (
      formatLocationText({
        latitude: loc.latitude,
        longitude: loc.longitude,
        name: loc.title,
        address: loc.address,
      }) ?? ""
    );
  }
  if (message.type === "sticker") {
    const sticker = message as StickerEventMessage;
    const packageName = STICKER_PACKAGES[sticker.packageId] ?? "sticker";
    const keywords = describeStickerKeywords(sticker);

    if (keywords) {
      return `[Sent a ${packageName} sticker: ${keywords}]`;
    }
    return `[Sent a ${packageName} sticker]`;
  }
  return "";
}

function extractMediaPlaceholder(message: MessageEvent["message"]): string {
  switch (message.type) {
    case "image":
      return "<media:image>";
    case "video":
      return "<media:video>";
    case "audio":
      return "<media:audio>";
    case "file":
      return "<media:document>";
    default:
      return "";
  }
}

export async function buildLineMessageContext(params: BuildLineMessageContextParams) {
  const { event, allMedia, cfg, account } = params;

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "inbound",
  });

  const source = event.source;
  const { userId, groupId, roomId, isGroup } = getSourceInfo(source);
  const peerId = buildPeerId(source);

  const route = resolveAgentRoute({
    cfg,
    channel: "line",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const message = event.message;
  const messageId = message.id;
  const timestamp = event.timestamp;

  // Build message body
  const textContent = extractMessageText(message);
  const placeholder = extractMediaPlaceholder(message);

  let rawBody = textContent || placeholder;
  if (!rawBody && allMedia.length > 0) {
    rawBody = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
  }

  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  // Build sender info
  const senderId = userId ?? "unknown";
  const senderLabel = userId ? `user:${userId}` : "unknown";

  // Build conversation label
  const conversationLabel = isGroup
    ? groupId
      ? `group:${groupId}`
      : roomId
        ? `room:${roomId}`
        : "unknown-group"
    : senderLabel;

  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = formatInboundEnvelope({
    channel: "LINE",
    from: conversationLabel,
    timestamp,
    body: rawBody,
    chatType: isGroup ? "group" : "direct",
    sender: {
      id: senderId,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  // Build location context if applicable
  let locationContext: ReturnType<typeof toLocationContext> | undefined;
  if (message.type === "location") {
    const loc = message as LocationEventMessage;
    locationContext = toLocationContext({
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.title,
      address: loc.address,
    });
  }

  const fromAddress = isGroup
    ? groupId
      ? `line:group:${groupId}`
      : roomId
        ? `line:room:${roomId}`
        : `line:${peerId}`
    : `line:${userId ?? peerId}`;
  const toAddress = isGroup ? fromAddress : `line:${userId ?? peerId}`;
  const originatingTo = isGroup ? fromAddress : `line:${userId ?? peerId}`;

  const ctxPayload = finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: fromAddress,
    To: toAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (groupId ?? roomId) : undefined,
    SenderId: senderId,
    Provider: "line",
    Surface: "line",
    MessageSid: messageId,
    Timestamp: timestamp,
    MediaPath: allMedia[0]?.path,
    MediaType: allMedia[0]?.contentType,
    MediaUrl: allMedia[0]?.path,
    MediaPaths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
    MediaUrls: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
    MediaTypes:
      allMedia.length > 0
        ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
        : undefined,
    ...locationContext,
    OriginatingChannel: "line" as const,
    OriginatingTo: originatingTo,
  });

  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    logVerbose(`line: failed updating session meta: ${String(err)}`);
  });

  if (!isGroup) {
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "line",
        to: userId ?? peerId,
        accountId: route.accountId,
      },
      ctx: ctxPayload,
    });
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo = allMedia.length > 1 ? ` mediaCount=${allMedia.length}` : "";
    logVerbose(
      `line inbound: from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    event,
    userId,
    groupId,
    roomId,
    isGroup,
    route,
    replyToken: event.replyToken,
    accountId: account.accountId,
  };
}

export async function buildLinePostbackContext(params: {
  event: PostbackEvent;
  cfg: MoltbotConfig;
  account: ResolvedLineAccount;
}) {
  const { event, cfg, account } = params;

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "inbound",
  });

  const source = event.source;
  const { userId, groupId, roomId, isGroup } = getSourceInfo(source);
  const peerId = buildPeerId(source);

  const route = resolveAgentRoute({
    cfg,
    channel: "line",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: peerId,
    },
  });

  const timestamp = event.timestamp;
  const rawData = event.postback?.data?.trim() ?? "";
  if (!rawData) return null;
  let rawBody = rawData;
  if (rawData.includes("line.action=")) {
    const params = new URLSearchParams(rawData);
    const action = params.get("line.action") ?? "";
    const device = params.get("line.device");
    rawBody = device ? `line action ${action} device ${device}` : `line action ${action}`;
  }

  const senderId = userId ?? "unknown";
  const senderLabel = userId ? `user:${userId}` : "unknown";

  const conversationLabel = isGroup
    ? groupId
      ? `group:${groupId}`
      : roomId
        ? `room:${roomId}`
        : "unknown-group"
    : senderLabel;

  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const body = formatInboundEnvelope({
    channel: "LINE",
    from: conversationLabel,
    timestamp,
    body: rawBody,
    chatType: isGroup ? "group" : "direct",
    sender: {
      id: senderId,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const fromAddress = isGroup
    ? groupId
      ? `line:group:${groupId}`
      : roomId
        ? `line:room:${roomId}`
        : `line:${peerId}`
    : `line:${userId ?? peerId}`;
  const toAddress = isGroup ? fromAddress : `line:${userId ?? peerId}`;
  const originatingTo = isGroup ? fromAddress : `line:${userId ?? peerId}`;

  const ctxPayload = finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: fromAddress,
    To: toAddress,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: isGroup ? (groupId ?? roomId) : undefined,
    SenderId: senderId,
    Provider: "line",
    Surface: "line",
    MessageSid: event.replyToken ? `postback:${event.replyToken}` : `postback:${timestamp}`,
    Timestamp: timestamp,
    MediaPath: "",
    MediaType: undefined,
    MediaUrl: "",
    MediaPaths: undefined,
    MediaUrls: undefined,
    MediaTypes: undefined,
    OriginatingChannel: "line" as const,
    OriginatingTo: originatingTo,
  });

  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    logVerbose(`line: failed updating session meta: ${String(err)}`);
  });

  if (!isGroup) {
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "line",
        to: userId ?? peerId,
        accountId: route.accountId,
      },
      ctx: ctxPayload,
    });
  }

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    logVerbose(`line postback: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
  }

  return {
    ctxPayload,
    event,
    userId,
    groupId,
    roomId,
    isGroup,
    route,
    replyToken: event.replyToken,
    accountId: account.accountId,
  };
}

export type LineMessageContext = NonNullable<Awaited<ReturnType<typeof buildLineMessageContext>>>;
export type LinePostbackContext = NonNullable<Awaited<ReturnType<typeof buildLinePostbackContext>>>;
export type LineInboundContext = LineMessageContext | LinePostbackContext;
