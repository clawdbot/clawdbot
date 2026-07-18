// Irc plugin module implements inbound behavior.
import {
  buildChannelInboundEventContext,
  logInboundDrop,
  resolveChannelInboundRouteEnvelope,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  channelIngressRoutes,
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedIrcAccount } from "./accounts.js";
import { buildIrcAllowlistCandidates, normalizeIrcAllowEntry } from "./normalize.js";
import { resolveIrcGroupMatch, resolveIrcGroupRequireMention } from "./policy.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const CHANNEL_ID = "irc" as const;
const IRC_NICK_KIND = "plugin:irc-nick" as const;
type IrcGroupPolicy = "open" | "allowlist" | "disabled";

const ircIngressIdentity = defineStableChannelIngressIdentity({
  key: "irc-id",
  normalizeEntry: normalizeIrcStableEntry,
  normalizeSubject: normalizeLowercaseStringOrEmpty,
  sensitivity: "pii",
  aliases: [
    {
      key: "irc-id-nick-user",
      kind: "stable-id" as const,
      normalizeEntry: normalizeIrcNickUserEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      dangerous: true,
      sensitivity: "pii" as const,
    },
    {
      key: "irc-id-nick-host",
      kind: "stable-id" as const,
      normalizeEntry: () => null,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      sensitivity: "pii" as const,
    },
    {
      key: "irc-nick",
      kind: IRC_NICK_KIND,
      normalizeEntry: normalizeIrcNickEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      dangerous: true,
      sensitivity: "pii",
    },
  ],
  isWildcardEntry: (entry) => normalizeIrcAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `irc-entry-${entryIndex + 1}:${fieldKey === "irc-nick" ? "nick" : "id"}`,
});

const escapeIrcRegexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isBareNick(value: string): boolean {
  return !value.includes("!") && !value.includes("@");
}

function hasVerifiedHost(value: string): boolean {
  return value.includes("@");
}

function isHostlessNickUser(value: string): boolean {
  return value.includes("!") && !value.includes("@");
}

function normalizeIrcStableEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !hasVerifiedHost(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIrcNickUserEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !isHostlessNickUser(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIrcNickEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !isBareNick(normalized)) {
    return null;
  }
  return normalized;
}

function hasEntries(entries: Array<string | number> | undefined): boolean {
  return normalizeStringEntries(entries).some((entry) => normalizeIrcAllowEntry(entry));
}

function createIrcIngressSubject(message: IrcInboundMessage) {
  const candidates = buildIrcAllowlistCandidates(message, { allowNameMatching: true });
  const stableCandidates = candidates.filter((candidate) => hasVerifiedHost(candidate));
  const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
  return {
    stableId: stableCandidates[stableCandidates.length - 1] ?? nick,
    aliases: {
      "irc-id-nick-user": candidates.find((candidate) => isHostlessNickUser(candidate)),
      "irc-id-nick-host": stableCandidates.find(
        (candidate) => !candidate.includes("!") && candidate.includes("@"),
      ),
      "irc-nick": nick,
    },
  };
}

function routeDescriptorsForIrcGroup(params: {
  isGroup: boolean;
  groupPolicy: IrcGroupPolicy;
  groupAllowed: boolean;
  hasConfiguredGroups: boolean;
  groupEnabled: boolean;
  routeGroupAllowFrom: string[];
}) {
  if (!params.isGroup) {
    return [];
  }
  return channelIngressRoutes(
    params.groupPolicy === "allowlist" && {
      id: "irc:channel",
      allowed: params.hasConfiguredGroups && params.groupAllowed,
      precedence: 0,
      matchId: "irc-channel",
      blockReason: "channel_not_allowlisted",
    },
    !params.groupEnabled && {
      id: "irc:channel-enabled",
      enabled: false,
      precedence: 10,
      blockReason: "channel_disabled",
    },
    hasEntries(params.routeGroupAllowFrom) && {
      id: "irc:channel-sender",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.routeGroupAllowFrom,
    },
  );
}

async function deliverIrcReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageIrc(params.target, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
}

