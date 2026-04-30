import { mergeAllowlist, summarizeMapping } from "openclaw/plugin-sdk/allow-from";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  DM_GROUP_ACCESS_REASON,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/channel-policy";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveSenderCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/core";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "openclaw/plugin-sdk/group-access";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
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
} from "openclaw/plugin-sdk/text-runtime";
import {
  buildZalouserGroupCandidates,
  findZalouserGroupEntry,
  isZalouserGroupEntryAllowed,
} from "./group-policy.js";
import { formatZalouserMessageSidFull, resolveZalouserMessageSid } from "./message-sid.js";
import { getZalouserRuntime } from "./runtime.js";
import {
  sendDeliveredZalouser,
  sendMessageZalouser,
  sendSeenZalouser,
  sendTypingZalouser,
} from "./send.js";
import type { ResolvedZalouserAccount, ZaloInboundMessage } from "./types.js";
import {
  listZaloFriends,
  listZaloGroups,
  resolveZaloGroupContext,
  startZaloListener,
} from "./zalo-js.js";

export type ZalouserMonitorOptions = {
  account: ResolvedZalouserAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type ZalouserMonitorResult = {
  stop: () => void;
};

const ZALOUSER_TEXT_LIMIT = 2000;

function normalizeZalouserEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

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

function resolveInboundQueueKey(message: ZaloInboundMessage): string {
  const threadId = message.threadId?.trim() || "unknown";
  if (message.isGroup) {
    return `group:${threadId}`;
  }
  const senderId = message.senderId?.trim();
  return `direct:${senderId || threadId}`;
}

function resolveZalouserDmSessionScope(config: OpenClawConfig) {
  const configured = config.session?.dmScope;
  return configured === "main" || !configured ? "per-channel-peer" : configured;
}

function resolveZalouserInboundSessionKey(params: {
  core: ZalouserCoreRuntime;
  config: OpenClawConfig;
  route: { agentId: string; accountId: string; sessionKey: string };
  storePath: string;
  isGroup: boolean;
  senderId: string;
}): string {
  if (params.isGroup) {
    return params.route.sessionKey;
  }

  const directSessionKey = normalizeLowercaseStringOrEmpty(
    params.core.channel.routing.buildAgentSessionKey({
      agentId: params.route.agentId,
      channel: "zalouser",
      accountId: params.route.accountId,
      peer: { kind: "direct", id: params.senderId },
      dmScope: resolveZalouserDmSessionScope(params.config),
      identityLinks: params.config.session?.identityLinks,
    }),
  );
  const legacySessionKey = normalizeLowercaseStringOrEmpty(
    params.core.channel.routing.buildAgentSessionKey({
      agentId: params.route.agentId,
      channel: "zalouser",
      accountId: params.route.accountId,
      peer: { kind: "group", id: params.senderId },
    }),
  );
  const hasDirectSession =
    params.core.channel.session.readSessionUpdatedAt({
      storePath: params.storePath,
      sessionKey: directSessionKey,
    }) !== undefined;
  const hasLegacySession =
    params.core.channel.session.readSessionUpdatedAt({
      storePath: params.storePath,
      sessionKey: legacySessionKey,
    }) !== undefined;

  // Keep existing DM history on upgrade, but use canonical direct keys for new sessions.
  return hasLegacySession && !hasDirectSession ? legacySessionKey : directSessionKey;
}

function logVerbose(core: ZalouserCoreRuntime, runtime: RuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log(`[zalouser] ${message}`);
  }
}

