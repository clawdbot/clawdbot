import type { webhook } from "@line/bot-sdk";
import {
  formatInboundEnvelope,
  formatLocationText,
  resolveInboundSessionEnvelopeContext,
  toLocationContext,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  ensureConfiguredBindingRouteReady,
  getSessionBindingService,
  recordInboundSession,
  resolvePinnedMainDmOwnerFromAllowlist,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  deriveLastRoutePolicy,
  resolveAgentIdFromSessionKey,
  resolveAgentRoute,
} from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { normalizeAllowFrom } from "./bot-access.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import type { ResolvedLineAccount } from "./types.js";

type EventSource = webhook.Source | undefined;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type StickerEventMessage = webhook.StickerMessageContent;

interface MediaRef {
  path: string;
  contentType?: string;
}

interface BuildLineMessageContextParams {
  event: MessageEvent;
  allMedia: MediaRef[];
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  commandAuthorized: boolean;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
}

export type LineSourceInfo = {
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
};

export function getLineSourceInfo(source: EventSource): LineSourceInfo {
  if (!source) {
    return { userId: undefined, groupId: undefined, roomId: undefined, isGroup: false };
  }
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
  if (!source) {
    return "unknown";
  }
  const groupKey =
    normalizeOptionalString(source.type === "group" ? source.groupId : undefined) ??
    normalizeOptionalString(source.type === "room" ? source.roomId : undefined);
  if (groupKey) {
    return groupKey;
  }
  if (source.type === "user" && source.userId) {
    return source.userId;
  }
  return "unknown";
}

async function resolveLineInboundRoute(params: {
  source: EventSource;
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
}): Promise<{
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
  peerId: string;
  route: ReturnType<typeof resolveAgentRoute>;
}> {
  recordChannelActivity({
    channel: "line",
    accountId: params.account.accountId,
    direction: "inbound",
  });

  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(params.source);
  const peerId = buildPeerId(params.source);
  let route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "line",
    accountId: params.account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const configuredRoute = resolveConfiguredBindingRoute({
    cfg: params.cfg,
    route,
    conversation: {
      channel: "line",
      accountId: params.account.accountId,
      conversationId: peerId,
    },
  });
  let configuredBinding = configuredRoute.bindingResolution;
  const configuredBindingSessionKey = configuredRoute.boundSessionKey ?? "";
  route = configuredRoute.route;

  const boundConversation = getSessionBindingService().resolveByConversation({
    channel: "line",
    accountId: params.account.accountId,
    conversationId: peerId,
  });
  const boundSessionKey = boundConversation?.targetSessionKey?.trim();
  if (boundConversation && boundSessionKey) {
    route = {
      ...route,
      sessionKey: boundSessionKey,
      agentId: resolveAgentIdFromSessionKey(boundSessionKey) || route.agentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    };
    configuredBinding = null;
    getSessionBindingService().touch(boundConversation.bindingId);
    logVerbose(`line: routed via bound conversation ${peerId} -> ${boundSessionKey}`);
  }

  if (configuredBinding) {
    const ensured = await ensureConfiguredBindingRouteReady({
      cfg: params.cfg,
      bindingResolution: configuredBinding,
    });
    if (!ensured.ok) {
      logVerbose(
        `line: configured ACP binding unavailable for ${peerId} -> ${configuredBindingSessionKey}: ${ensured.error}`,
      );
      throw new Error(`Configured ACP binding unavailable: ${ensured.error}`);
    }
    logVerbose(
      `line: using configured ACP binding for ${peerId} -> ${configuredBindingSessionKey}`,
    );
  }

  return { userId, groupId, roomId, isGroup, peerId, route };
}

const STICKER_PACKAGES: Record<string, string> = {
  "1": "Moon & James",
  "2": "Cony & Brown",
  "3": "Brown & Friends",
  "4": "Moon Special",
  "789": "LINE Characters",
  "6136": "Cony's Happy Life",
  "6325": "Brown's Life",
  "6359": "Choco",
  "6362": "Sally",
  "6370": "Edward",
  "11537": "Cony",
  "11538": "Brown",
  "11539": "Moon",
};

