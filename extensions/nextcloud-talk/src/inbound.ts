import {
  buildChannelInboundEventContext,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
// Nextcloud Talk plugin module implements inbound behavior.
import {
  channelIngressRoutes,
  resolveStableChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  bindIngressLifecycleToReplyOptions,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
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
  resolveNextcloudTalkGroupRequireMention,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import { resolveNextcloudTalkRoomKind } from "./room-info.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import { sendMessageNextcloudTalk } from "./send.js";
import type { CoreConfig, NextcloudTalkInboundMessage, NextcloudTalkRoomConfig } from "./types.js";

export type NextcloudTalkMentionEntry = {
  key: string;
  type?: string;
  id?: string;
  mentionId?: string;
  name?: string;
};

export type ParsedNextcloudTalkBody = {
  /** Human-readable text with `{mentionN}` placeholders stripped or substituted. */
  text: string;
  /** True when the original message was structured JSON (as opposed to plain text). */
  structured: boolean;
  mentionEntries: NextcloudTalkMentionEntry[];
};

export function parseStructuredNextcloudTalkBody(
  raw: string,
  botIds?: ReadonlySet<string>,
): ParsedNextcloudTalkBody {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return { text: raw, structured: false, mentionEntries: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      parameters?: Record<
        string,
        {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          "mention-id"?: unknown;
          mentionId?: unknown;
        }
      >;
    };
    const rawMessage = typeof parsed.message === "string" ? parsed.message : raw;
    const parameters =
      parsed.parameters && typeof parsed.parameters === "object" ? parsed.parameters : {};
    const mentionEntries = Object.entries(parameters).map(([key, value]) => ({
      key,
      type: typeof value?.type === "string" ? value.type : undefined,
      id: typeof value?.id === "string" ? value.id : undefined,
      mentionId:
        typeof value?.["mention-id"] === "string"
          ? value["mention-id"]
          : typeof value?.mentionId === "string"
            ? value.mentionId
            : undefined,
      name: typeof value?.name === "string" ? value.name : undefined,
    }));
    // Strip the bot's own mention placeholder so command parsing and agent
    // dispatch see clean text. Non-bot user mentions and non-user rich objects
    // (calls, files, links) are substituted with their display name so the
    // agent sees the content the user saw.
    const text = mentionEntries
      .reduce((acc, entry) => {
        const isUser = (entry.type ?? "").toLowerCase() === "user";
        const isBotMention =
          isUser &&
          botIds !== undefined &&
          [entry.id, entry.mentionId]
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .map((v) => v.trim().toLowerCase())
            .some((v) => botIds.has(v));
        const replacement = isBotMention ? "" : (entry.name ?? "");
        return acc.replace(new RegExp(`\\{${entry.key}\\}`, "g"), replacement);
      }, rawMessage)
      .trim();
    return { text, structured: true, mentionEntries };
  } catch {
    return { text: raw, structured: false, mentionEntries: [] };
  }
}

function buildNextcloudTalkBotIds(account: ResolvedNextcloudTalkAccount): Set<string> {
  const ids = new Set<string>();
  const accountId = account.accountId.trim().toLowerCase();
  if (accountId) {
    ids.add(accountId);
  }
  const configuredApiUser = account.config.apiUser?.trim().toLowerCase();
  if (configuredApiUser) {
    ids.add(configuredApiUser);
    const apiLocalPart = configuredApiUser.split("@")[0]?.trim();
    if (apiLocalPart) {
      ids.add(apiLocalPart.toLowerCase());
    }
  }
  return ids;
}

export function resolveExplicitNextcloudTalkMention(params: {
  mentionEntries: NextcloudTalkMentionEntry[];
  account: ResolvedNextcloudTalkAccount;
}): boolean {
  const expectedIds = buildNextcloudTalkBotIds(params.account);
  return params.mentionEntries.some((entry) => {
    if ((entry.type ?? "").toLowerCase() !== "user") {
      return false;
    }
    const candidates = [entry.id, entry.mentionId]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    return candidates.some((candidate) => expectedIds.has(candidate));
  });
}

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
}): Promise<{ visibleReplySent: boolean }> {
  const { cfg, payload, roomToken, accountId, statusSink } = params;
  const visibleReplySent = await deliverFormattedTextWithAttachments({
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
  return { visibleReplySent };
}

export async function handleNextcloudTalkInbound(params: {
  message: NextcloudTalkInboundMessage;
  account: ResolvedNextcloudTalkAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  turnAdoptionLifecycle?: Parameters<typeof bindIngressLifecycleToReplyOptions>[0];
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
  const botIds = buildNextcloudTalkBotIds(account);
  const parsedBody = parseStructuredNextcloudTalkBody(rawBody, botIds);
  // For structured bodies use the stripped/substituted text; fall back to rawBody for plain text.
  const effectiveBody = parsedBody.structured ? parsedBody.text : rawBody;
  if (!effectiveBody) {
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
  const hasControlCommand = core.channel.text.hasControlCommand(
    effectiveBody,
    config as OpenClawConfig,
  );
  const shouldRequireMention = isGroup
    ? resolveNextcloudTalkGroupRequireMention({
        cfg: config as OpenClawConfig,
        accountId: account.accountId,
        groupId: roomToken,
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
    log: (messageValue) => runtime.log?.(messageValue),
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
  } else if (access.senderAccess.decision !== "allow") {
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

  if (access.commandAccess.shouldBlockControlCommand) {
    logInboundDrop({
      log: (messageLocal) => runtime.log?.(messageLocal),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  // A structured message that is nothing but mention placeholders produces an empty
  // effectiveBody after stripping. Treat it as a mention-only ping with no actionable
  // content and drop it silently — the agent has nothing to respond to.
  if (parsedBody.structured && effectiveBody === "") {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (mention-only, no message body)`);
    return;
  }

  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const explicitMention = resolveExplicitNextcloudTalkMention({
    mentionEntries: parsedBody.mentionEntries,
    account,
  });
  const wasMentioned =
    explicitMention ||
    (mentionRegexes.length
      ? core.channel.mentions.matchesMentionPatterns(effectiveBody, mentionRegexes)
      : false);
  if (isGroup) {
    access = await resolveAccess(wasMentioned);
  }

  if (isGroup && access.activationAccess.shouldSkip) {
    runtime.log?.(`nextcloud-talk: drop room ${roomToken} (no mention)`);
    return;
  }
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? roomToken : senderId,
    },
  });

  const fromLabel = isGroup ? `room:${roomName || roomToken}` : senderName || `user:${senderId}`;
  const body = buildEnvelope({
    channel: "Nextcloud Talk",
    from: fromLabel,
    timestamp: message.timestamp,
    body: effectiveBody,
  });

  const groupSystemPrompt = normalizeOptionalString(roomConfig?.systemPrompt);
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);

  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: message.messageId,
    timestamp: message.timestamp,
    from: isGroup ? `nextcloud-talk:room:${roomToken}` : `nextcloud-talk:${senderId}`,
    sender: { id: senderId, name: senderName || undefined },
    conversation: { kind: isGroup ? "group" : "direct", id: roomToken, label: fromLabel },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: { to: `nextcloud-talk:${roomToken}`, originatingTo: `nextcloud-talk:${roomToken}` },
    message: {
      body,
      bodyForAgent: effectiveBody,
      rawBody: effectiveBody,
      commandBody: effectiveBody,
    },
    access: {
      commands: { authorized: commandAuthorized },
      mentions: { canDetectMention: isGroup, wasMentioned: isGroup && wasMentioned },
    },
    extra: {
      GroupSubject: isGroup ? roomName || roomToken : undefined,
      GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    },
  });

  await core.channel.inbound.dispatch({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      preparePayload: (payload) =>
        payload.text === undefined
          ? payload
          : {
              ...payload,
              text: sanitizeAssistantVisibleText(payload.text),
            },
      deliver: async (payload) => {
        return await deliverNextcloudTalkReply({
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
      ...(params.turnAdoptionLifecycle
        ? bindIngressLifecycleToReplyOptions(params.turnAdoptionLifecycle)
        : {}),
      skillFilter: roomConfig?.skills,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
      // Nextcloud Talk bots reply directly in the room — automatic delivery is
      // always correct here. Without this, group chats fall back to
      // "message_tool_only" mode which suppresses the reply when the message
      // tool has no applicable actions for this channel.
      sourceReplyDeliveryMode: "automatic",
    },
    record: {
      onRecordError: (err) => {
        runtime.error?.(`nextcloud-talk: failed updating session meta: ${String(err)}`);
      },
    },
  });
}
