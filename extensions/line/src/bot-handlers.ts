// Line plugin module implements bot handlers behavior.
import type { webhook } from "@line/bot-sdk";
import {
  type buildChannelInboundEventContext,
  buildMentionRegexes,
  isChannelPartialDeliveryError,
  matchesMentionPatterns,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  resolveStableChannelMessageIngress,
  type ChannelIngressContextBinding,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { reportChannelRoomJoin } from "openclaw/plugin-sdk/channel-join-intro-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth-native";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { firstDefined, normalizeLineAllowEntry } from "./bot-access.js";
import {
  buildLineMessageContext,
  buildLinePostbackContext,
  getLineSourceInfo,
  type LineInboundContext,
} from "./bot-message-context.js";
import { downloadLineMedia, isRetryableLineInboundMediaError } from "./download.js";
import { reserveLineGroupHistory } from "./group-history.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { createLineImageSetBuffer } from "./inbound-image-set.js";
import { hasAnyLineMention, isLineBotMentioned } from "./mentions.js";
import { getLineGroupName, getUserDisplayName, pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";
import type { LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";

type FollowEvent = webhook.FollowEvent;
type JoinEvent = webhook.JoinEvent;
type LeaveEvent = webhook.LeaveEvent;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type UnfollowEvent = webhook.UnfollowEvent;
type WebhookEvent = webhook.Event;

type MediaRef = Pick<ChannelInboundMediaInput, "contentType" | "fileName"> & { path: string };

// Process-wide: LINE delivers each part of an image set as its own webhook
// request, so the parts of one send never share a handler invocation.
const bufferLineImageSetPart = createLineImageSetBuffer<{
  media: readonly MediaRef[];
  mediaUnavailable: boolean;
  lifecycle?: LineWebhookTurnAdoptionLifecycle;
}>();

const LINE_DOWNLOADABLE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "file",
]);

function isDownloadableLineMessageType(
  messageType: MessageEvent["message"]["type"],
): messageType is "image" | "video" | "audio" | "file" {
  return LINE_DOWNLOADABLE_MESSAGE_TYPES.has(messageType);
}

interface LineHandlerContext {
  cfg: OpenClawConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  buildContext?: typeof buildChannelInboundEventContext;
  mediaMaxBytes: number;
  processMessage: (
    ctx: LineInboundContext,
    control: { turnAdoptionLifecycle?: LineWebhookTurnAdoptionLifecycle },
  ) => Promise<void>;
  turnAdoptionLifecycle?: LineWebhookTurnAdoptionLifecycle;
  groupHistories?: Map<string, HistoryEntry[]>;
  historyLimit?: number;
}

function normalizeLineIngressEntry(value: string): string | null {
  return normalizeLineAllowEntry(value) || null;
}

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  return resolveLineGroupConfigEntry(params.config.groups, {
    groupId: params.groupId,
    roomId: params.roomId,
  });
}

