import type {
  WebhookEvent,
  MessageEvent,
  FollowEvent,
  UnfollowEvent,
  JoinEvent,
  LeaveEvent,
  PostbackEvent,
  EventSource,
} from "@line/bot-sdk";
import type { MoltbotConfig } from "../config/config.js";
import { danger, logVerbose } from "../globals.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import { buildPairingReply } from "../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  buildLineMessageContext,
  buildLinePostbackContext,
  type LineInboundContext,
} from "./bot-message-context.js";
import { firstDefined, isSenderAllowed, normalizeAllowFromWithStore } from "./bot-access.js";
import { downloadLineMedia } from "./download.js";
import { pushMessageLine, replyMessageLine } from "./send.js";
import type { LineGroupConfig, ResolvedLineAccount } from "./types.js";

interface MediaRef {
  path: string;
  contentType?: string;
}

export interface LineHandlerContext {
  cfg: MoltbotConfig;
  account: ResolvedLineAccount;
  runtime: RuntimeEnv;
  mediaMaxBytes: number;
  processMessage: (ctx: LineInboundContext) => Promise<void>;
}

type LineSourceInfo = {
  userId?: string;
  groupId?: string;
  roomId?: string;
  isGroup: boolean;
};

function getSourceInfo(source: EventSource): LineSourceInfo {
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

function resolveLineGroupConfig(params: {
  config: ResolvedLineAccount["config"];
  groupId?: string;
  roomId?: string;
}): LineGroupConfig | undefined {
  const groups = params.config.groups ?? {};
  if (params.groupId) {
    return groups[params.groupId] ?? groups[`group:${params.groupId}`] ?? groups["*"];
  }
  if (params.roomId) {
    return groups[params.roomId] ?? groups[`room:${params.roomId}`] ?? groups["*"];
  }
  return groups["*"];
}

async function sendLinePairingReply(params: {
  senderId: string;
  replyToken?: string;
  context: LineHandlerContext;
}): Promise<void> {
  const { senderId, replyToken, context } = params;
  const { code, created } = await upsertChannelPairingRequest({
    channel: "line",
    id: senderId,
  });
  if (!created) return;
  logVerbose(`line pairing request sender=${senderId}`);
  const idLabel = (() => {
    try {
      return resolvePairingIdLabel("line");
    } catch {
      return "lineUserId";
    }
  })();
  const text = buildPairingReply({
    channel: "line",
    idLine: `Your ${idLabel}: ${senderId}`,
    code,
  });
  try {
    if (replyToken) {
      await replyMessageLine(replyToken, [{ type: "text", text }], {
        accountId: context.account.accountId,
        channelAccessToken: context.account.channelAccessToken,
      });
      return;
    }
  } catch (err) {
    logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
  }
  try {
    await pushMessageLine(`line:${senderId}`, text, {
      accountId: context.account.accountId,
      channelAccessToken: context.account.channelAccessToken,
    });
  } catch (err) {
    logVerbose(`line pairing reply failed for ${senderId}: ${String(err)}`);
  }
}

async function shouldProcessLineEvent(
  event: MessageEvent | PostbackEvent,
  context: LineHandlerContext,
): Promise<boolean> {
  const { cfg, account } = context;
  const { userId, groupId, roomId, isGroup } = getSourceInfo(event.source);
  const senderId = userId ?? "";

  const storeAllowFrom = await readChannelAllowFromStore("line").catch(() => []);
  const effectiveDmAllow = normalizeAllowFromWithStore({
    allowFrom: account.config.allowFrom,
    storeAllowFrom,
  });
  const groupConfig = resolveLineGroupConfig({ config: account.config, groupId, roomId });
  const groupAllowOverride = groupConfig?.allowFrom;
  const fallbackGroupAllowFrom = account.config.allowFrom?.length
    ? account.config.allowFrom
    : undefined;
  const groupAllowFrom = firstDefined(
    groupAllowOverride,
    account.config.groupAllowFrom,
    fallbackGroupAllowFrom,
  );
  const effectiveGroupAllow = normalizeAllowFromWithStore({
    allowFrom: groupAllowFrom,
    storeAllowFrom,
  });
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  if (isGroup) {
    if (groupConfig?.enabled === false) {
      logVerbose(`Blocked line group ${groupId ?? roomId ?? "unknown"} (group disabled)`);
      return false;
    }
    if (typeof groupAllowOverride !== "undefined") {
      if (!senderId) {
        logVerbose("Blocked line group message (group allowFrom override, no sender ID)");
        return false;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked line group sender ${senderId} (group allowFrom override)`);
        return false;
      }
    }
    if (groupPolicy === "disabled") {
      logVerbose("Blocked line group message (groupPolicy: disabled)");
      return false;
    }
    if (groupPolicy === "allowlist") {
      if (!senderId) {
        logVerbose("Blocked line group message (no sender ID, groupPolicy: allowlist)");
        return false;
      }
      if (!effectiveGroupAllow.hasEntries) {
        logVerbose("Blocked line group message (groupPolicy: allowlist, no groupAllowFrom)");
        return false;
      }
      if (!isSenderAllowed({ allow: effectiveGroupAllow, senderId })) {
        logVerbose(`Blocked line group message from ${senderId} (groupPolicy: allowlist)`);
        return false;
      }
    }
    return true;
  }

  if (dmPolicy === "disabled") {
    logVerbose("Blocked line sender (dmPolicy: disabled)");
    return false;
  }

  const dmAllowed = dmPolicy === "open" || isSenderAllowed({ allow: effectiveDmAllow, senderId });
  if (!dmAllowed) {
    if (dmPolicy === "pairing") {
      if (!senderId) {
        logVerbose("Blocked line sender (dmPolicy: pairing, no sender ID)");
        return false;
      }
      await sendLinePairingReply({
        senderId,
        replyToken: "replyToken" in event ? event.replyToken : undefined,
        context,
      });
    } else {
      logVerbose(`Blocked line sender ${senderId || "unknown"} (dmPolicy: ${dmPolicy})`);
    }
    return false;
  }

  return true;
}

async function handleMessageEvent(event: MessageEvent, context: LineHandlerContext): Promise<void> {
  const { cfg, account, runtime, mediaMaxBytes, processMessage } = context;
  const message = event.message;

  if (!(await shouldProcessLineEvent(event, context))) return;

  // Download media if applicable
  const allMedia: MediaRef[] = [];

  if (message.type === "image" || message.type === "video" || message.type === "audio") {
    try {
      const media = await downloadLineMedia(message.id, account.channelAccessToken, mediaMaxBytes);
      allMedia.push({
        path: media.path,
        contentType: media.contentType,
      });
    } catch (err) {
      const errMsg = String(err);
      if (errMsg.includes("exceeds") && errMsg.includes("limit")) {
        logVerbose(`line: media exceeds size limit for message ${message.id}`);
        // Continue without media
      } else {
        runtime.error?.(danger(`line: failed to download media: ${errMsg}`));
      }
    }
  }

  const messageContext = await buildLineMessageContext({
    event,
    allMedia,
    cfg,
    account,
  });

  if (!messageContext) {
    logVerbose("line: skipping empty message");
    return;
  }

  await processMessage(messageContext);
}

async function handleFollowEvent(event: FollowEvent, _context: LineHandlerContext): Promise<void> {
  const userId = event.source.type === "user" ? event.source.userId : undefined;
  logVerbose(`line: user ${userId ?? "unknown"} followed`);
  // Could implement welcome message here
}

async function handleUnfollowEvent(
  event: UnfollowEvent,
  _context: LineHandlerContext,
): Promise<void> {
  const userId = event.source.type === "user" ? event.source.userId : undefined;
  logVerbose(`line: user ${userId ?? "unknown"} unfollowed`);
}

async function handleJoinEvent(event: JoinEvent, _context: LineHandlerContext): Promise<void> {
  const groupId = event.source.type === "group" ? event.source.groupId : undefined;
  const roomId = event.source.type === "room" ? event.source.roomId : undefined;
  logVerbose(`line: bot joined ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handleLeaveEvent(event: LeaveEvent, _context: LineHandlerContext): Promise<void> {
  const groupId = event.source.type === "group" ? event.source.groupId : undefined;
  const roomId = event.source.type === "room" ? event.source.roomId : undefined;
  logVerbose(`line: bot left ${groupId ? `group ${groupId}` : `room ${roomId}`}`);
}

async function handlePostbackEvent(
  event: PostbackEvent,
  context: LineHandlerContext,
): Promise<void> {
  const data = event.postback.data;
  logVerbose(`line: received postback: ${data}`);

  if (!(await shouldProcessLineEvent(event, context))) return;

  const postbackContext = await buildLinePostbackContext({
    event,
    cfg: context.cfg,
    account: context.account,
  });
  if (!postbackContext) return;

  await context.processMessage(postbackContext);
}

export async function handleLineWebhookEvents(
  events: WebhookEvent[],
  context: LineHandlerContext,
): Promise<void> {
  for (const event of events) {
    try {
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
    } catch (err) {
      context.runtime.error?.(danger(`line: event handler failed: ${String(err)}`));
    }
  }
}