function describeStickerKeywords(sticker: StickerEventMessage): string {
  const keywords = (sticker as StickerEventMessage & { keywords?: string[] }).keywords;
  if (keywords && keywords.length > 0) {
    return keywords.slice(0, 3).join(", ");
  }

  const stickerText = (sticker as StickerEventMessage & { text?: string }).text;
  if (stickerText) {
    return stickerText;
  }

  return "";
}

function extractMessageText(message: MessageEvent["message"]): string {
  if (message.type === "text") {
    return message.text;
  }
  if (message.type === "location") {
    const loc = message;
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
    const sticker = message;
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

type LineRouteInfo = ReturnType<typeof resolveAgentRoute>;
type LineSourceInfoWithPeerId = LineSourceInfo & { peerId: string };

function resolveLineConversationLabel(params: {
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
  senderLabel: string;
}): string {
  return params.isGroup
    ? params.groupId
      ? `group:${params.groupId}`
      : params.roomId
        ? `room:${params.roomId}`
        : "unknown-group"
    : params.senderLabel;
}

function resolveLineAddresses(params: {
  isGroup: boolean;
  groupId?: string;
  roomId?: string;
  userId?: string;
  peerId: string;
}): { fromAddress: string; toAddress: string; originatingTo: string } {
  const fromAddress = params.isGroup
    ? params.groupId
      ? `line:group:${params.groupId}`
      : params.roomId
        ? `line:room:${params.roomId}`
        : `line:${params.peerId}`
    : `line:${params.userId ?? params.peerId}`;
  const toAddress = params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`;
  const originatingTo = params.isGroup ? fromAddress : `line:${params.userId ?? params.peerId}`;
  return { fromAddress, toAddress, originatingTo };
}

async function finalizeLineInboundContext(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  event: MessageEvent | PostbackEvent;
  route: LineRouteInfo;
  source: LineSourceInfoWithPeerId;
  rawBody: string;
  timestamp: number;
  messageSid: string;
  commandAuthorized: boolean;
  media: {
    firstPath: string | undefined;
    firstContentType?: string;
    paths?: string[];
    types?: string[];
  };
  locationContext?: ReturnType<typeof toLocationContext>;
  verboseLog: { kind: "inbound" | "postback"; mediaCount?: number };
  inboundHistory?: Pick<HistoryEntry, "sender" | "body" | "timestamp">[];
}) {
  const { fromAddress, toAddress, originatingTo } = resolveLineAddresses({
    isGroup: params.source.isGroup,
    groupId: params.source.groupId,
    roomId: params.source.roomId,
    userId: params.source.userId,
    peerId: params.source.peerId,
  });

  const senderId = params.source.userId ?? "unknown";
  const senderLabel = params.source.userId ? `user:${params.source.userId}` : "unknown";
  const conversationLabel = resolveLineConversationLabel({
    isGroup: params.source.isGroup,
    groupId: params.source.groupId,
    roomId: params.source.roomId,
    senderLabel,
  });

  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });

  const body = formatInboundEnvelope({
    channel: "LINE",
    from: conversationLabel,
    timestamp: params.timestamp,
    body: params.rawBody,
    chatType: params.source.isGroup ? "group" : "direct",
    sender: {
      id: senderId,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const ctxPayload = finalizeInboundContext({
    Body: body,
    BodyForAgent: params.rawBody,
    RawBody: params.rawBody,
    CommandBody: params.rawBody,
    From: fromAddress,
    To: toAddress,
    SessionKey: params.route.sessionKey,
    AccountId: params.route.accountId,
    ChatType: params.source.isGroup ? "group" : "direct",
    ConversationLabel: conversationLabel,
    GroupSubject: params.source.isGroup
      ? (params.source.groupId ?? params.source.roomId)
      : undefined,
    SenderId: senderId,
    Provider: "line",
    Surface: "line",
    MessageSid: params.messageSid,
    Timestamp: params.timestamp,
    MediaPath: params.media.firstPath,
    MediaType: params.media.firstContentType,
    MediaUrl: params.media.firstPath,
    MediaPaths: params.media.paths,
    MediaUrls: params.media.paths,
    MediaTypes: params.media.types,
    ...params.locationContext,
    CommandAuthorized: params.commandAuthorized,
    OriginatingChannel: "line" as const,
    OriginatingTo: originatingTo,
    GroupSystemPrompt: params.source.isGroup
      ? normalizeOptionalString(
          resolveLineGroupConfigEntry(params.account.config.groups, {
            groupId: params.source.groupId,
            roomId: params.source.roomId,
          })?.systemPrompt,
        )
      : undefined,
    InboundHistory: params.inboundHistory,
  });

  const pinnedMainDmOwner = !params.source.isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: params.cfg.session?.dmScope,
        allowFrom: params.account.config.allowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? params.route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: !params.source.isGroup
      ? {
          sessionKey: params.route.mainSessionKey,
          channel: "line",
          to: params.source.userId ?? params.source.peerId,
          accountId: params.route.accountId,
          mainDmOwnerPin:
            pinnedMainDmOwner && params.source.userId
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: params.source.userId,
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `line: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`line: failed updating session meta: ${String(err)}`);
    },
  });

  if (shouldLogVerbose()) {
    const preview = body.slice(0, 200).replace(/\n/g, "\\n");
    const mediaInfo =
      params.verboseLog.kind === "inbound" && (params.verboseLog.mediaCount ?? 0) > 1
        ? ` mediaCount=${params.verboseLog.mediaCount}`
        : "";
    const label = params.verboseLog.kind === "inbound" ? "line inbound" : "line postback";
    logVerbose(
      `${label}: from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`,
    );
  }

  return { ctxPayload, replyToken: (params.event as { replyToken: string }).replyToken };
}

