// Line plugin module implements bot handlers behavior.
import type { webhook } from "@line/bot-sdk";
import { buildMentionRegexes, matchesMentionPatterns } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth-native";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readChannelAllowFromStore,
  resolvePairingIdLabel,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
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
import { downloadLineMedia } from "./download.js";
import { reserveLineGroupHistory } from "./group-history.js";
import { resolveLineGroupConfigEntry } from "./group-keys.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";
import type { LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";

type FollowEvent = webhook.FollowEvent;
type JoinEvent = webhook.JoinEvent;
type LeaveEvent = webhook.LeaveEvent;
type MessageEvent = webhook.MessageEvent;
type PostbackEvent = webhook.PostbackEvent;
type UnfollowEvent = webhook.UnfollowEvent;
type WebhookEvent = webhook.Event;

interface MediaRef {
  path: string;
  contentType?: string;
}

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
) {
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getLineSourceInfo(event.source);
  const senderId = userId ?? "";
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const rawText = resolveEventRawText(event);
  const requireMention = isGroup ? groupConfig?.requireMention !== false : false;
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.line !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
    });
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
  const access = await resolveStableChannelMessageIngress({
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
    return access;
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

function getLineMentionees(
  message: MessageEvent["message"],
): Array<{ type?: string; isSelf?: boolean }> {
  if (message.type !== "text") {
    return [];
  }
  const mentionees = (
    message as Record<string, unknown> & {
      mention?: { mentionees?: Array<{ type?: string; isSelf?: boolean }> };
    }
  ).mention?.mentionees;
  return Array.isArray(mentionees) ? mentionees : [];
}

function isLineBotMentioned(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).some((m) => m.isSelf === true || m.type === "all");
}

function hasAnyLineMention(message: MessageEvent["message"]): boolean {
  return getLineMentionees(message).length > 0;
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
  if (isGroup && decision.activationAccess.shouldSkip) {
    const rawText = message.type === "text" ? message.text : "";
    const sourceInfo = getLineSourceInfo(event.source);
    logVerbose(`line: skipping group message (requireMention, not mentioned)`);
    const historyKey = groupId ?? roomId;
    const senderId = sourceInfo.userId ?? "unknown";
    if (historyKey && context.groupHistories) {
      createChannelHistoryWindow({ historyMap: context.groupHistories }).record({
        historyKey,
        limit: context.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
        entry: {
          sender: `user:${senderId}`,
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
      try {
        const originalFilename =
          message.type === "file" ? normalizeOptionalString(message.fileName) : undefined;
        const media = await downloadLineMedia(
          message.id,
          account.channelAccessToken,
          mediaMaxBytes,
          { originalFilename },
        );
        allMedia.push({
          path: media.path,
          contentType: media.contentType,
        });
      } catch (err) {
        mediaUnavailable = true;
        const errMsg = String(err);
        if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
          logVerbose(`line: media exceeds size limit for message ${message.id}`);
        } else {
          runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
        }
      }
    }

    const messageContext = await buildLineMessageContext({
      event,
      allMedia,
      mediaUnavailable,
      cfg,
      account,
      commandAuthorized: decision.commandAccess.authorized,
      inboundHistory: historyReservation.inboundHistory,
    });

    if (!messageContext) {
      logVerbose("line: skipping empty message");
      return;
    }

    await processMessage(
      messageContext,
      context.turnAdoptionLifecycle ? { turnAdoptionLifecycle: context.turnAdoptionLifecycle } : {},
    );
    historyReservation.commit();
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

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const { groupId, roomId } = getLineSourceInfo(event.source);
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
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
    commandAuthorized: decision.commandAccess.authorized,
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
    throw toLintErrorObject(firstError, "Non-Error thrown");
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

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