function resolveLineRuntimeGroupPolicy({ cfg, account }: LineHandlerContext) {
  return resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.line !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  });
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  await createChannelPairingChallengeIssuer({
    channel: "line",
    accountId: context.account.accountId,
    upsertPairingRequest: async ({ id, meta }) =>
      await upsertChannelPairingRequest({
        channel: "line",
        id,
        accountId: context.account.accountId,
        meta,
      }),
  })({
    senderId,
    senderIdLine: `Your ${idLabel}: ${senderId}`,
    onCreated: () => {
      logVerbose(`line pairing request sender=${senderId}`);
    },
    sendPairingReply: async (text) => {
      if (replyToken) {
        try {
          await replyMessageLine(replyToken, [{ type: "text", text }], {
            cfg: context.cfg,
            accountId: context.account.accountId,
            channelAccessToken: context.account.channelAccessToken,
          });
          return;
        } catch (err) {
          logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
          // A visible reply survived failed bookkeeping; a fallback push would duplicate it.
          if (isChannelPartialDeliveryError(err)) {
            return;
          }
        }
      }
      try {
        await pushMessageLine(`line:${senderId}`, text, {
          cfg: context.cfg,
          accountId: context.account.accountId,
          channelAccessToken: context.account.channelAccessToken,
        });
      } catch (err) {
        logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
      }
    },
  });
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
): Promise<{
  access: ResolvedChannelMessageIngress;
  resolveBoundAccess: (
    contextBinding: ChannelIngressContextBinding,
  ) => Promise<ResolvedChannelMessageIngress>;
} | null> {
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const rawText = resolveEventRawText(event);
  const requireMention = isGroup ? groupConfig?.requireMention !== false : false;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } =
    resolveLineRuntimeGroupPolicy(context);
  const groupPolicy: GroupPolicy =
    runtimeGroupPolicy === "disabled"
      ? "disabled"
      : groupConfig?.allowFrom !== undefined
        ? "allowlist"
        : runtimeGroupPolicy;
  // LINE group allowlists are scoped separately from DM allowFrom.
  // The shared ingress policy below intentionally keeps fallback disabled.
  const groupAllowFrom = normalizeStringEntries(
    firstDefined(groupConfig?.allowFrom, account.config.groupAllowFrom),
  );
  const mentionFacts = (() => {
    if (!isGroup || event.type !== "message") {
      return { canDetectMention: false, wasMentioned: false, hasAnyMention: false };
    }
    const peerId = groupId ?? roomId ?? userId ?? "unknown";
    const { agentId } = resolveAgentRoute({
      cfg,
      channel: "line",
      accountId: account.accountId,
      peer: { kind: "group", id: peerId },
    });
    const mentionRegexes = buildMentionRegexes(cfg, agentId);
    const wasMentionedByNative = isLineBotMentioned(event.message);
    const wasMentionedByPattern =
      event.message.type === "text" ? matchesMentionPatterns(rawText, mentionRegexes) : false;
    return {
      canDetectMention: event.message.type === "text",
      wasMentioned: wasMentionedByNative || wasMentionedByPattern,
      hasAnyMention: hasAnyLineMention(event.message),
    };
  })();
  const resolveAccess = async (contextBinding?: ChannelIngressContextBinding) =>
    await resolveStableChannelMessageIngress({
      channelId: "line",
      accountId: account.accountId,
      identity: {
        key: "line-user-id",
        normalize: normalizeLineIngressEntry,
        sensitivity: "pii",
        entryIdPrefix: "line-entry",
      },
      cfg,
      readStoreAllowFrom: async () =>
        await readChannelAllowFromStore("line", undefined, account.accountId),
      subject: { stableId: senderId },
      conversation: {
        kind: isGroup ? "group" : "direct",
        id: (groupId ?? roomId ?? senderId) || "unknown",
      },
      ...(contextBinding ? { contextBinding } : {}),
      ...(isGroup && groupConfig?.enabled === false
        ? { route: { id: "line:group-config", enabled: false } }
        : {}),
      mentionFacts:
        isGroup && event.type === "message"
          ? {
              canDetectMention: mentionFacts.canDetectMention,
              wasMentioned: mentionFacts.wasMentioned,
              hasAnyMention: mentionFacts.hasAnyMention,
              implicitMentionKinds: [],
            }
          : undefined,
      event: { kind: event.type === "postback" ? "postback" : "message" },
      dmPolicy,
      groupPolicy,
      policy: {
        groupAllowFromFallbackToAllowFrom: false,
        activation: {
          requireMention: isGroup && event.type === "message" && requireMention,
          allowTextCommands: true,
        },
      },
      allowFrom: normalizeStringEntries(account.config.allowFrom),
      groupAllowFrom,
      command: {
        hasControlCommand: hasControlCommand(rawText, cfg),
        groupOwnerAllowFrom: "none",
      },
    });
  const access = await resolveAccess();
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "line",
    accountId: account.accountId,
    log: (message) => logVerbose(message),
  });

  if (
    access.senderAccess.decision === "allow" &&
    (access.ingress.admission === "dispatch" ||
      access.ingress.admission === "observe" ||
      access.ingress.admission === "skip")
  ) {
    return { access, resolveBoundAccess: resolveAccess };
  }

  if (access.senderAccess.decision === "allow") {
    logVerbose(`Blocked line event (${access.ingress.reasonCode})`);
    return null;
  }

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return null;
    }
    if (groupConfig?.allowFrom !== undefined) {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return null;
      }
      if (access.senderAccess.reasonCode !== "group_policy_allowed") {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return null;
      }
    }
    if (access.senderAccess.reasonCode === "group_policy_disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
    } else if (!senderId && groupPolicy === "allowlist") {
      logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
    } else if (access.senderAccess.reasonCode === "group_policy_empty_allowlist") {
      logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
    } else {
      logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
    }
    return null;
  }

  if (access.senderAccess.reasonCode === "dm_policy_disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return null;
  }

  if (access.senderAccess.decision === "pairing") {
    if (!senderId) {
      logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
      return null;
    }
    await sendLinePairingReply({
      senderId,
      replyToken: "replyToken" in event ? event.replyToken : undefined,
      context,
    });
    return null;
  }

  logVerbose(
    `Blocked line sender ${senderId || "unknown"} (dmPolicy: ${
      account.config.dmPolicy ?? "pairing"
    })`,
  );
  return null;
}

