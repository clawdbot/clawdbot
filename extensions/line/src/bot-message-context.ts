// Line plugin module implements bot message context behavior.
import type { webhook } from "@line/bot-sdk";
import { resolveAccessGroupAllowFromState } from "openclaw/plugin-sdk/access-groups";
import { isSenderIdAllowed } from "openclaw/plugin-sdk/allow-from";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import {
  buildChannelInboundEventContext,
  formatInboundMediaUnavailableText,
  resolveInboundSupplementalSenderAllowed,
  formatInboundEnvelope,
  formatLocationText,
  resolveInboundSessionEnvelopeContext,
  toInboundMediaFactsWithMetadata,
  toLocationContext,
  type BuildChannelInboundEventContextParams,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import type {
  ChannelIngressContextBinding,
  ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
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
import { normalizeAllowFrom, normalizeLineAllowEntry } from "./bot-access.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { resolveLineMentionStrippedText } from "./mentions.js";
import {
  readLineQuotedMessageId,
  resolveLineQuotedMessage,
  type LineQuotedMessage,
} from "./quoted-messages.js";
import { getLineGroupName, getUserProfile } from "./send.js";
import type { ResolvedLineAccount } from "./types.js";

type EventSource = webhook.Source | undefined;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type StickerEventMessage = webhook.StickerMessageContent;

type MediaRef = Pick<ChannelInboundMediaInput, "contentType" | "fileName"> & { path: string };

export type LineInboundMentionAccess = NonNullable<
  NonNullable<BuildChannelInboundEventContextParams["access"]>["mentions"]
>;

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
  /** Group gate the event was admitted under, re-read for a quoted sender. */
  groupPolicy: GroupPolicy;
  groupAllowFrom: readonly string[];
  inboundHistory?: HistoryEntry[];
  mentions?: LineInboundMentionAccess;
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

/** The chat a LINE event belongs to: its group, its room, or the direct peer. */
export function resolveLineConversationId(source: EventSource): string {
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
  const peerId = resolveLineConversationId(params.source);
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

export function readLineTextMessageBody(message: webhook.TextMessageContent): string {
  let text = message.text;
  // LINE can send an empty "()" alternative; retain meaningful alternatives.
  // Replace from the end so LINE's UTF-16 offsets survive earlier replacements.
  for (const { index, length } of (message.emojis ?? []).toSorted((a, b) => b.index - a.index)) {
    if (index >= 0 && length === 2 && text.slice(index, index + length) === "()") {
      text = `${text.slice(0, index)}[emoji]${text.slice(index + length)}`;
    }
  }
  return text;
}

function extractMessageText(message: MessageEvent["message"]): string {
  if (message.type === "text") {
    return readLineTextMessageBody(message);
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

function isLineSenderNamedBy(allowFrom: readonly string[], senderId: string | undefined): boolean {
  // An empty group allowlist under an allowlist policy names nobody, so an
  // unresolvable sender stays out rather than defaulting open.
  return isSenderIdAllowed(
    normalizeAllowFrom([...allowFrom]),
    senderId ? normalizeLineAllowEntry(senderId) : undefined,
    false,
  );
}

/**
 * Matches a quoted message's author against the group allowlist as configured
 * right now. The bot's own message needs no entry; an id the store no longer
 * resolves has no author to match and stays out of a restricted prompt.
 * `viaAccessGroup` carries the same group expansion admission ran for the
 * turn's own sender, which an exact-match list cannot do on a symbolic entry.
 */
function isLineQuoteSenderAllowed(
  allowFrom: readonly string[],
  quoted: LineQuotedMessage | undefined,
  viaAccessGroup: boolean,
): boolean {
  if (!quoted) {
    return false;
  }
  if (quoted.fromBot || viaAccessGroup) {
    return true;
  }
  return isLineSenderNamedBy(allowFrom, quoted.senderId);
}

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
  /**
   * An inbound quote and the group gate its sender must still pass. Absent on
   * paths that cannot carry a quote, so there is no policy-free quote to build.
   */
  quote?: { messageId: string; groupPolicy: GroupPolicy; allowFrom: readonly string[] };
  verboseLog: { kind: "inbound" | "postback"; mediaCount?: number };
  inboundHistory?: Pick<HistoryEntry, "sender" | "body" | "timestamp">[];
  mentions?: LineInboundMentionAccess;
  buildContext?: typeof buildChannelInboundEventContext;
}) {
  const senderId = params.source.userId ?? "unknown";
  const clientOpts = {
    cfg: params.cfg,
    accountId: params.account.accountId,
    channelAccessToken: params.account.channelAccessToken,
  };
  // LINE names a quoted message by id alone, so its text and author come from
  // what this account already saw. An id it no longer holds still reaches the
  // agent as a bare quote under the default visibility mode; a restrictive mode
  // has no sender to clear and drops the quote with it.
  const quoted = resolveLineQuotedMessage(
    params.account.accountId,
    params.quote?.messageId,
    params.source.peerId,
  );
  // A LINE webhook carries no display name and no group name, so both are
  // separate lookups. They are cached, they run in parallel, and either one
  // failing degrades to the raw id rather than failing the turn.
  const resolveDisplayName = (userId: string | undefined) =>
    userId
      ? getUserProfile(userId, {
          ...clientOpts,
          groupId: params.source.groupId,
          roomId: params.source.roomId,
        }).then((profile) => profile?.displayName)
      : undefined;
  // `groupAllowFrom` can name a group instead of a person. Admission expands
  // that for the turn's own sender, so the quoted author needs the same
  // expansion or a member authorized only through their group reads as unnamed.
  const resolveQuotedSenderAccessGroup = async () => {
    if (!params.quote || !quoted?.senderId || quoted.fromBot) {
      return false;
    }
    const state = await resolveAccessGroupAllowFromState({
      accessGroups: params.cfg.accessGroups,
      allowFrom: [...params.quote.allowFrom],
      channel: "line",
      accountId: params.account.accountId,
      senderId: quoted.senderId,
      isSenderAllowed: (memberId, groupMembers) => isLineSenderNamedBy(groupMembers, memberId),
    });
    return state.hasMatch;
  };
  const [senderName, groupName, quotedSenderName, quotedSenderViaAccessGroup] = await Promise.all([
    resolveDisplayName(params.source.userId),
    params.source.groupId ? getLineGroupName(params.source.groupId, clientOpts) : undefined,
    resolveDisplayName(quoted?.senderId),
    resolveQuotedSenderAccessGroup(),
  ]);
  // An unreachable LINE profile must not erase the author: the quoted sender
  // degrades to the raw id the same way the turn's own sender does below.
  const quotedSenderLabel =
    quotedSenderName ?? (quoted?.senderId ? `user:${quoted.senderId}` : undefined);
  // Admission only proves the quoted sender passed the gate when the message was
  // stored. That gate can narrow while the store still holds their text, so the
  // active allowlist decides again here.
  const quoteFacts = params.quote
    ? {
        id: params.quote.messageId,
        isQuote: true,
        senderAllowed: resolveInboundSupplementalSenderAllowed({
          isGroup: params.source.isGroup,
          groupPolicy: params.quote.groupPolicy,
          allowFrom: params.quote.allowFrom,
          isSenderAllowed: (allowFrom) =>
            isLineQuoteSenderAllowed(allowFrom, quoted, quotedSenderViaAccessGroup),
        }),
        // A quote of the bot's own message keeps its linkage without a body:
        // the store holds no outbound text, matching the core default that
        // never repeats an assistant message the transcript already carries.
        ...(quoted?.body ? { body: quoted.body } : {}),
        ...(quotedSenderLabel ? { sender: quotedSenderLabel } : {}),
      }
    : undefined;
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
    access: { commands: { authorized: params.commandAuthorized }, mentions: params.mentions },
    media,
    contextVisibility: resolveChannelContextVisibilityMode({
      cfg: params.cfg,
      channel: "line",
      accountId: params.account.accountId,
    }),
    supplemental: quoteFacts ? { quote: quoteFacts } : undefined,
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
  const quotedMessageId = readLineQuotedMessageId(message);
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
    mentions: params.mentions,
    timestamp,
    messageSid: messageId,
    commandAuthorized,
    // Configured conversation bindings can replace the base route; bind only to the final route.
    channelIngress: await params.resolveChannelIngress?.({
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId,
      inboundEventKind: "user_request",
    }),
    buildContext: params.buildContext,
    media: mediaFacts,
    locationContext,
    quote: quotedMessageId
      ? {
          messageId: quotedMessageId,
          groupPolicy: params.groupPolicy,
          allowFrom: params.groupAllowFrom,
        }
      : undefined,
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
    channelIngress: await params.resolveChannelIngress?.({
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      messageId: messageSid,
      inboundEventKind: "user_request",
    }),
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
