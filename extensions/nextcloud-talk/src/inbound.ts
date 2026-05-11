import {
  channelIngressRoutes,
  resolveStableChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  createChannelPairingController,
  deliverFormattedTextWithAttachments,
  logInboundDrop,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type GroupPolicy,
  type OpenClawConfig,
  type OutboundReplyPayload,
  type RuntimeEnv,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowEntry,
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkRequireMention,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage, NextcloudTalkRoomConfig } from "./types.js";

const CHANNEL_ID = "nextcloud-talk" as const;

type NextcloudTalkRoomMatch = ReturnType<typeof resolveNextcloudTalkRoomMatch>;

function hasAllowEntries(entries: string[]): boolean {
  return normalizeNextcloudTalkAllowlist(entries).length > 0;
}

function roomRoutes(params: {
  isGroup: boolean;
  groupPolicy: GroupPolicy;
  roomMatch: NextcloudTalkRoomMatch;
  roomConfig?: NextcloudTalkRoomConfig;
  senderId: string;
  outerGroupAllowFrom: string[];
  roomAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  const roomSenderConfigured =
    params.groupPolicy === "allowlist" && hasAllowEntries(params.roomAllowFrom);
  return channelIngressRoutes(
    params.roomMatch.allowlistConfigured && {
      id: "nextcloud-talk:room",
      allowed: params.roomMatch.allowed,
      precedence: 0,
      matchId: "nextcloud-talk-room",
      blockReason: "room_not_allowlisted",
    },
    params.roomConfig?.enabled === false && {
      id: "nextcloud-talk:room-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "room_disabled",
    },
    roomSenderConfigured && {
      id: "nextcloud-talk:room-sender",
      kind: "nestedAllowlist",
      precedence: 20,
      blockReason: "room_sender_not_allowlisted",
      ...(!hasAllowEntries(params.outerGroupAllowFrom)
        ? {
            senderPolicy: "replace" as const,
            senderAllowFrom: params.roomAllowFrom,
          }
        : {
            allowed: resolveNextcloudTalkAllowlistMatch({
              allowFrom: params.roomAllowFrom,
              senderId: params.senderId,
            }).allowed,
            matchId: "nextcloud-talk-room-sender",
          }),
    },
  );
}

async function deliverNextcloudTalkReply(params: {
  cfg: CoreConfig;
  payload: OutboundReplyPayload;
  roomToken: string;
  accountId: string;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { cfg, payload, roomToken, accountId, statusSink } = params;
  await deliverFormattedTextWithAttachments({
    payload,
    send: async ({ text, replyToId }) => {
      await sendMessageNextcloudTalk(roomToken, text, {
        cfg,
        accountId,
        replyTo: replyToId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
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
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  const roomKind = await resolveNextcloudTalkRoomKind({
    account,
    roomToken: message.roomToken,
    runtime,
  });
  const isGroup = roomKind === "direct" ? false : roomKind === "group" ? true : message.isGroupChat;
  const senderId = message.senderId;
  const senderName = message.senderName;
  const roomToken = message.roomToken;
  const roomName = message.roomName;

  statusSink?.({ lastInboundAt: message.timestamp });

  const roomMatch = resolveNextcloudTalkRoomMatch({
    rooms: account.config.rooms,
    roomToken,
  });
  const roomConfig = roomMatch.roomConfig;
  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkRequireMention({
        roomConfig,
        wildcardConfig: roomMatch.wildcardConfig,
      })
    : false;
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((config.channels as Record<string, unknown> | undefined)?.[CHANNEL_ID] ?? undefined) !==
        undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(config as OpenClawConfig),
    });
  const allowFrom = normalizeStringEntries(account.config.allowFrom);
  const outerGroupAllowFrom = account.config.groupAllowFrom?.length
    ? normalizeStringEntries(account.config.groupAllowFrom)
    : allowFrom;
  const roomAllowFrom = normalizeStringEntries(roomConfig?.allowFrom);
  const resolveAccess = async (wasMentioned?: boolean) =>
    await resolveStableChannelMessageIngress({
      channelId: CHANNEL_ID,
      accountId: account.accountId,
      identity: {
        key: "nextcloud-talk-user-id",
        normalize: (value) => normalizeNextcloudTalkAllowEntry(value) || null,
        sensitivity: "pii",
        entryIdPrefix: "nextcloud-talk-entry",
      },
      cfg: config as OpenClawConfig,
      readStoreAllowFrom: async () =>
        await pairing.readStoreForDmPolicy(CHANNEL_ID, account.accountId),
      subject: { stableId: senderId },
      conversation: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? roomToken : senderId,
      },
      route: roomRoutes({
        isGroup,
        groupPolicy,
        roomMatch,
        roomConfig,
        senderId,
        outerGroupAllowFrom,
        roomAllowFrom,
      }),
      dmPolicy: account.config.dmPolicy ?? "pairing",
      groupPolicy,
      policy: {
        groupAllowFromFallbackToAllowFrom: true,
        activation: {
          requireMention: isGroup && shouldRequireMention,
          allowTextCommands,
        },
      },
      mentionFacts:
        isGroup && wasMentioned !== undefined
          ? {
              canDetectMention: true,
              wasMentioned,
              hasAnyMention: wasMentioned,
            }
          : undefined,
      allowFrom,
      groupAllowFrom: account.config.groupAllowFrom,
      command: {
        allowTextCommands,
        hasControlCommand,
      },
    });
  let access = await resolveAccess();
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "nextcloud-talk",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => runtime.log?.(message),
  });
  const commandAuthorized = access.commandAccess.authorized;
  const accessReason =
    access.ingress.reasonCode === "route_blocked"
      ? "route blocked"
      : access.senderAccess.reasonCode;

  if (isGroup) {
    if (access.routeAccess.reason === "room_not_allowlisted") {
      runtime.log?.(`nextcloud-talk: drop room ${roomToken} (not allowlisted)`);
      return;
    }
    if (access.routeAccess.reason === "room_disabled") {
      runtime.log?.(`nextcloud-talk: drop room ${roomToken} (disabled)`);
      return;
    }
    if (access.routeAccess.reason === "room_sender_not_allowlisted") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (policy=${groupPolicy})`);
      return;
    }
    if (access.senderAccess.decision !== "allow") {
      runtime.log?.(`nextcloud-talk: drop group sender ${senderId} (reason=${accessReason})`);
      return;
    }
  } else {
    if (access.senderAccess.decision !== "allow") {
      if (access.senderAccess.decision === "pairing") {
        await pairing.issueChallenge({
          senderId,
          senderIdLine: `Your Nextcloud user id: ${senderId}`,
          meta: { name: senderName || undefined },
          sendPairingReply: async (text) => {
            await sendMessageNextcloudTalk(roomToken, text, {
              cfg: config,
              accountId: account.accountId,
            });
            statusSink?.({ lastOutboundAt: Date.now() });
          },
          onReplyError: (err) => {
            runtime.error?.(`nextcloud-talk: pairing reply failed for ${senderId}: ${String(err)}`);
          },
        });
      }
      runtime.log?.(`nextcloud-talk: drop DM sender ${senderId} (reason=${accessReason})`);
      return;
    }
  }

  if (access.commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: (message) => runtime.log?.(message),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const wasMentioned = mentionRegexes.length
    ? core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes)
    : false;
  if (isGroup) {
    access = await resolveAccess(wasMentioned);
  }

  if (isGroup && access.activationAccess.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
    runtime: core.channel,
    sessionStore: (config.session as Record<string, unknown> | undefined)?.store as
      | string
      | undefined,
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const { storePath, body } = buildEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
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

  await core.channel.turn.runAssembled({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      deliver: async (payload) => {
        await deliverNextcloudTalkReply({
          cfg: config,
          payload,
          roomToken,
          accountId: account.accountId,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`nextcloud-talk ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline: {},
    replyOptions: {
      skillFilter: roomConfig?.skills,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
    },
    record: {
      onRecordError: (err) => {
        runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
      },
    },
  });
}
