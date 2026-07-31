import { mergeAllowlist, summarizeMapping } from "openclaw/plugin-sdk/allow-from";
import {
  createChannelInboundEnvelopeBuilder,
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
// Zalouser plugin module implements monitor behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  createChannelHistoryWindow,
} from "openclaw/plugin-sdk/reply-history";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
} from "./group-policy.js";
import { createZalouserIngressMonitor, type ZalouserIngressLifecycle } from "./ingress.js";
import { formatZalouserMessageSidFull, resolveZalouserMessageSid } from "./message-sid.js";
import { getZalouserRuntime } from "./runtime.js";
import {
  sendDeliveredZalouser,
  sendMessageZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import { resolveZalouserDmSessionScope } from "./session-scope.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import {
  listZaloFriends,
  listZaloGroups,
  resolveZaloOwnUserId,
  resolveZaloGroupContext,
  startZaloListener,
} from "./zalo-js.js";

type ZalouserMonitorOptions = {
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  ingressQueue?: Parameters<typeof createZalouserIngressMonitor>[0]["queue"];
};

type ZalouserMonitorResult = {
  stop: () => Promise<void>;
};

const ZALOUSER_TEXT_LIMIT = 2000;

function buildNameIndex<T>(items: T[], nameFn: (item: T) => string | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const name = normalizeOptionalLowercaseString(nameFn(item));
    if (!name) {
      continue;
    }
    const list = index.get(name) ?? [];
    list.push(item);
    index.set(name, list);
  }
  return index;
}

function resolveUserAllowlistEntries(
  entries: string[],
  byName: Map<string, Array<{ userId: string }>>,
): {
  additions: string[];
  mapping: string[];
  unresolved: string[];
} {
  const additions: string[] = [];
  const mapping: string[] = [];
  const unresolved: string[] = [];
  for (const entry of entries) {
    if (/^\d+$/.test(entry)) {
      additions.push(entry);
      continue;
    }
    const matches = byName.get(normalizeLowercaseStringOrEmpty(entry)) ?? [];
    const match = matches[0];
    const id = match?.userId;
    if (id) {
      additions.push(id);
      mapping.push(`${entry}->${id}`);
    } else {
      unresolved.push(entry);
    }
  }
  return { additions, mapping, unresolved };
}

type ZalouserCoreRuntime = ReturnType<typeof getZalouserRuntime>;

type ZalouserGroupHistoryState = {
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
};

function normalizeZalouserAllowEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

function normalizeZalouserSender(value: string): string | null {
  return normalizeOptionalLowercaseString(normalizeZalouserAllowEntry(value)) || null;
}

function resolveZalouserRouteAccess(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  configured: boolean;
  matched: boolean;
  enabled?: boolean;
}): {
  allowed: boolean;
  reason?: "disabled" | "empty_allowlist" | "route_not_allowlisted" | "route_disabled";
} {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (params.matched && params.enabled === false) {
    return { allowed: false, reason: "route_disabled" };
  }
  if (params.groupPolicy !== "allowlist") {
    return { allowed: true };
  }
  if (!params.configured) {
    return { allowed: false, reason: "empty_allowlist" };
  }
  return params.matched ? { allowed: true } : { allowed: false, reason: "route_not_allowlisted" };
}

function senderScopedZalouserGroupPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  groupAllowFrom: readonly string[];
}) {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}