function resolveEventRawText(event: MessageEvent | PostbackEvent): string {
  if (event.type === "message") {
    const msg = event.message;
    if (msg.type === "text") {
      return msg.text;
    }
    return "";
  }
  if (event.type === "postback") {
    return event.postback?.data?.trim() ?? "";
  }
  return "";
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
  const message = event.message;

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const { isGroup, groupId, roomId } = getLineSourceInfo(event.source);
  if (isGroup && decision.access.activationAccess.shouldSkip) {
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    logVerbose(`line: skipping group message (requireMention, not mentioned)`);
    const historyKey = groupId ?? roomId;
    const senderId = sourceInfo.userId ?? "unknown";
    if (historyKey && context.groupHistories) {
      const displayName = sourceInfo.userId
        ? await getUserDisplayName(sourceInfo.userId, {
            cfg,
            accountId: account.accountId,
            channelAccessToken: account.channelAccessToken,
            groupId,
            roomId,
          })
        : senderId;
      // History has one sender string; keep the stable ID when display names collide.
      const sender = displayName === senderId ? senderId : `${displayName} (${senderId})`;
      createChannelHistoryWindow({ historyMap: context.groupHistories }).record({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        entry: {
          sender,
          body: rawText || `<${message.type}>`,
          timestamp: event.timestamp,
        },
      });
    }
    return;
  }

  // Reserve the group window before any await below. Concurrent ambient and
  // mention events see only unreserved entries; failed turns release theirs.
  const groupHistoryKey = isGroup ? (groupId ?? roomId) : undefined;
  const historyReservation = reserveLineGroupHistory(
    context.groupHistories,
    groupHistoryKey,
    context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  try {
    const allMedia: MediaRef[] = [];
    let mediaUnavailable = false;
    if (isDownloadableLineMessageType(message.type)) {
      const abortSignal = context.turnAdoptionLifecycle?.abortSignal;
      try {
        const originalFilename =
          message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
        const media = await downloadLineMedia(
          message.id,
          account.channelAccessToken,
          mediaMaxBytes,
          { originalFilename, ...(abortSignal ? { signal: abortSignal } : {}) },
        );
        abortSignal?.throwIfAborted();
        allMedia.push({
          path: media.path,
          contentType: media.contentType,
          // LINE names only file messages; the model needs that name to answer
          // questions that refer to the attachment by it.
          ...(originalFilename ? { fileName: originalFilename } : {}),
        });
      } catch (err) {
        if (abortSignal?.aborted) {
          throw abortSignal.reason;
        }
        if (isRetryableLineInboundMediaError(err)) {
          // Preparation-phase failure before turn adoption: reject so the durable
          // ingress drain retries the whole event once LINE finishes preparing the
          // media, instead of degrading it to an unavailable-attachment notice that
          // permanently loses media with no text fallback.
          throw err;
        }
        mediaUnavailable = true;
        const errMsg = String(err);
        if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
          logVerbose(`line: media exceeds size limit for message ${message.id}`);
        } else {
          runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
        }
      }
    }

    const dispatchTurn = async (params: {
      media: readonly MediaRef[];
      mediaUnavailable: boolean;
      /** The lifecycle this turn adopts; an image set hands over a composite one. */
      lifecycle?: LineWebhookTurnAdoptionLifecycle;
    }): Promise<boolean> => {
      const messageContext = await buildLineMessageContext({
        event,
        allMedia: [...params.media],
        mediaUnavailable: params.mediaUnavailable,
        cfg,
        account,
        commandAuthorized: decision.access.commandAccess.authorized,
        resolveChannelIngress: decision.resolveBoundAccess,
        inboundHistory: historyReservation.inboundHistory,
        buildContext: context.buildContext,
      });

      if (!messageContext) {
        logVerbose("line: skipping empty message");
        return false;
      }

      await processMessage(
        messageContext,
        params.lifecycle ? { turnAdoptionLifecycle: params.lifecycle } : {},
      );
      return true;
    };

    const imageSet = message.type === "image" ? message.imageSet : undefined;
    if (imageSet) {
      // Release this event's ingress lane before waiting. LINE lanes are per
      // sender, group or room, so the rest of the set would queue behind this
      // part and the set could never form. The claim itself stays held, and this
      // dispatch stays open until the set is whole, so the combined turn runs
      // under a live adoption rather than after every part has been answered.
      context.turnAdoptionLifecycle?.onDeferred();
      const parts = await bufferLineImageSetPart({
        key: `${account.accountId}:${imageSet.id}`,
        messageId: message.id,
        index: imageSet.index,
        total: imageSet.total,
        part: {
          media: allMedia,
          mediaUnavailable,
          lifecycle: context.turnAdoptionLifecycle,
        },
      });
      if (!parts) {
        // Another part holds this set and will deliver it and settle this claim.
        return;
      }
      // One lifecycle standing for every buffered part, so core's real adoption
      // or abandonment settles them all. Settling them here instead would adopt
      // each source the moment processMessage returns - which happens while a
      // combined turn is still queued behind an active reply - and would abandon
      // them after a terminal partial reply, replaying what the user already saw.
      const sources = parts.map((entry) => entry.lifecycle).filter((l) => l !== undefined);
      const combinedLifecycle: LineWebhookTurnAdoptionLifecycle | undefined =
        context.turnAdoptionLifecycle && {
          ...context.turnAdoptionLifecycle,
          onAdopted: async () => {
            for (const source of sources) {
              await source.onAdopted();
            }
          },
          onDeferred: () => {
            for (const source of sources) {
              source.onDeferred();
            }
          },
          onAbandoned: async () => {
            for (const source of sources) {
              await source.onAbandoned();
            }
          },
        };
      if (
        await dispatchTurn({
          media: parts.flatMap((entry) => entry.media),
          mediaUnavailable: parts.some((entry) => entry.mediaUnavailable),
          lifecycle: combinedLifecycle,
        })
      ) {
        historyReservation.commit();
      }
      return;
    }

    if (
      await dispatchTurn({
        media: allMedia,
        mediaUnavailable,
        ...(context.turnAdoptionLifecycle ? { lifecycle: context.turnAdoptionLifecycle } : {}),
      })
    ) {
      historyReservation.commit();
    }
  } finally {
    historyReservation.release();
  }
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const { userId } = getLineSourceInfo(event.source);
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, context: LineHandlerContext): Promise<void> {
  const { groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const conversationId = groupId ?? roomId;
  if (!isGroup || !conversationId) {
    return;
  }
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
  const { cfg, account } = context;
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  // LINE allowlists authorize human senders, not the bot's own join; only
  // conversation policy and the room's enabled state apply here.
  const roomAllowed =
    resolveLineRuntimeGroupPolicy(context).groupPolicy !== "disabled" &&
    groupConfig?.enabled !== false;
  await reportChannelRoomJoin({
    cfg,
    channel: "line",
    accountId: account.accountId,
    conversationId,
    deliverTo: conversationId,
    route: resolveAgentRoute({
      cfg,
      channel: "line",
      accountId: account.accountId,
      peer: { kind: "group", id: conversationId },
    }),
    roomAllowed,
    resolveRoomContext: async () => {
      // LINE cannot retrieve prior messages, and multi-person rooms have no name API.
      const roomContext = { historyUnavailable: true };
      const title = groupId
        ? await getLineGroupName(groupId, {
            cfg,
            accountId: account.accountId,
            channelAccessToken: account.channelAccessToken,
          })
        : undefined;
      return title ? { ...roomContext, title } : roomContext;
    },
  });
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const data = event.postback.data;
  logVerbose(`line: received postback: ${data}`);

  const decision = await shouldProcessLineEvent(event, context);
  if (!decision) {
    return;
  }

  const postbackContext = await buildLinePostbackContext({
    event,
    cfg: context.cfg,
    account: context.account,
    commandAuthorized: decision.access.commandAccess.authorized,
    resolveChannelIngress: decision.resolveBoundAccess,
    buildContext: context.buildContext,
  });
  if (!postbackContext) {
    return;
  }

  await context.processMessage(
    postbackContext,
    context.turnAdoptionLifecycle ? { turnAdoptionLifecycle: context.turnAdoptionLifecycle } : {},
  );
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  let firstError: unknown;
  for (const event of events) {
    try {
      await handleLineWebhookEvent(event, context);
    } catch (err) {
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
      firstError ??= err;
    }
  }
  if (firstError) {
    throw toErrorObject(firstError, "Non-Error thrown");
  }
}

async function handleLineWebhookEvent(
  event: WebhookEvent,
  context: LineHandlerContext,
): Promise<void> {
  switch (event.type) {
    case "message":
      await handleMessageEvent(event, context);
      break;
    case "follow":
      await handleFollowEvent(event, context);
      break;
    case "unfollow":
      await handleUnfollowEvent(event, context);
      break;
    case "join":
      await handleJoinEvent(event, context);
      break;
    case "leave":
      await handleLeaveEvent(event, context);
      break;
    case "postback":
      await handlePostbackEvent(event, context);
      break;
    default:
      logVerbose(`line: unhandled event type: ${(event as WebhookEvent).type}`);
  }
}
