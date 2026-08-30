// Line plugin module implements bot message context behavior.
import type { webhook } from "@line/bot-sdk";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  buildChannelInboundEventContext,
  formatInboundMediaUnavailableText,
  formatInboundEnvelope,
  formatLocationText,
  resolveInboundSessionEnvelopeContext,
  toInboundMediaFactsWithMetadata,
  toLocationContext,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  ensureConfiguredBindingRouteReady,
  resolvePinnedMainDmOwnerFromAllowlist,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute, resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeStringEntries,
  readNonEmptyStringPreservingWhitespace,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeAllowFrom } from "./bot-access.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { resolveLineMentionStrippedText } from "./mentions.js";
import { getLineGroupName, getUserProfile } from "./send.js";
import type { ResolvedLineAccount } from "./types.js";

type EventSource = webhook.Source | undefined;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type StickerEventMessage = webhook.StickerMessageContent;

type MediaRef = Pick<ChannelInboundMediaInput, "contentType" | "fileName"> & { path: string };

interface BuildLineMessageContextParams {
  event: MessageEvent;
  allMedia: MediaRef[];
  mediaUnavailable?: boolean;
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  commandAuthorized: boolean;
  resolveChannelIngress?: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
  channelIngress?: ResolvedChannelMessageIngress;
  inboundHistory?: HistoryEntry[];
  buildContext?: typeof buildChannelInboundEventContext;
}