export async function handleIrcInbound(params: {
  message: IrcInboundMessage;
  account: ResolvedIrcAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  connectedNick?: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, connectedNick, statusSink } = params;
  const core = getIrcRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderHost
    ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}`
    : message.senderNick;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.irc !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "irc",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (messageLocal) => runtime.log?.(messageLocal),
  });

  const groupMatch = resolveIrcGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const mentionNick = connectedNick?.trim() || account.nick;
  const explicitMentionRegex = mentionNick
    ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i")
    : null;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) ||
    (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
  const requireMention = message.isGroup
    ? resolveIrcGroupRequireMention({ groups: account.config.groups, target: message.target })
    : false;
  const routeGroupAllowFrom = normalizeStringEntries(
    groupMatch.groupConfig?.allowFrom?.length
      ? groupMatch.groupConfig.allowFrom
      : groupMatch.wildcardConfig?.allowFrom,
  );
  const accessGroupPolicy: IrcGroupPolicy =
    groupPolicy === "open" &&
    (hasEntries(account.config.groupAllowFrom) || hasEntries(routeGroupAllowFrom))
      ? "allowlist"
      : groupPolicy;
  const access = await createChannelIngressResolver({
    channelId: CHANNEL_ID,
    accountId: account.accountId,
    identity: ircIngressIdentity,
    cfg: config as OpenClawConfig,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
  }).message({
    subject: createIrcIngressSubject(message),
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: message.target,
    },
    route: routeDescriptorsForIrcGroup({
      isGroup: message.isGroup,
      groupPolicy,
      groupAllowed: groupMatch.allowed,
      hasConfiguredGroups: groupMatch.hasConfiguredGroups,
      groupEnabled:
        groupMatch.groupConfig?.enabled !== false && groupMatch.wildcardConfig?.enabled !== false,
      routeGroupAllowFrom,
    }),
    mentionFacts: message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: wasMentioned,
        }
      : undefined,
    dmPolicy,
    groupPolicy: accessGroupPolicy,
    policy: {
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
      activation: {
        requireMention: message.isGroup && requireMention,
        allowTextCommands,
      },
    },
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    command: {
      allowTextCommands,
      hasControlCommand,
    },
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: normalizeLowercaseStringOrEmpty(senderDisplay),
      senderIdLine: `Your IRC id: ${senderDisplay}`,
      meta: { name: message.senderNick || undefined },
      sendPairingReply: async (text) => {
        await deliverIrcReply({
          payload: { text },
          cfg: config,
          target: message.senderNick,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
      },
    });
    runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`irc: drop channel ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }
    if (message.isGroup) {
      if (access.routeAccess.reason === "channel_not_allowlisted") {
        runtime.log?.(`irc: drop channel ${message.target} (not allowlisted)`);
      } else if (access.routeAccess.reason === "channel_disabled") {
        runtime.log?.(`irc: drop channel ${message.target} (disabled)`);
      } else {
        runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  const channelTarget =
    message.target.startsWith("#") || message.target.startsWith("&")
      ? message.target
      : `#${message.target}`;
  const peerId = message.isGroup ? channelTarget : message.senderNick;
  const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.target : senderDisplay;
  const body = buildEnvelope({
    channel: "IRC",
    from: fromLabel,
    timestamp: message.timestamp,
    body: rawBody,
  });

  const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(account.config);

  const ctxPayload = buildChannelInboundEventContext({
    channel: CHANNEL_ID,
    accountId: route.accountId,
    messageId: message.messageId,
    timestamp: message.timestamp,
    from: message.isGroup ? `channel:${channelTarget}` : `irc:${senderDisplay}`,
    sender: { id: senderDisplay, name: message.senderNick || undefined },
    conversation: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
      label: fromLabel,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to: message.isGroup ? `channel:${channelTarget}` : `irc:${peerId}`,
      originatingTo: message.isGroup ? `channel:${channelTarget}` : `irc:${peerId}`,
    },
    message: { body, bodyForAgent: rawBody, rawBody, commandBody: rawBody },
    access: {
      commands: { authorized: commandAuthorized },
      mentions: { canDetectMention: message.isGroup, wasMentioned },
    },
    extra: {
      GroupSubject: message.isGroup ? message.target : undefined,
      GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    },
  });

  await core.channel.inbound.dispatch({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route: { agentId: route.agentId, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      deliver: async (payload) => {
        await deliverIrcReply({
          payload,
          cfg: config,
          target: peerId,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline: {},
    replyOptions: {
      skillFilter: groupMatch.groupConfig?.skills,
      disableBlockStreaming:
        typeof blockStreamingEnabled === "boolean" ? !blockStreamingEnabled : undefined,
    },
    record: {
      onRecordError: (err) => {
        runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
      },
    },
  });
}
