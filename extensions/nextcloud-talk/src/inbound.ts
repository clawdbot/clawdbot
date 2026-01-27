import {
  logInboundDrop,
  resolveControlCommandGate,
  type MoltbotConfig,
  type RuntimeEnv,
} from "clawdbot/plugin-sdk";

import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkGroupAllow,
  resolveNextcloudTalkMentionGate,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { sendMessageNextcloudTalk } from "./send.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const CHANNEL_ID = "nextcloud-talk" as const;

async function deliverNextcloudTalkReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string; replyToId?: string };
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, roomToken, accountId, statusSink } = params;
  const text = payload.text ?? "";
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (!text.trim() && mediaList.length === 0) return;

  const mediaBlock = mediaList.length
    ? mediaList.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  const combined = text.trim()
    ? mediaBlock
      ? `${text.trim()}\n\n${mediaBlock}`
      : text.trim()
    : mediaBlock;

  await sendMessageNextcloudTalk(roomToken, combined, {
    accountId,
    replyTo: payload.replyToId,
  });
  statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getNextcloudTalkRuntime();

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) return;

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup =
    roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;

  statusSink?.({ lastInboundAt: message.timestamp });

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

  const configAllowFrom = normalizeNextcloudTalkAllowlist(account.config.allowFrom);
  const configGroupAllowFrom = normalizeNextcloudTalkAllowlist(account.config.groupAllowFrom);
  const storeAllowFrom = await core.channel.pairing
    .readAllowFromStore(CHANNEL_ID)
    .catch(() => []);
  const storeAllowList = normalizeNextcloudTalkAllowlist(storeAllowFrom);

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
    roomName,
  });
  const roomConfig = roomMatch.roomConfig;
  if (isGroup && !roomMatch.allowed) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
    return;
  }
  if (roomConfig?.enabled === false) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
    return;
  }

  const roomAllowFrom = normalizeNextcloudTalkAllowlist(roomConfig?.allowFrom);
  const baseGroupAllowFrom =
    configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom;

  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowList].filter(Boolean);
  const effectiveGroupAllowFrom = [...baseGroupAllowFrom, ...storeAllowList].filter(Boolean);

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as MoltbotConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = resolveNextcloudTalkAllowlistMatch({
    allowFrom: isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
    senderId,
    senderName,
  }).allowed;
  const hasControlCommand = core.channel.text.hasControlCommand(
    rawBody,
    config as MoltbotConfig,
  );
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured:
          (isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom).length > 0,
        allowed: senderAllowedForCommands,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isGroup) {
    const groupAllow = resolveNextcloudTalkGroupAllow({
      groupPolicy,
      outerAllowFrom: effectiveGroupAllowFrom,
      innerAllowFrom: roomAllowFrom,
      senderId,
      senderName,
    });
    if (!groupAllow.allowed) {
      runtime.log?.(
        `nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`,
      );
      return;
    }
  } else {
    if (dmPolicy === "disabled") {
      runtime.log?.(`nextcloud-talk: drop DM sender=${senderId} (dmPolicy=disabled)`);
      return;
    }
    if (dmPolicy !== "open") {
      const dmAllowed = resolveNextcloudTalkAllowlistMatch({
        allowFrom: effectiveAllowFrom,
        senderId,
        senderName,
      }).allowed;
      if (!dmAllowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: CHANNEL_ID,
            id: senderId,
            meta: { name: senderName || undefined },
          });
          if (created) {
            try {
              await sendMessageNextcloudTalk(
                roomToken,
                core.channel.pairing.buildPairingReply({
                  channel: CHANNEL_ID,
                  idLine: `Your Nextcloud user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(
                `nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`,
              );
            }
          }
        }
        runtime.log?.(
          `nextcloud-talk: drop DM sender ${senderId} (dmPolicy=${dmPolicy})`,
        );
        return;
      }
    }
  }

  if (isGroup && commandGate.shouldBlock) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(
    config as MoltbotConfig,
  );
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const mentionGate = resolveNextcloudTalkMentionGate({
    isGroup,
    requireMention: shouldRequireMention,
    wasMentioned,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  });
  if (isGroup && mentionGate.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as MoltbotConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: isGroup ? roomToken : senderId,
    },
  });

  const fromLabel = isGroup
    ? `room:${roomName || roomToken}`
    : senderName || `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(
    config as MoltbotConfig,
  );
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = roomConfig?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    To: `nextcloud-talk:${roomToken}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName || undefined,
    SenderId: senderId,
    GroupSubject: isGroup ? roomName || roomToken : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `nextcloud-talk:${roomToken}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as MoltbotConfig,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverNextcloudTalkReply({
          payload: payload as {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
            replyToId?: string;
          },
          roomToken,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(
          `nextcloud-talk ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: {
      skillFilter: roomConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
  });
}