type LineSourceInfo = {
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

  const runtimeRoute = resolveRuntimeConversationBindingRoute({
    route,
    conversation: {
      channel: "line",
      accountId: params.account.accountId,
      conversationId: peerId,
    },
  });
  route = runtimeRoute.route;
  if (runtimeRoute.bindingRecord) {
    configuredBinding = null;
    logVerbose(
      runtimeRoute.boundSessionKey
        ? `line: routed via bound conversation ${peerId} -> ${runtimeRoute.boundSessionKey}`
        : `line: plugin-bound conversation ${peerId}`,
    );
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

/**
 * Describe a sticker from what its webhook actually carries: LINE sends up to
 * 15 keywords for the sticker, and a message sticker also carries the sender's
 * own text. The package name is not among those facts and cannot be derived
 * from the package id, so it is not part of the description.
 */
function describeLineSticker(sticker: StickerEventMessage): string {
  // Sender-authored text is authoritative; LINE's experimental keywords are a
  // random selection and only describe stickers that carry no sender text.
  const description =
    readNonEmptyStringPreservingWhitespace(sticker.text) ??
    normalizeStringEntries(sticker.keywords ?? [])
      .slice(0, 3)
      .join(", ");
  return description ? `[Sent a sticker: ${description}]` : "[Sent a sticker]";
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
    return describeLineSticker(message);
  }
  return "";
}

/**
 * Renders a message the group's mention gate kept as context instead of
 * answering. It carries the facts an answered turn would have read, so a
 * following mention still knows what was said; only kinds whose content lives
 * entirely in the attachment fall back to naming the kind.
 */
export function describeLineMessageForHistory(message: MessageEvent["message"]): string {
  const text = extractMessageText(message);
  if (text) {
    return text;
  }
  const fileName = message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
  return fileName ? `<file: ${fileName}>` : `<${message.type}>`;
}

function extractNativeMediaKind(
  message: MessageEvent["message"],
): ChannelInboundMediaInput["kind"] | undefined {
  switch (message.type) {
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "file":
      return "document";
    default:
      return undefined;
  }
}

type LineRouteInfo = ReturnType<typeof resolveAgentRoute>;
type LineSourceInfoWithPeerId = LineSourceInfo & { peerId: string };

async function finalizeLineInboundContext(params: {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  event: MessageEvent | PostbackEvent;
  route: LineRouteInfo;
  source: LineSourceInfoWithPeerId;
  rawBody: string;
  agentBody?: string;
  commandBody?: string;
  timestamp: number;
  messageSid: string;
  commandAuthorized: boolean;
  channelIngress?: ResolvedChannelMessageIngress;
  media: readonly ChannelInboundMediaInput[];
  locationContext?: ReturnType<typeof toLocationContext>;
  verboseLog: { kind: "inbound" | "postback"; mediaCount?: number };
  inboundHistory?: Pick<HistoryEntry, "sender" | "body" | "timestamp">[];
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const senderId = params.source.userId ?? "unknown";
  const clientOpts = {
    cfg: params.cfg,
    accountId: params.account.accountId,
    channelAccessToken: params.account.channelAccessToken,
  };
  // A LINE webhook carries no display name and no group name, so both are
  // separate lookups. They are cached, they run in parallel, and either one
  // failing degrades to the raw id rather than failing the turn.
  const [senderName, groupName] = await Promise.all([
    params.source.userId
      ? getUserProfile(params.source.userId, {
          ...clientOpts,
          groupId: params.source.groupId,
          roomId: params.source.roomId,
        }).then((profile) => profile?.displayName)
      : undefined,
    params.source.groupId ? getLineGroupName(params.source.groupId, clientOpts) : undefined,
  ]);
  const senderLabel =
    senderName ?? (params.source.userId ? `user:${params.source.userId}` : "unknown");
  const conversationLabel = params.source.isGroup
    ? (groupName ??
      (params.source.groupId
        ? `group:${params.source.groupId}`
        : params.source.roomId
          ? `room:${params.source.roomId}`
          : "unknown-group"))
    : senderLabel;
  const address = params.source.groupId
    ? `line:group:${params.source.groupId}`
    : params.source.roomId
      ? `line:room:${params.source.roomId}`
      : `line:${params.source.userId ?? params.source.peerId}`;

  const groupConfig = params.source.isGroup
    ? resolveLineGroupConfigEntry(params.account.config.groups, {
        groupId: params.source.groupId,
        roomId: params.source.roomId,
      })
    : undefined;

  const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
  });

  const agentBody = params.agentBody ?? params.rawBody;
  const media =
    params.media.length === 0 ? [] : await toInboundMediaFactsWithMetadata(params.media);
  const body = formatInboundEnvelope({
    channel: "LINE",
    from: conversationLabel,
    timestamp: params.timestamp,
    body: agentBody,
    chatType: params.source.isGroup ? "group" : "direct",
    sender: {
      id: senderId,
      name: senderName,
    },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const ctxPayload = (params.buildContext ?? buildChannelInboundEventContext)({
    channelIngress: params.channelIngress,
    channel: "line",
    accountId: params.route.accountId,
    messageId: params.messageSid,
    timestamp: params.timestamp,
    from: address,
    sender: { id: senderId, name: senderName },
    conversation: {
      kind: params.source.isGroup ? "group" : "direct",
      id: params.source.peerId,
      label: conversationLabel,
    },
    route: {
      agentId: params.route.agentId,
      dmScope: params.route.dmScope,
      accountId: params.route.accountId,
      routeSessionKey: params.route.sessionKey,
    },
    reply: { to: address, originatingTo: address },
    message: {
      body,
      bodyForAgent: agentBody,
      rawBody: params.rawBody,
      commandBody: params.commandBody ?? params.rawBody,
      inboundHistory: params.inboundHistory,
    },
    access: { commands: { authorized: params.commandAuthorized } },
    media,
    extra: {
      ...params.locationContext,
      GroupSubject: params.source.isGroup
        ? (groupName ?? params.source.groupId ?? params.source.roomId)
        : undefined,
      GroupSystemPrompt: normalizeOptionalString(groupConfig?.systemPrompt),
    },
  });

  const pinnedMainDmOwner = !params.source.isGroup
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: params.cfg.session?.dmScope,
        allowFrom: params.account.config.allowFrom,
        normalizeEntry: (entry) => normalizeAllowFrom([entry]).entries[0],
      })
    : null;
  const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
    route: params.route,
    sessionKey: params.route.sessionKey,
  });
  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(body, 200).replace(/\n/g, "\\n");
    const mediaInfo =
      params.verboseLog.kind === "inbound" && (params.verboseLog.mediaCount ?? 0) > 1
        ? ` mediaCount=${params.verboseLog.mediaCount}`
        : "";
    const label = params.verboseLog.kind === "inbound" ? "line inbound" : "line postback";
    logVerbose(
      `${label}: from=${ctxPayload.From} len=${body.length}${mediaInfo} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    replyToken: (params.event as { replyToken: string }).replyToken,
    // A group's configured skill scope belongs to the turn that answers it.
    skillFilter: groupConfig?.skills,
    turn: {
      storePath,
      record: {
        updateLastRoute: !params.source.isGroup
          ? {
              sessionKey: inboundLastRouteSessionKey,
              channel: "line",
              to: params.source.userId ?? params.source.peerId,
              accountId: params.route.accountId,
              mainDmOwnerPin:
                inboundLastRouteSessionKey === params.route.mainSessionKey &&
                pinnedMainDmOwner &&
                params.source.userId
                  ? {
                      ownerRecipient: pinnedMainDmOwner,
                      senderRecipient: params.source.userId,
                      onSkip: ({
                        ownerRecipient,
                        senderRecipient,
                      }: {
                        ownerRecipient: string;
                        senderRecipient: string;
                      }) => {
                        logVerbose(
                          `line: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                        );
                      },
                    }
                  : undefined,
            }
          : undefined,
        onRecordError: (err: unknown) => {
          logVerbose(`line: failed updating session meta: ${String(err)}`);
        },
      },
    },
  };
}