export async function buildLineMessageContext(params: BuildLineMessageContextParams) {
  const { event, allMedia, cfg, account, commandAuthorized, groupHistories, historyLimit } = params;

  const source = event.source;
  const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
    source,
    cfg,
    account,
  });

  const message = event.message;
  const messageId = message.id;
  const timestamp = event.timestamp;

  const textContent = extractMessageText(message);
  const placeholder = extractMediaPlaceholder(message);

  let rawBody = textContent || placeholder;
  if (!rawBody && allMedia.length > 0) {
    rawBody = `<media:image>${allMedia.length > 1 ? ` (${allMedia.length} images)` : ""}`;
  }

  if (!rawBody && allMedia.length === 0) {
    return null;
  }

  let locationContext: ReturnType<typeof toLocationContext> | undefined;
  if (message.type === "location") {
    const loc = message;
    locationContext = toLocationContext({
      latitude: loc.latitude,
      longitude: loc.longitude,
      name: loc.title,
      address: loc.address,
    });
  }

  const historyKey = isGroup ? peerId : undefined;
  const inboundHistory =
    historyKey && groupHistories && (historyLimit ?? 0) > 0
      ? (groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const { ctxPayload } = await finalizeLineInboundContext({
    cfg,
    account,
    event,
    route,
    source: { userId, groupId, roomId, isGroup, peerId },
    rawBody,
    timestamp,
    messageSid: messageId,
    commandAuthorized,
    media: {
      firstPath: allMedia[0]?.path,
      firstContentType: allMedia[0]?.contentType,
      paths: allMedia.length > 0 ? allMedia.map((m) => m.path) : undefined,
      types:
        allMedia.length > 0
          ? (allMedia.map((m) => m.contentType).filter(Boolean) as string[])
          : undefined,
    },
    locationContext,
    verboseLog: { kind: "inbound", mediaCount: allMedia.length },
    inboundHistory,
  });

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
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  commandAuthorized: boolean;
}) {
  const { event, cfg, account, commandAuthorized } = params;

  const source = event.source;
  const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
    source,
    cfg,
    account,
  });

  const timestamp = event.timestamp;
  const rawData = event.postback?.data?.trim() ?? "";
  if (!rawData) {
    return null;
  }
  let rawBody = rawData;
  if (rawData.includes("line.action=")) {
    const searchParams = new URLSearchParams(rawData);
    const action = searchParams.get("line.action") ?? "";
    const device = searchParams.get("line.device");
    rawBody = device ? `line action ${action} device ${device}` : `line action ${action}`;
  }

  const messageSid = event.replyToken ? `postback:${event.replyToken}` : `postback:${timestamp}`;
  const { ctxPayload } = await finalizeLineInboundContext({
    cfg,
    account,
    event,
    route,
    source: { userId, groupId, roomId, isGroup, peerId },
    rawBody,
    timestamp,
    messageSid,
    commandAuthorized,
    media: {
      firstPath: "",
      firstContentType: undefined,
      paths: undefined,
      types: undefined,
    },
    verboseLog: { kind: "postback" },
  });

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