function logVerbose(core: ZalouserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

function resolveGroupRequireMention(params: {
  groupId: string;
  groupName?: string | null;
  groups: Record<string, { enabled?: boolean; requireMention?: boolean }>;
  allowNameMatching?: boolean;
}): boolean {
  const entry = findZalouserGroupEntry(
    params.groups ?? {},
    buildZalouserGroupCandidates({
      groupId: params.groupId,
      groupName: params.groupName,
      includeGroupIdAlias: true,
      includeWildcard: true,
      allowNameMatching: params.allowNameMatching,
    }),
  );
  if (typeof entry?.requireMention === "boolean") {
    return entry.requireMention;
  }
  return true;
}

async function sendZalouserDeliveryAcks(params: {
  profile: string;
  isGroup: boolean;
  message: NonNullable<ZaloInboundMessage["eventMessage"]>;
}): Promise<void> {
  await sendDeliveredZalouser({
    profile: params.profile,
    isGroup: params.isGroup,
    message: params.message,
    isSeen: true,
  });
  await sendSeenZalouser({
    profile: params.profile,
    isGroup: params.isGroup,
    message: params.message,
  });
}

async function processMessage(
  message: ZaloInboundMessage,
  account: ResolvedZalouserAccount,
  config: OpenClawConfig,
  core: ZalouserCoreRuntime,
  runtime: RuntimeEnv,
  historyState: ZalouserGroupHistoryState,
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void,
  turnAdoptionLifecycle?: ZalouserIngressLifecycle,
): Promise<void> {
  const pairing = createChannelPairingController({
    core,
    channel: "zalouser",
    accountId: account.accountId,
  });

  const rawBody = message.content?.trim();
  if (!rawBody) {
    return;
  }
  const commandBody = message.commandContent?.trim() || rawBody;

  const isGroup = message.isGroup;
  const chatId = message.threadId;
  const senderId = message.senderId?.trim();
  if (!senderId) {
    logVerbose(core, runtime, `zalouser: drop message ${chatId} (missing senderId)`);
    return;
  }
  const senderName = message.senderName ?? "";
  const configuredGroupName = message.groupName?.trim() || "";
  const groupContext =
    isGroup && !configuredGroupName
      ? await resolveZaloGroupContext(account.profile, chatId).catch((err: unknown) => {
          logVerbose(
            core,
            runtime,
            `zalouser: group context lookup failed for ${chatId}: ${String(err)}`,
          );
          return null;
        })
      : null;
  const groupName = configuredGroupName || groupContext?.name?.trim() || "";
  const groupMembers = groupContext?.members?.slice(0, 20).join(", ") || undefined;

  if (message.eventMessage) {
    try {
      await sendZalouserDeliveryAcks({
        profile: account.profile,
        isGroup,
        message: message.eventMessage,
      });
    } catch (err) {
      logVerbose(core, runtime, `zalouser: delivery/seen ack failed for ${chatId}: ${String(err)}`);
    }
  }

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: config.channels?.zalouser !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "zalouser",
    accountId: account.accountId,
    log: (entry) => logVerbose(core, runtime, entry),
  });

  const groups = account.config.groups ?? {};
  const routeAllowlistConfigured = Object.keys(groups).length > 0;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  if (isGroup) {
    const groupEntry = findZalouserGroupEntry(
      groups,
      buildZalouserGroupCandidates({
        groupId: chatId,
        groupName,
        includeGroupIdAlias: true,
        includeWildcard: true,
        allowNameMatching,
      }),
    );
    const routeAccess = resolveZalouserRouteAccess({
      groupPolicy,
      configured: routeAllowlistConfigured,
      matched: Boolean(groupEntry),
      enabled: isZalouserGroupEntryAllowed(groupEntry),
    });
    if (!routeAccess.allowed) {
      if (routeAccess.reason === "disabled") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (groupPolicy=disabled)`);
      } else if (routeAccess.reason === "empty_allowlist") {
        logVerbose(
          core,
          runtime,
          `zalouser: drop group ${chatId} (groupPolicy=allowlist, no allowlist)`,
        );
      } else if (routeAccess.reason === "route_not_allowlisted") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (not allowlisted)`);
      } else if (routeAccess.reason === "route_disabled") {
        logVerbose(core, runtime, `zalouser: drop group ${chatId} (group disabled)`);
      }
      return;
    }
  }

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = normalizeStringEntries(account.config.allowFrom);
  const configGroupAllowFrom = normalizeStringEntries(account.config.groupAllowFrom);
  const senderGroupPolicy =
    routeAllowlistConfigured && configGroupAllowFrom.length === 0
      ? groupPolicy
      : senderScopedZalouserGroupPolicy({
          groupPolicy,
          groupAllowFrom: configGroupAllowFrom,
        });
  const shouldComputeCommandAuth = core.channel.commands.shouldComputeCommandAuthorized(
    commandBody,
    config,
  );
  const accessDecision = await resolveStableChannelMessageIngress({
    channelId: "zalouser",
    accountId: account.accountId,
    identity: {
      normalize: normalizeZalouserSender,
      sensitivity: "pii",
      entryIdPrefix: "zalouser-entry",
    },
    cfg: config,
    readStoreAllowFrom: async () => await pairing.readAllowFromStore(),
    subject: { stableId: senderId },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: isGroup ? "group" : senderId,
    },
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    policy: { groupAllowFromFallbackToAllowFrom: false },
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    command: shouldComputeCommandAuth
      ? {
          directGroupAllowFrom: "effective",
          commandGroupAllowFromFallbackToAllowFrom: true,
        }
      : undefined,
  });
  if (isGroup && accessDecision.senderAccess.decision !== "allow") {
    if (accessDecision.senderAccess.reasonCode === "group_policy_empty_allowlist") {
      logVerbose(core, runtime, "Blocked zalouser group message (no group allowlist)");
    } else if (accessDecision.senderAccess.reasonCode === "group_policy_not_allowlisted") {
      logVerbose(
        core,
        runtime,
        `Blocked zalouser sender ${senderId} (not in groupAllowFrom/allowFrom)`,
      );
    }
    return;
  }

  if (!isGroup && accessDecision.senderAccess.decision !== "allow") {
    if (accessDecision.senderAccess.decision === "pairing") {
      await pairing.issueChallenge({
        senderId,
        senderIdLine: `Your Zalo user id: ${senderId}`,
        meta: { name: senderName || undefined },
        onCreated: () => {
          logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessageZalouser(chatId, text, { profile: account.profile });
          statusSink?.({ lastOutboundAt: Date.now() });
        },
        onReplyError: (err) => {
          logVerbose(
            core,
            runtime,
            `zalouser pairing reply failed for ${senderId}: ${String(err)}`,
          );
        },
      });
      return;
    }
    if (accessDecision.senderAccess.reasonCode === "dm_policy_disabled") {
      logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
    } else {
      logVerbose(
        core,
        runtime,
        `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`,
      );
    }
    return;
  }

  const commandAuthorized = accessDecision.commandAccess.requested
    ? accessDecision.commandAccess.authorized
    : undefined;
  const hasControlCommand = core.channel.commands.isControlCommandMessage(commandBody, config);
  if (isGroup && hasControlCommand && commandAuthorized !== true) {
    logVerbose(
      core,
      runtime,
      `zalouser: drop control command from unauthorized sender ${senderId}`,
    );
    return;
  }

  const peer = isGroup
    ? { kind: "group" as const, id: chatId }
    : { kind: "direct" as const, id: senderId };

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "zalouser",
    accountId: account.accountId,
    dmScope: resolveZalouserDmSessionScope(config),
    peer: {
      // Doctor migrates retired group-shaped DM keys; runtime consumes only canonical direct keys.
      kind: peer.kind,
      id: peer.id,
    },
  });
  const historyKey = isGroup ? route.sessionKey : undefined;
  const channelHistory = createChannelHistoryWindow({
    historyMap: historyState.groupHistories,
  });

  const requireMention = isGroup
    ? resolveGroupRequireMention({
        groupId: chatId,
        groupName,
        groups,
        allowNameMatching,
      })
    : false;
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config, route.agentId);
  const explicitMention = {
    hasAnyMention: message.hasAnyMention === true,
    isExplicitlyMentioned: message.wasExplicitlyMentioned === true,
    canResolveExplicit: message.canResolveExplicitMention === true,
  };
  const wasMentioned = isGroup
    ? core.channel.mentions.matchesMentionWithExplicit({
        text: rawBody,
        mentionRegexes,
        explicit: explicitMention,
      })
    : true;
  const canDetectMention = mentionRegexes.length > 0 || explicitMention.canResolveExplicit;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention: explicitMention.hasAnyMention,
      implicitMentionKinds: implicitMentionKindWhen("quoted_bot", message.implicitMention === true),
    },
    policy: {
      isGroup,
      requireMention,
      allowTextCommands: core.channel.commands.shouldHandleTextCommands({
        cfg: config,
        surface: "zalouser",
      }),
      hasControlCommand,
      commandAuthorized: commandAuthorized === true,
    },
  });
  if (isGroup && requireMention && !canDetectMention && !mentionDecision.effectiveWasMentioned) {
    runtime.error?.(
      `[${account.accountId}] zalouser mention required but detection unavailable ` +
        `(missing mention regexes and bot self id); dropping group ${chatId}`,
    );
    return;
  }
  if (isGroup && mentionDecision.shouldSkip) {
    channelHistory.record({
      historyKey: historyKey ?? "",
      limit: historyState.historyLimit,
      entry:
        historyKey && rawBody
          ? {
              sender: senderName || senderId,
              body: rawBody,
              timestamp: message.timestampMs,
              messageId: resolveZalouserMessageSid({
                msgId: message.msgId,
                cliMsgId: message.cliMsgId,
                fallback: `${message.timestampMs}`,
              }),
            }
          : null,
    });
    logVerbose(core, runtime, `zalouser: skip group ${chatId} (mention required, not mentioned)`);
    return;
  }

  const fromLabel = isGroup ? groupName || `group:${chatId}` : senderName || `user:${senderId}`;
  const buildEnvelope = createChannelInboundEnvelopeBuilder({ cfg: config, route });
  const body = buildEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: message.timestampMs,
    body: rawBody,
  });
  const combinedBody =
    isGroup && historyKey
      ? channelHistory.buildPendingContext({
          historyKey,
          limit: historyState.historyLimit,
          currentMessage: body,
          formatEntry: (entry) =>
            buildEnvelope({
              channel: "Zalo Personal",
              from: fromLabel,
              timestamp: entry.timestamp,
              previousTimestamp: null,
              body: `${entry.sender}: ${entry.body}${
                entry.messageId ? ` [id:${entry.messageId}]` : ""
              }`,
            }),
        })
      : body;
  const inboundHistory =
    isGroup && historyKey && historyState.historyLimit > 0
      ? channelHistory.buildInboundHistory({
          historyKey,
          limit: historyState.historyLimit,
        })
      : undefined;

  const normalizedTo = isGroup ? `zalouser:group:${chatId}` : `zalouser:${chatId}`;
  const messageSid = resolveZalouserMessageSid({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    fallback: `${message.timestampMs}`,
  });
  const messageSidFull = formatZalouserMessageSidFull({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
  });

  const ctxPayload = core.channel.inbound.buildContext({
    channel: "zalouser",
    accountId: route.accountId,
    messageId: messageSid,
    messageIdFull: messageSidFull,
    timestamp: message.timestampMs,
    from: isGroup ? `zalouser:group:${chatId}` : `zalouser:${senderId}`,
    sender: {
      id: senderId,
      name: senderName || undefined,
    },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: chatId,
      label: fromLabel,
    },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: normalizedTo,
      originatingTo: normalizedTo,
    },
    message: {
      body: combinedBody,
      bodyForAgent: rawBody,
      rawBody,
      commandBody,
      inboundHistory,
    },
    extra: {
      BodyForCommands: commandBody,
      GroupSubject: isGroup ? groupName || undefined : undefined,
      GroupChannel: isGroup ? groupName || undefined : undefined,
      GroupMembers: isGroup ? groupMembers : undefined,
      WasMentioned: isGroup ? mentionDecision.effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      ReplyToId: message.quotedGlobalMsgId || undefined,
      ReplyToBody: message.quotedBody || undefined,
      ReplyToIsQuote: message.quotedGlobalMsgId ? true : undefined,
    },
  });

  const replyPipeline = {
    typing: {
      start: async () => {
        await sendTypingZalouser(chatId, {
          profile: account.profile,
          isGroup,
        });
      },
      onStartError: (err: unknown) => {
        runtime.error?.(
          `[${account.accountId}] zalouser typing start failed for ${chatId}: ${String(err)}`,
        );
        logVerbose(core, runtime, `zalouser typing failed for ${chatId}: ${String(err)}`);
      },
    },
  };

  await core.channel.inbound.dispatch({
    channel: "zalouser",
    accountId: account.accountId,
    cfg: config,
    route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
    ctxPayload,
    delivery: {
      preparePayload: (payload) => {
        if (payload.text === undefined) {
          return payload;
        }
        return {
          ...payload,
          text: core.channel.text.convertMarkdownTables(
            payload.text,
            core.channel.text.resolveMarkdownTableMode({
              cfg: config,
              channel: "zalouser",
              accountId: account.accountId,
            }),
          ),
        };
      },
      durable: () => ({
        to: normalizedTo,
      }),
      deliver: async (payload) => {
        return await deliverZalouserReply({
          payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
          profile: account.profile,
          chatId,
          isGroup,
          runtime,
          core,
          config,
          accountId: account.accountId,
          tableMode: "off",
        });
      },
      onDelivered: (_payload, _info, result) => {
        if (result?.visibleReplySent !== false) {
          statusSink?.({ lastOutboundAt: Date.now() });
        }
      },
      onError: (err, info) => {
        runtime.error(`[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyPipeline,
    record: {
      onRecordError: (err) => {
        runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
      },
    },
    replyOptions: turnAdoptionLifecycle ? { turnAdoptionLifecycle } : undefined,
  });
  if (isGroup && historyKey) {
    channelHistory.clear({
      historyKey,
      limit: historyState.historyLimit,
    });
  }
}

async function deliverZalouserReply(params: {
  payload: OutboundReplyPayload;
  profile: string;
  chatId: string;
  isGroup: boolean;
  runtime: RuntimeEnv;
  core: ZalouserCoreRuntime;
  config: OpenClawConfig;
  accountId?: string;
  tableMode?: MarkdownTableMode;
}): Promise<{ visibleReplySent: boolean }> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId } = params;
  const tableMode = params.tableMode ?? "code";
  let visibleReplySent = false;
  const reply = resolveSendableOutboundReplyParts(payload, {
    text: core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode),
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "zalouser", accountId);
  const textChunkLimit = core.channel.text.resolveTextChunkLimit(config, "zalouser", accountId, {
    fallbackLimit: ZALOUSER_TEXT_LIMIT,
  });
  await deliverTextOrMediaReply({
    payload,
    text: reply.text,
    sendText: async (chunk) => {
      try {
        await sendMessageZalouser(chatId, chunk, {
          profile,
          isGroup,
          textMode: "markdown",
          textChunkMode: chunkMode,
          textChunkLimit,
        });
        visibleReplySent = true;
      } catch (err) {
        runtime.error(`Zalouser message send failed: ${String(err)}`);
      }
    },
    sendMedia: async ({ mediaUrl, caption }) => {
      logVerbose(core, runtime, `Sending media to ${chatId}`);
      await sendMessageZalouser(chatId, caption ?? "", {
        profile,
        mediaUrl,
        isGroup,
        textMode: "markdown",
        textChunkMode: chunkMode,
        textChunkLimit,
      });
      visibleReplySent = true;
    },
    onMediaError: (error) => {
      runtime.error(
        `Zalouser media send failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    },
  });
  return { visibleReplySent };
}

export async function monitorZalouserProvider(
  options: ZalouserMonitorOptions,
): Promise<ZalouserMonitorResult> {
  const { config } = options;
  let { account } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getZalouserRuntime();
  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      config.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();

  try {
    const profile = account.profile;
    const allowFromEntries = (account.config.allowFrom ?? [])
      .map((entry) => normalizeZalouserAllowEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    const groupAllowFromEntries = (account.config.groupAllowFrom ?? [])
      .map((entry) => normalizeZalouserAllowEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

    if (allowNameMatching && (allowFromEntries.length > 0 || groupAllowFromEntries.length > 0)) {
      const friends = await listZaloFriends(profile);
      const byName = buildNameIndex(friends, (friend) => friend.displayName);
      if (allowFromEntries.length > 0) {
        const { additions, mapping, unresolved } = resolveUserAllowlistEntries(
          allowFromEntries,
          byName,
        );
        const allowFrom = mergeAllowlist({ existing: account.config.allowFrom, additions });
        account = {
          ...account,
          config: {
            ...account.config,
            allowFrom,
          },
        };
        summarizeMapping("zalouser users", mapping, unresolved, runtime);
      }
      if (groupAllowFromEntries.length > 0) {
        const { additions, mapping, unresolved } = resolveUserAllowlistEntries(
          groupAllowFromEntries,
          byName,
        );
        const groupAllowFrom = mergeAllowlist({
          existing: account.config.groupAllowFrom,
          additions,
        });
        account = {
          ...account,
          config: {
            ...account.config,
            groupAllowFrom,
          },
        };
        summarizeMapping("zalouser group users", mapping, unresolved, runtime);
      }
    }

    const groupsConfig = account.config.groups ?? {};
    const groupKeys = Object.keys(groupsConfig).filter((key) => key !== "*");
    if (allowNameMatching && groupKeys.length > 0) {
      const groups = await listZaloGroups(profile);
      const byName = buildNameIndex(groups, (group) => group.name);
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const nextGroups = { ...groupsConfig };
      for (const entry of groupKeys) {
        const cleaned = normalizeZalouserAllowEntry(entry);
        if (/^\d+$/.test(cleaned)) {
          if (!nextGroups[cleaned]) {
            nextGroups[cleaned] = expectDefined(
              groupsConfig[entry],
              "enumerated Zalouser group config",
            );
          }
          mapping.push(`${entry}→${cleaned}`);
          continue;
        }
        const matches = byName.get(normalizeLowercaseStringOrEmpty(cleaned)) ?? [];
        const match = matches[0];
        const id = match?.groupId;
        if (id) {
          if (!nextGroups[id]) {
            nextGroups[id] = expectDefined(groupsConfig[entry], "enumerated Zalouser group config");
          }
          mapping.push(`${entry}→${id}`);
        } else {
          unresolved.push(entry);
        }
      }
      account = {
        ...account,
        config: {
          ...account.config,
          groups: nextGroups,
        },
      };
      summarizeMapping("zalouser groups", mapping, unresolved, runtime);
    }
  } catch (err) {
    runtime.log?.(`zalouser resolve failed; using config entries. ${String(err)}`);
  }

  const ownUserId = await resolveZaloOwnUserId(account.profile);
  const ingress = createZalouserIngressMonitor({
    accountId: account.accountId,
    ownUserId,
    runtime,
    ...(options.ingressQueue ? { queue: options.ingressQueue } : {}),
    dispatch: async (message, lifecycle) => {
      await processMessage(
        message,
        account,
        config,
        core,
        runtime,
        { historyLimit, groupHistories },
        statusSink,
        lifecycle,
      );
    },
  });

  let listenerStop: (() => void) | null = null;
  let stopped = false;
  let stopTask: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopTask ??= (async () => {
      stopped = true;
      listenerStop?.();
      listenerStop = null;
      await ingress.stop();
    })();
    return stopTask;
  };

  let settled = false;
  const { promise: waitForExit, resolve: resolveRun, reject: rejectRun } = createDeferred<void>();

  const settleSuccess = () => {
    if (settled) {
      return;
    }
    settled = true;
    void stop().then(resolveRun, rejectRun);
  };

  const settleFailure = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    const failure = error instanceof Error ? error : new Error(String(error));
    void stop().then(
      () => rejectRun(failure),
      (stopError: unknown) =>
        rejectRun(stopError instanceof Error ? stopError : new Error(String(stopError))),
    );
  };

  const onAbort = () => {
    settleSuccess();
  };
  abortSignal.addEventListener("abort", onAbort, { once: true });

  let listener: Awaited<ReturnType<typeof startZaloListener>>;
  try {
    listener = await startZaloListener({
      accountId: account.accountId,
      profile: account.profile,
      abortSignal,
      onMessage: async (msg) => {
        if (stopped) {
          return;
        }
        logVerbose(core, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        await ingress.receive(msg);
      },
      onError: (err) => {
        if (stopped || abortSignal.aborted) {
          return;
        }
        runtime.error(`[${account.accountId}] Zalo listener error: ${String(err)}`);
        settleFailure(err);
      },
    });
  } catch (error) {
    abortSignal.removeEventListener("abort", onAbort);
    await ingress.stop();
    throw error;
  }

  listenerStop = listener.stop;
  if (stopped) {
    listenerStop();
    listenerStop = null;
  }

  if (abortSignal.aborted) {
    settleSuccess();
  }

  try {
    await waitForExit;
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }

  return { stop };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