export async function buildLineMessageContext(params: BuildLineMessageContextParams) {
  const { event, allMedia, mediaUnavailable, cfg, account, commandAuthorized, inboundHistory } =
    params;

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
  const nativeMediaKind = extractNativeMediaKind(message);
  const mediaFacts: ChannelInboundMediaInput[] =
    allMedia.length > 0
      ? allMedia.map((media) => ({ ...media, kind: nativeMediaKind }))
      : nativeMediaKind
        ? [{ kind: nativeMediaKind }]
        : [];
  const rawBody = textContent;
  const agentBody = mediaUnavailable
    ? formatInboundMediaUnavailableText({
        body: rawBody,
        notice: "[line attachment unavailable]",
      })
    : rawBody;

  if (!agentBody && mediaFacts.length === 0) {
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

  const finalized = await finalizeLineInboundContext({
    cfg,
    account,
    event,
    route,
    source: { userId, groupId, roomId, isGroup, peerId },
    rawBody,
    agentBody,
    // The agent still reads the message as sent; only command parsing drops the
    // mention, which LINE requires before a group message reaches the bot.
    commandBody: resolveLineMentionStrippedText(message) || rawBody,
    timestamp,
    messageSid: messageId,
    commandAuthorized,
    // Configured conversation bindings can replace the base route; bind only to the final route.
    channelIngress: params.resolveChannelIngress
      ? await params.resolveChannelIngress({
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          messageId,
          inboundEventKind: "user_request",
        })
      : params.channelIngress,
    buildContext: params.buildContext,
    media: mediaFacts,
    locationContext,
    verboseLog: { kind: "inbound", mediaCount: allMedia.length },
    inboundHistory,
  });

  return {
    ctxPayload: finalized.ctxPayload,
    turn: finalized.turn,
    skillFilter: finalized.skillFilter,
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
  resolveChannelIngress?: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
  channelIngress?: ResolvedChannelMessageIngress;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const { event, cfg, account, commandAuthorized } = params;

  const source = event.source;
  const { userId, groupId, roomId, isGroup, peerId, route } = await resolveLineInboundRoute({
    source,
    cfg,
    account,
  });

  const timestamp = event.timestamp;
  const rawBody = event.postback?.data?.trim() ?? "";
  if (!rawBody) {
    return null;
  }
  let agentBody = rawBody;
  if (rawBody.includes("line.action=")) {
    const searchParams = new URLSearchParams(rawBody);
    const action = searchParams.get("line.action") ?? "";
    const device = searchParams.get("line.device");
    agentBody = device ? `line action ${action} device ${device}` : `line action ${action}`;
  }
  // LINE returns picker and rich-menu choices separately from callback data.
  // Sort them for stable prompt bytes, but keep rawBody unchanged for command auth.
  for (const [key, value] of Object.entries(event.postback.params ?? {}).toSorted(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const picked = normalizeOptionalString(value);
    if (picked) {
      agentBody += ` ${key}=${picked}`;
    }
  }

  const messageSid = event.replyToken ? `postback:${event.replyToken}` : `postback:${timestamp}`;
  const finalized = await finalizeLineInboundContext({
    cfg,
    account,
    event,
    route,
    source: { userId, groupId, roomId, isGroup, peerId },
    rawBody,
    agentBody,
    timestamp,
    messageSid,
    commandAuthorized,
    // Configured conversation bindings can replace the base route; bind only to the final route.
    channelIngress: params.resolveChannelIngress
      ? await params.resolveChannelIngress({
          agentId: route.agentId,
          sessionKey: route.sessionKey,
          messageId: messageSid,
          inboundEventKind: "user_request",
        })
      : params.channelIngress,
    buildContext: params.buildContext,
    media: [],
    verboseLog: { kind: "postback" },
  });

  return {
    ctxPayload: finalized.ctxPayload,
    turn: finalized.turn,
    skillFilter: finalized.skillFilter,
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

type LineMessageContext = NonNullable<Awaited<ReturnType<typeof buildLineMessageContext>>>;
type LinePostbackContext = NonNullable<Awaited<ReturnType<typeof buildLinePostbackContext>>>;
export type LineInboundContext = LineMessageContext | LinePostbackContext;