function isSenderAllowed(senderId: string | undefined, allowFrom: string[]): boolean {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeOptionalLowercaseString(senderId);
  if (!normalizedSenderId) {
    return false;
  }
  return allowFrom.some((entry) => {
    const normalized = normalizeLowercaseStringOrEmpty(entry).replace(/^(zalouser|zlu):/i, "");
    return normalized === normalizedSenderId;
  });
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
      ? await resolveZaloGroupContext(account.profile, chatId).catch((err) => {
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
    const routeAccess = evaluateGroupRouteAccessForPolicy({
      groupPolicy,
      routeAllowlistConfigured,
      routeMatched: Boolean(groupEntry),
      routeEnabled: isZalouserGroupEntryAllowed(groupEntry),
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
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) => String(v));
  const configGroupAllowFrom = (account.config.groupAllowFrom ?? []).map((v) => String(v));
  const senderGroupPolicy =
    routeAllowlistConfigured && configGroupAllowFrom.length === 0
      ? groupPolicy
      : resolveSenderScopedGroupPolicy({
          groupPolicy,
          groupAllowFrom: configGroupAllowFrom,
        });
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && dmPolicy !== "open"
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, allowFrom),
  });
  if (isGroup && accessDecision.decision !== "allow") {
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST) {
      logVerbose(core, runtime, "Blocked zalouser group message (no group allowlist)");
    } else if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED) {
      logVerbose(
        core,
        runtime,
        `Blocked zalouser sender ${senderId} (not in groupAllowFrom/allowFrom)`,
      );
    }
    return;
  }

  if (!isGroup && accessDecision.decision !== "allow") {
    if (accessDecision.decision === "pairing") {
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
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
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

  const { commandAuthorized } = await resolveSenderCommandAuthorization({
    cfg: config,
    rawBody: commandBody,
    isGroup,
    dmPolicy,
    configuredAllowFrom: configAllowFrom,
    configuredGroupAllowFrom: configGroupAllowFrom,
    senderId,
    isSenderAllowed,
    readAllowFromStore: async () => storeAllowFrom,
    shouldComputeCommandAuthorized: (body, cfg) =>
      core.channel.commands.shouldComputeCommandAuthorized(body, cfg),
    resolveCommandAuthorizedFromAuthorizers: (params) =>
      core.channel.commands.resolveCommandAuthorizedFromAuthorizers(params),
  });
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
    peer: {
      // Keep DM peer kind as "direct" so session keys follow dmScope and UI labels stay DM-shaped.
      kind: peer.kind,
      id: peer.id,
    },
  });
  const historyKey = isGroup ? route.sessionKey : undefined;

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
    recordPendingHistoryEntryIfEnabled({
      historyMap: historyState.groupHistories,
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
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const inboundSessionKey = resolveZalouserInboundSessionKey({
    core,
    config,
    route,
    storePath,
    isGroup,
    senderId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: inboundSessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Zalo Personal",
    from: fromLabel,
    timestamp: message.timestampMs,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });
  const combinedBody =
    isGroup && historyKey
      ? buildPendingHistoryContextFromMap({
          historyMap: historyState.groupHistories,
          historyKey,
          limit: historyState.historyLimit,
          currentMessage: body,
          formatEntry: (entry) =>
            core.channel.reply.formatAgentEnvelope({
              channel: "Zalo Personal",
              from: fromLabel,
              timestamp: entry.timestamp,
              envelope: envelopeOptions,
              body: `${entry.sender}: ${entry.body}${
                entry.messageId ? ` [id:${entry.messageId}]` : ""
              }`,
            }),
        })
      : body;
  const inboundHistory =
    isGroup && historyKey && historyState.historyLimit > 0
      ? (historyState.groupHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
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

  const ctxPayload = core.channel.turn.buildContext({
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
      routePeer: {
        kind: isGroup ? "group" : "direct",
        id: chatId,
      },
    },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: inboundSessionKey,
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
      envelopeFrom: fromLabel,
    },
    extra: {
      BodyForCommands: commandBody,
      GroupSubject: isGroup ? groupName || undefined : undefined,
      GroupChannel: isGroup ? groupName || undefined : undefined,
      GroupMembers: isGroup ? groupMembers : undefined,
      WasMentioned: isGroup ? mentionDecision.effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
    },
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg: config,
    agentId: route.agentId,
    channel: "zalouser",
    accountId: account.accountId,
    typing: {
      start: async () => {
        await sendTypingZalouser(chatId, {
          profile: account.profile,
          isGroup,
        });
      },
      onStartError: (err) => {
        runtime.error?.(
          `[${account.accountId}] zalouser typing start failed for ${chatId}: ${String(err)}`,
        );
        logVerbose(core, runtime, `zalouser typing failed for ${chatId}: ${String(err)}`);
      },
    },
  });

  await core.channel.turn.run({
    channel: "zalouser",
    accountId: account.accountId,
    raw: message,
    adapter: {
      ingest: () => ({
        id: messageSid ?? `${message.timestampMs}`,
        timestamp: message.timestampMs,
        rawText: rawBody,
        textForAgent: rawBody,
        textForCommands: commandBody,
        raw: message,
      }),
      resolveTurn: () => ({
        cfg: config,
        channel: "zalouser",
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
            await deliverZalouserReply({
              payload: payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string },
              profile: account.profile,
              chatId,
              isGroup,
              runtime,
              core,
              config,
              accountId: account.accountId,
              statusSink,
              tableMode: core.channel.text.resolveMarkdownTableMode({
                cfg: config,
                channel: "zalouser",
                accountId: account.accountId,
              }),
            });
          },
          onError: (err, info) => {
            runtime.error(
              `[${account.accountId}] Zalouser ${info.kind} reply failed: ${String(err)}`,
            );
          },
        },
        dispatcherOptions: replyPipeline,
        replyOptions: {
          onModelSelected,
        },
        record: {
          onRecordError: (err) => {
            runtime.error?.(`zalouser: failed updating session meta: ${String(err)}`);
          },
        },
      }),
    },
  });
  if (isGroup && historyKey) {
    clearHistoryEntriesIfEnabled({
      historyMap: historyState.groupHistories,
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
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  tableMode?: MarkdownTableMode;
}): Promise<void> {
  const { payload, profile, chatId, isGroup, runtime, core, config, accountId, statusSink } =
    params;
  const tableMode = params.tableMode ?? "code";
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
        statusSink?.({ lastOutboundAt: Date.now() });
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
      statusSink?.({ lastOutboundAt: Date.now() });
    },
    onMediaError: (error) => {
      runtime.error(
        `Zalouser media send failed: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
    },
  });
}

export async function monitorZalouserProvider(
  options: ZalouserMonitorOptions,
): Promise<ZalouserMonitorResult> {
  let { account, config } = options;
  const { abortSignal, statusSink, runtime } = options;

  const core = getZalouserRuntime();
  const inboundQueue = new KeyedAsyncQueue();
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
      .map((entry) => normalizeZalouserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");
    const groupAllowFromEntries = (account.config.groupAllowFrom ?? [])
      .map((entry) => normalizeZalouserEntry(String(entry)))
      .filter((entry) => entry && entry !== "*");

    if (allowFromEntries.length > 0 || groupAllowFromEntries.length > 0) {
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
    if (groupKeys.length > 0) {
      const groups = await listZaloGroups(profile);
      const byName = buildNameIndex(groups, (group) => group.name);
      const mapping: string[] = [];
      const unresolved: string[] = [];
      const nextGroups = { ...groupsConfig };
      for (const entry of groupKeys) {
        const cleaned = normalizeZalouserEntry(entry);
        if (/^\d+$/.test(cleaned)) {
          if (!nextGroups[cleaned]) {
            nextGroups[cleaned] = groupsConfig[entry];
          }
          mapping.push(`${entry}→${cleaned}`);
          continue;
        }
        const matches = byName.get(normalizeLowercaseStringOrEmpty(cleaned)) ?? [];
        const match = matches[0];
        const id = match?.groupId;
        if (id) {
          if (!nextGroups[id]) {
            nextGroups[id] = groupsConfig[entry];
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

  let listenerStop: (() => void) | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    listenerStop?.();
    listenerStop = null;
  };

  let settled = false;
  const { promise: waitForExit, resolve: resolveRun, reject: rejectRun } = createDeferred<void>();

  const settleSuccess = () => {
    if (settled) {
      return;
    }
    settled = true;
    stop();
    resolveRun();
  };

  const settleFailure = (error: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    stop();
    rejectRun(error instanceof Error ? error : new Error(String(error)));
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
      onMessage: (msg) => {
        if (stopped) {
          return;
        }
        logVerbose(core, runtime, `[${account.accountId}] inbound message`);
        statusSink?.({ lastInboundAt: Date.now() });
        const queueKey = resolveInboundQueueKey(msg);
        void inboundQueue
          .enqueue(queueKey, async () => {
            if (stopped || abortSignal.aborted) {
              return;
            }
            await processMessage(
              msg,
              account,
              config,
              core,
              runtime,
              { historyLimit, groupHistories },
              statusSink,
            );
          })
          .catch((err) => {
            runtime.error(`[${account.accountId}] Failed to process message: ${String(err)}`);
          });
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

export const __testing = {
  processMessage: async (params: {
    message: ZaloInboundMessage;
    account: ResolvedZalouserAccount;
    config: OpenClawConfig;
    runtime: RuntimeEnv;
    historyState?: {
      historyLimit?: number;
      groupHistories?: Map<string, HistoryEntry[]>;
    };
    statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  }) => {
    const historyLimit = Math.max(
      0,
      params.historyState?.historyLimit ??
        params.account.config.historyLimit ??
        params.config.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
    const groupHistories = params.historyState?.groupHistories ?? new Map<string, HistoryEntry[]>();
    await processMessage(
      params.message,
      params.account,
      params.config,
      getZalouserRuntime(),
      params.runtime,
      { historyLimit, groupHistories },
      params.statusSink,
    );
  },
};
