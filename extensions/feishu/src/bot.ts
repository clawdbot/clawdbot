// Feishu plugin module implements bot behavior.
import {
  buildChannelInboundEventContext,
  formatInboundMediaUnavailableText,
  toInboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  resolveRuntimeConversationBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  createChannelHistoryWindow,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { buildFeishuAgentBody } from "./bot-agent-body.js";
import { buildBroadcastSessionKey, resolveBroadcastAgents } from "./bot-broadcast.js";
import {
  checkBotMentioned,
  normalizeFeishuCommandProbeBody,
  normalizeMentions,
  parseMergeForwardContent,
  parseMessageContent,
  resolveFeishuGroupSession,
  resolveFeishuMediaList,
  resolveFeishuMediaFailurePresentation,
} from "./bot-content.js";
import { resolveGroupName } from "./bot-group-name.js";
import {
  evaluateSupplementalContextVisibility,
  normalizeAgentId,
  resolveChannelContextVisibilityMode,
} from "./bot-runtime-api.js";
import type { ClawdbotConfig, RuntimeEnv } from "./bot-runtime-api.js";
import { resolveFeishuSenderName, type FeishuPermissionError } from "./bot-sender-name.js";
import { createFeishuClient } from "./client.js";
import { resolveConfiguredFeishuGroupSessionScope } from "./conversation-id.js";
import { finalizeFeishuMessageProcessing, recordProcessedFeishuMessage } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import {
  hasExplicitFeishuGroupConfig,
  normalizeFeishuAllowEntry,
  resolveFeishuDmIngressAccess,
  resolveFeishuGroupConfig,
  resolveFeishuGroupConversationIngressAccess,
  resolveFeishuGroupSenderActivationIngressAccess,
  resolveFeishuReplyPolicy,
} from "./policy.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, listFeishuThreadMessages, sendMessageFeishu } from "./send.js";
export type { FeishuBotAddedEvent, FeishuMessageEvent } from "./event-types.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  isFeishuGroupChatType,
  type FeishuMessageContext,
  type FeishuMediaInfo,
  type FeishuMessageInfo,
} from "./types.js";

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function shouldSendNoVisibleReplyFallback(dispatchResult: {
  counts: { final?: number };
  failedCounts?: { final?: number };
  noVisibleReplyFallbackEligible?: boolean;
  queuedFinal?: boolean;
  sendPolicyDenied?: boolean;
  sourceReplyDeliveryMode?: string;
}): boolean {
  const finalCount = dispatchResult.counts.final ?? 0;
  const failedFinalCount = dispatchResult.failedCounts?.final ?? 0;
  const emptyEligibleDispatch =
    dispatchResult.noVisibleReplyFallbackEligible === true &&
    dispatchResult.queuedFinal !== true &&
    finalCount === 0;
  const queuedFinalFailed = dispatchResult.queuedFinal === true && failedFinalCount > 0;
  return (
    dispatchResult.sendPolicyDenied !== true &&
    dispatchResult.sourceReplyDeliveryMode !== "message_tool_only" &&
    (emptyEligibleDispatch || queuedFinalFailed)
  );
}

function isFeishuTopicSessionScope(
  scope: ReturnType<typeof resolveConfiguredFeishuGroupSessionScope>,
): boolean {
  return scope === "group_topic" || scope === "group_topic_sender";
}

async function resolveFeishuAudioPreflightTranscript(params: {
  cfg: ClawdbotConfig;
  mediaList: FeishuMediaInfo[];
  content: string;
  chatType: "direct" | "group";
  log: (msg: string) => void;
}): Promise<string | undefined> {
  if (params.content.trim() !== "<media:audio>") {
    return undefined;
  }
  const audioMedia = params.mediaList.filter((media) => media.contentType?.startsWith("audio/"));
  if (audioMedia.length === 0) {
    return undefined;
  }

  try {
    const { transcribeFirstAudio } = await import("./audio-preflight.runtime.js");
    return await transcribeFirstAudio({
      ctx: {
        MediaPaths: audioMedia.map((media) => media.path),
        MediaTypes: audioMedia.map((media) => media.contentType).filter(Boolean) as string[],
        ChatType: params.chatType,
      },
      cfg: params.cfg,
    });
  } catch (err) {
    params.log(`feishu: audio preflight transcription failed: ${String(err)}`);
    return undefined;
  }
}

/**
 * Build media payload for inbound context.
 * Similar to Discord's buildDiscordMediaPayload().
 */
export function parseFeishuMessageEvent(
  event: FeishuMessageEvent,
  botOpenId?: string,
  _botName?: string,
): FeishuMessageContext {
  const rawContent = parseMessageContent(event.message.content, event.message.message_type);
  const mentionedBot = checkBotMentioned(event, botOpenId);
  const hasAnyMention = (event.message.mentions?.length ?? 0) > 0;
  // Strip the bot's own mention so slash commands like @Bot /help retain
  // the leading /. This applies in both p2p *and* group contexts — the
  // mentionedBot flag already captures whether the bot was addressed, so
  // keeping the mention tag in content only breaks command detection (#35994).
  // Non-bot mentions (e.g. mention-forward targets) are still normalized to <at> tags.
  const content = normalizeMentions(rawContent, event.message.mentions, botOpenId);
  const senderOpenId = event.sender.sender_id.open_id?.trim();
  const senderUserId = event.sender.sender_id.user_id?.trim();
  const senderFallbackId = senderOpenId || senderUserId || "";

  const ctx: FeishuMessageContext = {
    chatId: event.message.chat_id,
    messageId: event.message.message_id,
    replyTargetMessageId: event.message.reply_target_message_id?.trim() || undefined,
    typingTargetMessageId: event.message.typing_target_message_id?.trim() || undefined,
    suppressReplyTarget: event.message.suppress_reply_target === true,
    senderId: senderUserId || senderOpenId || "",
    // Keep the historical field name, but fall back to user_id when open_id is unavailable
    // (common in some mobile app deliveries).
    senderOpenId: senderFallbackId,
    chatType: event.message.chat_type,
    mentionedBot,
    hasAnyMention,
    rootId: event.message.root_id || undefined,
    parentId: event.message.parent_id || undefined,
    threadId: event.message.thread_id || undefined,
    content,
    contentType: event.message.message_type,
  };

  // Detect mention forward request: message mentions bot + at least one other user
  const mentionForwardBotOpenId = botOpenId?.trim();
  if (mentionForwardBotOpenId && isMentionForwardRequest(event, mentionForwardBotOpenId)) {
    const mentionTargets = extractMentionTargets(event, mentionForwardBotOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

async function shouldIncludeFetchedGroupContextMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  chatId: string;
  isGroup: boolean;
  allowFrom: Array<string | number>;
  mode: "all" | "allowlist" | "allowlist_quote";
  kind: "quote" | "thread" | "history";
  senderId?: string;
  senderType?: string;
}): Promise<boolean> {
  let senderAllowed =
    !params.isGroup || params.allowFrom.length === 0 || params.senderType === "app";
  const senderId = params.senderId?.trim();
  if (!senderAllowed && senderId) {
    const access = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg: params.cfg,
      accountId: params.accountId,
      chatId: params.chatId,
      allowFrom: params.allowFrom,
      senderOpenId: senderId,
      senderUserId: senderId,
      requireMention: false,
      mentionedBot: true,
    });
    senderAllowed = access.senderAccess.decision === "allow";
  }
  return evaluateSupplementalContextVisibility({
    mode: params.mode,
    kind: params.kind,
    senderAllowed,
  }).include;
}

async function filterFetchedGroupContextMessages<
  T extends Pick<FeishuMessageInfo, "senderId" | "senderType">,
>(
  messages: readonly T[],
  params: {
    cfg: ClawdbotConfig;
    accountId: string;
    chatId: string;
    isGroup: boolean;
    allowFrom: Array<string | number>;
    mode: "all" | "allowlist" | "allowlist_quote";
    kind: "quote" | "thread" | "history";
  },
): Promise<T[]> {
  const results: Array<T | undefined> = await Promise.all(
    messages.map(async (message) =>
      (await shouldIncludeFetchedGroupContextMessage({
        cfg: params.cfg,
        accountId: params.accountId,
        chatId: params.chatId,
        isGroup: params.isGroup,
        allowFrom: params.allowFrom,
        mode: params.mode,
        kind: params.kind,
        senderId: message.senderId,
        senderType: message.senderType,
      }))
        ? message
        : undefined,
    ),
  );
  return results.filter((message): message is T => message !== undefined);
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  channelRuntime?: ReturnType<typeof getFeishuRuntime>["channel"];
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  processingClaimHeld?: boolean;
  messageDedupeKey?: string;
}): Promise<void> {
  const {
    cfg,
    event,
    botOpenId,
    botName,
    runtime,
    channelRuntime,
    chatHistories,
    accountId,
    processingClaimHeld = false,
    messageDedupeKey: messageDedupeKeyOverride,
  } = params;

  // Resolve account with merged config
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const messageId = event.message.message_id;
  const messageDedupeKey = messageDedupeKeyOverride ?? resolveFeishuMessageDedupeKey(event);
  if (
    !(await finalizeFeishuMessageProcessing({
      messageId: messageDedupeKey,
      namespace: account.accountId,
      log,
      claimHeld: processingClaimHeld,
    }))
  ) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
  const isGroup = isFeishuGroupChatType(ctx.chatType);
  const isDirect = !isGroup;
  const senderUserId = normalizeOptionalString(event.sender.sender_id.user_id);

  // Handle merge_forward messages: fetch full message via API then expand sub-messages
  if (event.message.message_type === "merge_forward") {
    log(
      `feishu[${account.accountId}]: processing merge_forward message, fetching full content via API`,
    );
    try {
      // Websocket event doesn't include sub-messages, need to fetch via API
      // The API returns all sub-messages in the items array
      const client = createFeishuClient(account);
      const response = (await client.im.message.get({
        path: { message_id: event.message.message_id },
      })) as { code?: number; data?: { items?: unknown[] } };

      if (response.code === 0 && response.data?.items && response.data.items.length > 0) {
        log(
          `feishu[${account.accountId}]: merge_forward API returned ${response.data.items.length} items`,
        );
        const expandedContent = parseMergeForwardContent({
          content: JSON.stringify(response.data.items),
          log,
        });
        ctx = { ...ctx, content: expandedContent };
      } else {
        log(`feishu[${account.accountId}]: merge_forward API returned no items`);
        ctx = { ...ctx, content: "[Merged and Forwarded Message - could not fetch]" };
      }
    } catch (err) {
      log(`feishu[${account.accountId}]: merge_forward fetch failed: ${String(err)}`);
      ctx = { ...ctx, content: "[Merged and Forwarded Message - fetch error]" };
    }
  }

  // Resolve sender display name (best-effort) so the agent can attribute messages correctly.
  // Optimization: skip if disabled to save API quota (Feishu free tier limit).
  let permissionErrorForAgent: FeishuPermissionError | undefined;
  if (feishuCfg?.resolveSenderNames ?? true) {
    const senderResult = await resolveFeishuSenderName({
      account,
      senderId: ctx.senderOpenId,
      log,
    });
    if (senderResult.name) {
      ctx = { ...ctx, senderName: senderResult.name };
    }

    // Track permission error to inform agent later (with cooldown to avoid repetition)
    if (senderResult.permissionError) {
      const appKey = account.appId ?? "default";
      const now = Date.now();
      const lastNotified = permissionErrorNotifiedAt.get(appKey) ?? 0;

      if (now - lastNotified > PERMISSION_ERROR_COOLDOWN_MS) {
        permissionErrorNotifiedAt.set(appKey, now);
        permissionErrorForAgent = senderResult.permissionError;
      }
    }
  }

  log(
    `feishu[${account.accountId}]: received message from ${ctx.senderOpenId} in ${ctx.chatId} (${ctx.chatType})`,
  );

  // Log mention targets if detected
  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const names = ctx.mentionTargets.map((t) => t.name).join(", ");
    log(`feishu[${account.accountId}]: detected @ forward request, targets: [${names}]`);
  }

  const historyLimit = Math.max(
    0,
    feishuCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupConfig = isGroup
    ? resolveFeishuGroupConfig({ cfg: feishuCfg, groupId: ctx.chatId })
    : undefined;
  const groupSessionScope = isGroup
    ? resolveConfiguredFeishuGroupSessionScope({ groupConfig, feishuCfg })
    : null;
  let effectiveThreadId = ctx.threadId;
  if (
    isGroup &&
    ctx.chatType === "topic_group" &&
    !effectiveThreadId &&
    isFeishuTopicSessionScope(groupSessionScope ?? "group")
  ) {
    try {
      const messageInfo = await getMessageFeishu({
        cfg,
        accountId: account.accountId,
        messageId: ctx.messageId,
      });
      const hydratedThreadId = messageInfo?.threadId?.trim();
      if (hydratedThreadId) {
        ctx = { ...ctx, threadId: hydratedThreadId };
        effectiveThreadId = hydratedThreadId;
        log(
          `feishu[${account.accountId}]: hydrated topic thread_id=${hydratedThreadId} for message=${ctx.messageId}`,
        );
      }
    } catch (err) {
      log(
        `feishu[${account.accountId}]: failed to hydrate topic thread_id for message=${ctx.messageId}: ${String(err)}`,
      );
    }
  }
  const effectiveGroupSenderAllowFrom = isGroup
    ? (groupConfig?.allowFrom?.length ?? 0) > 0
      ? (groupConfig?.allowFrom ?? [])
      : (feishuCfg?.groupSenderAllowFrom ?? [])
    : [];
  const groupSession = isGroup
    ? resolveFeishuGroupSession({
        chatId: ctx.chatId,
        senderOpenId: ctx.senderOpenId,
        messageId: ctx.messageId,
        rootId: ctx.rootId,
        threadId: effectiveThreadId,
        chatType: ctx.chatType,
        groupConfig,
        feishuCfg,
      })
    : null;
  const groupHistoryKey = isGroup ? (groupSession?.peerId ?? ctx.chatId) : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents
    ? uniqueStrings(rawBroadcastAgents.map((id) => normalizeAgentId(id)))
    : null;

  // Parse message create_time early so every downstream consumer (pending
  // history, inbound payload, etc.) uses the original authoring timestamp
  // instead of the delivery/processing time.  Feishu uses a millisecond
  // epoch string; fall back to Date.now() when absent or malformed.
  const messageCreateTimeMs =
    parseStrictNonNegativeInteger(event.message.create_time) ?? Date.now();

  let requireMention = false; // DMs never require mention; groups may override below
  if (isGroup) {
    if (groupConfig?.enabled === false) {
      log(`feishu[${account.accountId}]: group ${ctx.chatId} is disabled`);
      return;
    }
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.feishu !== undefined,
      groupPolicy: feishuCfg?.groupPolicy,
      defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
      providerMissingFallbackApplied,
      providerKey: "feishu",
      accountId: account.accountId,
      log,
    });
    const groupAllowFrom = feishuCfg?.groupAllowFrom ?? [];
    // DEBUG: log(`feishu[${account.accountId}]: groupPolicy=${groupPolicy}`);

    // A group explicitly configured under `channels.feishu.groups.<chat_id>` is
    // treated as admitted in allowlist mode even when `groupAllowFrom` is empty.
    // Wildcard defaults still configure matching groups, but they are not an
    // admission signal by themselves.
    const groupExplicitlyConfigured = hasExplicitFeishuGroupConfig({
      cfg: feishuCfg,
      groupId: ctx.chatId,
    });

    const groupIngress = await resolveFeishuGroupConversationIngressAccess({
      cfg,
      accountId: account.accountId,
      chatId: ctx.chatId,
      groupPolicy,
      groupAllowFrom,
      groupExplicitlyConfigured,
    });

    if (groupIngress.ingress.admission !== "dispatch") {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`,
      );
      return;
    }

    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      cfg,
      accountId: account.accountId,
      groupId: ctx.chatId,
      groupPolicy,
    }));

    const groupSenderActivationIngress = await resolveFeishuGroupSenderActivationIngressAccess({
      cfg,
      accountId: account.accountId,
      chatId: ctx.chatId,
      allowFrom: effectiveGroupSenderAllowFrom,
      senderOpenId: ctx.senderOpenId,
      senderUserId,
      requireMention,
      mentionedBot: ctx.mentionedBot,
    });
    if (groupSenderActivationIngress.senderAccess.decision !== "allow") {
      log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
      return;
    }
    if (groupSenderActivationIngress.ingress.admission !== "dispatch") {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      // Record to pending history for non-broadcast groups only. For broadcast groups,
      // the mentioned handler's broadcast dispatch writes the turn directly into all
      // agent sessions — buffering here would cause duplicate replay when this account
      // later becomes active via the channel history window.
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        createChannelHistoryWindow({ historyMap: chatHistories }).record({
          historyKey: groupHistoryKey,
          limit: historyLimit,
          entry: {
            sender: ctx.senderOpenId,
            body: `${ctx.senderName ?? ctx.senderOpenId}: ${ctx.content}`,
            timestamp: messageCreateTimeMs,
            messageId: ctx.messageId,
          },
        });
      }
      return;
    }
  }

  try {
    const core = {
      channel: channelRuntime?.inbound ? channelRuntime : getFeishuRuntime().channel,
    } as ReturnType<typeof getFeishuRuntime>;
    const pairing = createChannelPairingController({
      core,
      channel: "feishu",
      accountId: account.accountId,
    });
    const commandProbeBody = isGroup ? normalizeFeishuCommandProbeBody(ctx.content) : ctx.content;
    const shouldComputeCommandAuthorized = core.channel.commands.shouldComputeCommandAuthorized(
      commandProbeBody,
      cfg,
    );
    const resolveDirectAuthorization = async (
      candidateCfg: ClawdbotConfig,
      mayPair: boolean,
      shouldComputeCommand = core.channel.commands.shouldComputeCommandAuthorized(
        commandProbeBody,
        candidateCfg,
      ),
    ) => {
      const candidateAccount = resolveFeishuRuntimeAccount({
        cfg: candidateCfg,
        accountId: account.accountId,
      });
      const candidateDmPolicy = candidateAccount.config.dmPolicy ?? "pairing";
      const candidateConfigAllowFrom = candidateAccount.config.allowFrom ?? [];
      const ingress = await resolveFeishuDmIngressAccess({
        cfg: candidateCfg,
        accountId: candidateAccount.accountId,
        dmPolicy: candidateDmPolicy,
        allowFrom: candidateConfigAllowFrom,
        readAllowFromStore: pairing.readAllowFromStore,
        senderOpenId: ctx.senderOpenId,
        senderUserId,
        conversationId: ctx.senderOpenId,
        mayPair,
        ...(shouldComputeCommand ? { command: { hasControlCommand: true } } : {}),
      });
      return {
        cfg: candidateCfg,
        dmPolicy: candidateDmPolicy,
        configAllowFrom: candidateConfigAllowFrom,
        ingress,
        shouldComputeCommandAuthorized: shouldComputeCommand,
      };
    };
    const rejectDirectAuthorization = async (
      authorization: Awaited<ReturnType<typeof resolveDirectAuthorization>>,
    ) => {
      if (authorization.ingress.ingress.admission === "pairing-required") {
        await pairing.issueChallenge({
          senderId: ctx.senderOpenId,
          senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
          meta: { name: ctx.senderName },
          onCreated: () => {
            log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageFeishu({
              cfg: authorization.cfg,
              to: `chat:${ctx.chatId}`,
              text,
              accountId: account.accountId,
            });
          },
          onReplyError: (err) => {
            log(
              `feishu[${account.accountId}]: pairing reply failed for ${ctx.senderOpenId}: ${String(err)}`,
            );
          },
        });
      } else {
        log(
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} ` +
            `(dmPolicy=${authorization.dmPolicy})`,
        );
      }
    };
    const directAuthorization = isDirect
      ? await resolveDirectAuthorization(cfg, true, shouldComputeCommandAuthorized)
      : null;
    const dmIngress = directAuthorization?.ingress ?? null;
    if (isDirect && dmIngress?.ingress.admission !== "dispatch") {
      if (directAuthorization) {
        await rejectDirectAuthorization(directAuthorization);
      }
      return;
    }
    let effectiveDmPolicy = directAuthorization?.dmPolicy ?? dmPolicy;
    let effectiveConfigAllowFrom = directAuthorization?.configAllowFrom ?? configAllowFrom;
    let effectiveDmIngress = dmIngress;
    let effectiveShouldComputeCommandAuthorized =
      directAuthorization?.shouldComputeCommandAuthorized ?? shouldComputeCommandAuthorized;
    let effectiveCfg = cfg;
    if (isDirect) {
      const currentCfg = getFeishuRuntime().config.current() as ClawdbotConfig;
      if (currentCfg !== effectiveCfg) {
        const currentAuthorization = await resolveDirectAuthorization(currentCfg, true);
        if (currentAuthorization.ingress.ingress.admission !== "dispatch") {
          await rejectDirectAuthorization(currentAuthorization);
          return;
        }
        effectiveCfg = currentCfg;
        effectiveDmPolicy = currentAuthorization.dmPolicy;
        effectiveConfigAllowFrom = currentAuthorization.configAllowFrom;
        effectiveDmIngress = currentAuthorization.ingress;
        effectiveShouldComputeCommandAuthorized =
          currentAuthorization.shouldComputeCommandAuthorized;
      }
    }

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    const peerId = isGroup ? (groupSession?.peerId ?? ctx.chatId) : ctx.senderOpenId;
    const parentPeer = isGroup ? (groupSession?.parentPeer ?? null) : null;
    const directThreadReply = !isGroup && Boolean(ctx.threadId?.trim());
    const defaultReplyTargetMessageId =
      ctx.replyTargetMessageId ?? (ctx.suppressReplyTarget ? undefined : ctx.messageId);
    const directThreadRootId = directThreadReply ? ctx.rootId?.trim() || undefined : undefined;
    const directThreadReplyTargetMessageId = directThreadReply
      ? (directThreadRootId ?? defaultReplyTargetMessageId)
      : undefined;
    const replyInThread = isGroup ? (groupSession?.replyInThread ?? false) : directThreadReply;
    const feishuAcpConversationSupported =
      !isGroup ||
      groupSession?.groupSessionScope === "group_topic" ||
      groupSession?.groupSessionScope === "group_topic_sender";

    if (isGroup && groupSession) {
      log(
        `feishu[${account.accountId}]: group session scope=${groupSession.groupSessionScope}, peer=${peerId}`,
      );
    }

    let route = core.channel.routing.resolveAgentRoute({
      cfg: effectiveCfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });

    // Refresh a binding written after this request snapshot, or create the DM's
    // dynamic agent when the current account policy enables it.
    if (!isGroup && route.matchedBy === "default") {
      const runtimeLocal = getFeishuRuntime();
      const result = await maybeCreateDynamicAgent({
        cfg: effectiveCfg,
        runtime: runtimeLocal,
        accountId: account.accountId,
        senderOpenId: ctx.senderOpenId,
        canCreateForConfig: async (candidateCfg) => {
          const authorization = await resolveDirectAuthorization(candidateCfg, false);
          return authorization.ingress.ingress.admission === "dispatch";
        },
        log: (msg) => log(msg),
      });
      if (result.created || result.updatedCfg !== effectiveCfg) {
        const refreshedAuthorization = await resolveDirectAuthorization(result.updatedCfg, false);
        if (refreshedAuthorization.ingress.ingress.admission !== "dispatch") {
          log(
            `feishu[${account.accountId}]: current policy rejected stale DM from ${ctx.senderOpenId} ` +
              `before adopting refreshed dynamic route (dmPolicy=${refreshedAuthorization.dmPolicy})`,
          );
          return;
        }
        effectiveCfg = result.updatedCfg;
        effectiveDmPolicy = refreshedAuthorization.dmPolicy;
        effectiveConfigAllowFrom = refreshedAuthorization.configAllowFrom;
        effectiveDmIngress = refreshedAuthorization.ingress;
        effectiveShouldComputeCommandAuthorized =
          refreshedAuthorization.shouldComputeCommandAuthorized;
        route = core.channel.routing.resolveAgentRoute({
          cfg: result.updatedCfg,
          channel: "feishu",
          accountId: account.accountId,
          peer: { kind: "direct", id: ctx.senderOpenId },
        });
        if (result.created) {
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

    const commandAllowFrom = isGroup
      ? (groupConfig?.allowFrom ?? effectiveConfigAllowFrom)
      : (effectiveDmIngress?.senderAccess.effectiveAllowFrom ?? effectiveConfigAllowFrom);

    const currentConversationId = peerId;
    const parentConversationId = isGroup ? (parentPeer?.id ?? ctx.chatId) : undefined;
    let configuredBinding = null;
    if (feishuAcpConversationSupported) {
      const configuredRoute = resolveConfiguredBindingRoute({
        cfg: effectiveCfg,
        route,
        conversation: {
          channel: "feishu",
          accountId: account.accountId,
          conversationId: currentConversationId,
          parentConversationId,
        },
      });
      configuredBinding = configuredRoute.bindingResolution;
      route = configuredRoute.route;

      // Bound Feishu conversations intentionally require an exact live conversation-id match.
      // Sender-scoped topic sessions therefore bind on `chat:topic:root:sender:user`, while
      // configured ACP bindings may still inherit the shared `chat:topic:root` topic session.
      const runtimeRoute = resolveRuntimeConversationBindingRoute({
        route,
        conversation: {
          channel: "feishu",
          accountId: account.accountId,
          conversationId: currentConversationId,
          ...(parentConversationId ? { parentConversationId } : {}),
        },
      });
      route = runtimeRoute.route;
      if (runtimeRoute.bindingRecord) {
        configuredBinding = null;
        log(
          runtimeRoute.boundSessionKey
            ? `feishu[${account.accountId}]: routed via bound conversation ${currentConversationId} -> ${runtimeRoute.boundSessionKey}`
            : `feishu[${account.accountId}]: plugin-bound conversation ${currentConversationId}`,
        );
      }
    }

    if (configuredBinding) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg: effectiveCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        const acpTopicReply =
          isGroup &&
          (groupSession?.groupSessionScope === "group_topic" ||
            groupSession?.groupSessionScope === "group_topic_sender");
        const replyTargetMessageId = directThreadReply
          ? directThreadReplyTargetMessageId
          : acpTopicReply
            ? (ctx.rootId ?? ctx.messageId)
            : ctx.messageId;
        await sendMessageFeishu({
          cfg: effectiveCfg,
          to: `chat:${ctx.chatId}`,
          text: `⚠️ Failed to initialize the configured ACP session for this Feishu conversation: ${ensured.error}`,
          replyToMessageId: replyTargetMessageId,
          replyInThread,
          accountId: account.accountId,
        }).catch((err: unknown) => {
          log(`feishu[${account.accountId}]: failed to send ACP init error reply: ${String(err)}`);
        });
        return;
      }
    }

    const preview = truncateUtf16Safe(ctx.content.replace(/\s+/g, " "), 160);
    const inboundLabel = isGroup
      ? `Feishu[${account.accountId}] message in group ${ctx.chatId}`
      : `Feishu[${account.accountId}] DM from ${ctx.senderOpenId}`;
    const contextVisibilityMode = resolveChannelContextVisibilityMode({
      cfg: effectiveCfg,
      channel: "feishu",
      accountId: account.accountId,
    });

    // Do not enqueue inbound user previews as system events.
    // System events are prepended to future prompts and can be misread as
    // authoritative transcript turns.
    log(`feishu[${account.accountId}]: ${inboundLabel}: ${preview}`);

    // Resolve media from message
    const mediaMaxBytes = (feishuCfg?.mediaMaxMb ?? 30) * 1024 * 1024; // 30MB default
    const mediaResolution = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaList = mediaResolution.media;
    const mediaFailurePresentation = resolveFeishuMediaFailurePresentation(
      event.message.content,
      event.message.message_type,
    );
    const mediaFailureContent =
      mediaResolution.unavailableCount > 0
        ? formatInboundMediaUnavailableText({
            body: mediaFailurePresentation.unavailableBody ?? ctx.content,
            mediaPlaceholder: mediaFailurePresentation.mediaPlaceholder,
            notice: `[feishu ${mediaResolution.unavailableCount > 1 ? `${mediaResolution.unavailableCount} attachments` : "attachment"} unavailable]`,
          })
        : ctx.content;
    // Fetch quoted/replied message content before the empty-message guard
    // so a reply with only @bot (no text, no media) is not dropped when
    // the quoted message carries meaningful content.
    let quotedMessageInfo: Awaited<ReturnType<typeof getMessageFeishu>> = null;
    let quotedContent: string | undefined;
    if (ctx.parentId) {
      try {
        quotedMessageInfo = await getMessageFeishu({
          cfg,
          messageId: ctx.parentId,
          accountId: account.accountId,
        });
        if (
          quotedMessageInfo &&
          (await shouldIncludeFetchedGroupContextMessage({
            cfg,
            accountId: account.accountId,
            chatId: ctx.chatId,
            isGroup,
            allowFrom: effectiveGroupSenderAllowFrom,
            mode: contextVisibilityMode,
            kind: "quote",
            senderId: quotedMessageInfo.senderId,
            senderType: quotedMessageInfo.senderType,
          }))
        ) {
          quotedContent = quotedMessageInfo.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${truncateUtf16Safe(quotedContent, 100)}`,
          );
        } else if (quotedMessageInfo) {
          log(
            `feishu[${account.accountId}]: skipped quoted message from sender ${quotedMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`,
          );
        }
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch quoted message: ${String(err)}`);
      }
    }

    // Skip messages with no text content, no media attachments, and no quoted
    // content. Feishu can deliver empty-text events (e.g. `{"text":""}`) when
    // a user sends a blank message or when media parsing produces an empty
    // string. Writing a blank user turn to the session causes downstream LLM
    // providers (e.g. MiniMax) to reject the request with "messages must not
    // be empty" errors. Logging the skip avoids silent loss without polluting
    // the agent session. Quoted content is checked too so a reply-only @bot
    // with quoted context is not dropped.
    if (!mediaFailureContent.trim() && mediaList.length === 0 && !quotedContent?.trim()) {
      log(
        `feishu[${account.accountId}]: skipping empty message (no text, no media, no quoted) from ${ctx.senderOpenId}`,
      );
      return;
    }

    const audioTranscript = await resolveFeishuAudioPreflightTranscript({
      cfg: effectiveCfg,
      mediaList,
      content: ctx.content,
      chatType: isGroup ? "group" : "direct",
      log,
    });
    const preflightAudioIndex =
      audioTranscript === undefined
        ? -1
        : mediaList.findIndex((media) => media.contentType?.startsWith("audio/"));
    const inboundMedia = toInboundMediaFacts(mediaList, {
      transcribed: (_media, index) => index === preflightAudioIndex,
    });
    const agentFacingContent = audioTranscript ?? mediaFailureContent;
    const commandFacingContent = audioTranscript ?? ctx.content;
    const agentFacingCtx =
      agentFacingContent === ctx.content
        ? ctx
        : {
            ...ctx,
            content: agentFacingContent,
          };
    const effectiveCommandProbeBody =
      audioTranscript === undefined
        ? commandProbeBody
        : isGroup
          ? normalizeFeishuCommandProbeBody(audioTranscript)
          : audioTranscript;
    const shouldComputeEffectiveCommandAuthorized =
      audioTranscript === undefined
        ? effectiveShouldComputeCommandAuthorized
        : core.channel.commands.shouldComputeCommandAuthorized(
            effectiveCommandProbeBody,
            effectiveCfg,
          );
    const commandAuthorized = shouldComputeEffectiveCommandAuthorized
      ? isDirect && audioTranscript === undefined && effectiveDmIngress
        ? effectiveDmIngress.commandAccess.authorized
        : isGroup
          ? (
              await resolveFeishuGroupSenderActivationIngressAccess({
                cfg: effectiveCfg,
                accountId: account.accountId,
                chatId: ctx.chatId,
                allowFrom: commandAllowFrom,
                senderOpenId: ctx.senderOpenId,
                senderUserId,
                requireMention: false,
                mentionedBot: true,
                command: { hasControlCommand: true },
              })
            ).commandAccess.authorized
          : (
              await resolveFeishuDmIngressAccess({
                cfg: effectiveCfg,
                accountId: account.accountId,
                dmPolicy: effectiveDmPolicy,
                allowFrom: effectiveConfigAllowFrom,
                readAllowFromStore: pairing.readAllowFromStore,
                senderOpenId: ctx.senderOpenId,
                senderUserId,
                conversationId: ctx.senderOpenId,
                mayPair: false,
                command: { hasControlCommand: true },
              })
            ).commandAccess.authorized
      : undefined;

    const isTopicSessionForThread =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const messageBody = buildFeishuAgentBody({
      ctx: agentFacingCtx,
      quotedContent,
      permissionErrorForAgent,
      botOpenId,
    });
    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderOpenId}` : ctx.senderOpenId;
    if (permissionErrorForAgent) {
      // Keep the notice in a single dispatch to avoid duplicate replies (#27372).
      log(`feishu[${account.accountId}]: appending permission error notice to message body`);
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Feishu",
      from: envelopeFrom,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = groupHistoryKey;

    if (isGroup && historyKey && chatHistories) {
      const channelHistory = createChannelHistoryWindow({ historyMap: chatHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            // Preserve speaker identity in group history as well.
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const inboundHistory =
      isGroup && historyKey && historyLimit > 0 && chatHistories
        ? createChannelHistoryWindow({ historyMap: chatHistories }).buildInboundHistory({
            historyKey,
            limit: historyLimit,
          })
        : undefined;

    const threadContextBySessionKey = new Map<
      string,
      {
        threadStarterBody?: string;
        threadHistoryBody?: string;
        threadLabel?: string;
      }
    >();
    let rootMessageInfo: Awaited<ReturnType<typeof getMessageFeishu>> | undefined;
    let rootMessageThreadId: string | undefined;
    let rootMessageFetched = false;
    const getRootMessageInfo = async () => {
      if (!ctx.rootId) {
        return null;
      }
      if (!rootMessageFetched) {
        rootMessageFetched = true;
        if (ctx.rootId === ctx.parentId && quotedMessageInfo) {
          rootMessageInfo = quotedMessageInfo;
        } else {
          try {
            rootMessageInfo = await getMessageFeishu({
              cfg,
              messageId: ctx.rootId,
              accountId: account.accountId,
            });
          } catch (err) {
            log(`feishu[${account.accountId}]: failed to fetch root message: ${String(err)}`);
            rootMessageInfo = null;
          }
        }
        rootMessageThreadId = rootMessageInfo?.threadId;
        if (
          rootMessageInfo &&
          !(await shouldIncludeFetchedGroupContextMessage({
            cfg,
            accountId: account.accountId,
            chatId: ctx.chatId,
            isGroup,
            allowFrom: effectiveGroupSenderAllowFrom,
            mode: contextVisibilityMode,
            kind: "thread",
            senderId: rootMessageInfo.senderId,
            senderType: rootMessageInfo.senderType,
          }))
        ) {
          log(
            `feishu[${account.accountId}]: skipped thread starter from sender ${rootMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`,
          );
          rootMessageInfo = null;
        }
      }
      return rootMessageInfo ?? null;
    };
    let groupNamePromise: Promise<string | undefined> | undefined;
    const resolveGroupNameForLabel = (): Promise<string | undefined> => {
      if (!isGroup) {
        return Promise.resolve(undefined);
      }
      groupNamePromise ??= resolveGroupName({ account, chatId: ctx.chatId, log });
      return groupNamePromise;
    };

    const resolveThreadContextForAgent = async (
      agentId: string,
      agentSessionKey: string,
      groupName: string | undefined,
    ) => {
      const cached = threadContextBySessionKey.get(agentSessionKey);
      if (cached) {
        return cached;
      }

      const threadContext: {
        threadStarterBody?: string;
        threadHistoryBody?: string;
        threadLabel?: string;
      } = {
        threadLabel:
          (ctx.rootId || ctx.threadId) && isTopicSessionForThread
            ? `Feishu thread in ${groupName ?? ctx.chatId}`
            : undefined,
      };

      if (!(ctx.rootId || ctx.threadId) || !isTopicSessionForThread) {
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, { agentId });
      const previousThreadSessionTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: agentSessionKey,
      });
      if (previousThreadSessionTimestamp) {
        log(
          `feishu[${account.accountId}]: skipping thread bootstrap for existing session ${agentSessionKey}`,
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      const rootMsg = await getRootMessageInfo();
      const feishuThreadId = ctx.threadId ?? rootMessageThreadId ?? rootMsg?.threadId;
      if (feishuThreadId) {
        log(`feishu[${account.accountId}]: resolved thread ID: ${feishuThreadId}`);
      }
      if (!feishuThreadId) {
        log(
          `feishu[${account.accountId}]: no threadId found for root message ${ctx.rootId ?? "none"}, skipping thread history`,
        );
        threadContextBySessionKey.set(agentSessionKey, threadContext);
        return threadContext;
      }

      try {
        const threadMessages = await listFeishuThreadMessages({
          cfg,
          threadId: feishuThreadId,
          currentMessageId: ctx.messageId,
          rootMessageId: ctx.rootId,
          limit: 20,
          accountId: account.accountId,
        });
        const senderScoped = groupSession?.groupSessionScope === "group_topic_sender";
        const senderIds = new Set(
          [ctx.senderOpenId, senderUserId]
            .map((id) => id?.trim())
            .filter((id): id is string => id !== undefined && id.length > 0),
        );
        const allowlistedMessages = await filterFetchedGroupContextMessages(threadMessages, {
          cfg,
          accountId: account.accountId,
          chatId: ctx.chatId,
          isGroup,
          allowFrom: effectiveGroupSenderAllowFrom,
          mode: contextVisibilityMode,
          kind: "history",
        });
        const relevantMessages =
          (senderScoped
            ? allowlistedMessages.filter(
                (msg) =>
                  msg.senderType === "app" ||
                  (msg.senderId !== undefined && senderIds.has(msg.senderId.trim())),
              )
            : allowlistedMessages) ?? [];

        const threadStarterBody = rootMsg?.content ?? relevantMessages[0]?.content;
        const includeStarterInHistory = Boolean(rootMsg?.content || ctx.rootId);
        const historyMessages = includeStarterInHistory
          ? relevantMessages
          : relevantMessages.slice(1);
        const historyParts = historyMessages.map((msg) => {
          const role = msg.senderType === "app" ? "assistant" : "user";
          return core.channel.reply.formatAgentEnvelope({
            channel: "Feishu",
            from: `${msg.senderId ?? "Unknown"} (${role})`,
            timestamp: msg.createTime,
            body: msg.content,
            envelope: envelopeOptions,
          });
        });

        threadContext.threadStarterBody = threadStarterBody;
        threadContext.threadHistoryBody =
          historyParts.length > 0 ? historyParts.join("\n\n") : undefined;
        log(
          `feishu[${account.accountId}]: populated thread bootstrap with starter=${threadStarterBody ? "yes" : "no"} history=${historyMessages.length}`,
        );
      } catch (err) {
        log(`feishu[${account.accountId}]: failed to fetch thread history: ${String(err)}`);
      }

      threadContextBySessionKey.set(agentSessionKey, threadContext);
      return threadContext;
    };

    // --- Shared context builder for dispatch ---
    const buildCtxPayloadForAgent = async (
      agentId: string,
      agentSessionKey: string,
      agentAccountId: string,
      wasMentioned: boolean,
    ) => {
      const groupName = await resolveGroupNameForLabel();
      const threadContext = await resolveThreadContextForAgent(agentId, agentSessionKey, groupName);
      return buildChannelInboundEventContext({
        channel: "feishu",
        finalize: core.channel.reply.finalizeInboundContext,
        supplemental: {
          quote: quotedContent ? { id: ctx.parentId, body: quotedContent } : undefined,
          thread: {
            starterBody: threadContext.threadStarterBody,
            historyBody: threadContext.threadHistoryBody,
            label: threadContext.threadLabel,
          },
          groupSystemPrompt: isGroup
            ? normalizeOptionalString(groupConfig?.systemPrompt)
            : undefined,
        },
        media: inboundMedia,
        messageId: ctx.messageId,
        timestamp: messageCreateTimeMs,
        from: feishuFrom,
        sender: {
          id: ctx.senderOpenId,
          name: ctx.senderName ?? ctx.senderOpenId,
        },
        conversation: {
          kind: isGroup ? "group" : "direct",
          id: ctx.chatId,
          nativeChannelId: ctx.chatId,
          label: isGroup && groupName && !isTopicSessionForThread ? groupName : undefined,
          threadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
        },
        route: {
          agentId,
          accountId: agentAccountId,
          routeSessionKey: agentSessionKey,
        },
        reply: {
          to: feishuTo,
          replyToId: ctx.parentId,
          messageThreadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
        },
        message: {
          body: combinedBody,
          bodyForAgent: messageBody,
          inboundHistory,
          rawBody: commandFacingContent,
          commandBody: commandFacingContent,
        },
        access: {
          mentions: {
            canDetectMention: isGroup,
            wasMentioned,
            requireMention,
          },
          commands: {
            authorized: commandAuthorized === true,
          },
        },
        extra: {
          RootMessageId: ctx.rootId,
          Transcript: audioTranscript,
          GroupSubject: isGroup ? groupName || ctx.chatId : undefined,
        },
      });
    };

    // Determine reply target based on group session mode:
    // - Topic-mode groups (group_topic / group_topic_sender): reply to the topic
    //   root so the bot stays in the same thread.
    // - Groups with explicit replyInThread config: reply to the root so the bot
    //   stays in the thread the user expects.
    // - Normal groups (auto-detected threadReply from root_id): reply to the
    //   triggering message itself. Using rootId here would silently push the
    //   reply into a topic thread invisible in the main chat view (#32980).
    const isTopicSession =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");
    const configReplyInThread =
      isGroup &&
      (groupConfig?.replyInThread ?? feishuCfg?.replyInThread ?? "disabled") === "enabled";
    const topicReplyTargetMessageId = ctx.rootId ?? defaultReplyTargetMessageId;
    const replyTargetMessageId = directThreadReply
      ? directThreadReplyTargetMessageId
      : isTopicSession || configReplyInThread
        ? topicReplyTargetMessageId
        : defaultReplyTargetMessageId;
    const typingTargetMessageId =
      ctx.typingTargetMessageId ?? (ctx.suppressReplyTarget ? undefined : ctx.messageId);
    const threadReply = isGroup ? (groupSession?.threadReply ?? false) : directThreadReply;
    const lastRouteThreadId =
      isGroup && (isTopicSession || configReplyInThread || threadReply)
        ? replyTargetMessageId
        : undefined;
    const pinnedMainDmOwner = !isGroup
      ? resolvePinnedMainDmOwnerFromAllowlist({
          dmScope: effectiveCfg.session?.dmScope,
          allowFrom: effectiveConfigAllowFrom,
          normalizeEntry: normalizeFeishuAllowEntry,
        })
      : null;
    const pinnedMainDmSenderRecipient = pinnedMainDmOwner
      ? [ctx.senderOpenId, senderUserId]
          .map((id) => (id ? normalizeFeishuAllowEntry(id) : ""))
          .find((recipient) => recipient === pinnedMainDmOwner)
      : undefined;
    const buildFeishuInboundLastRouteUpdate = (paramsLocal: {
      accountId: string;
      sessionKey: string;
    }) => {
      const inboundLastRouteSessionKey =
        paramsLocal.sessionKey === route.sessionKey
          ? resolveInboundLastRouteSessionKey({
              route,
              sessionKey: paramsLocal.sessionKey,
            })
          : paramsLocal.sessionKey;
      return {
        sessionKey: inboundLastRouteSessionKey,
        channel: "feishu" as const,
        to: feishuTo,
        accountId: paramsLocal.accountId,
        ...(lastRouteThreadId ? { threadId: lastRouteThreadId } : {}),
        mainDmOwnerPin:
          !isGroup && inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
            ? {
                ownerRecipient: pinnedMainDmOwner,
                senderRecipient: pinnedMainDmSenderRecipient ?? feishuTo,
                onSkip: (skipParams: { ownerRecipient: string; senderRecipient: string }) => {
                  log(
                    `feishu[${account.accountId}]: skip main-session last route for ${skipParams.senderRecipient} (pinned owner ${skipParams.ownerRecipient})`,
                  );
                },
              }
            : undefined,
      };
    };

    if (broadcastAgents) {
      // Cross-account dedup: in multi-account setups, Feishu delivers the same
      // event to every bot account in the group. Only one account should handle
      // broadcast dispatch to avoid duplicate agent sessions and race conditions.
      // Uses a shared "broadcast" namespace (not per-account) so the first handler
      // to reach this point claims the message; subsequent accounts skip.
      if (
        !(await recordProcessedFeishuMessage(messageDedupeKey ?? ctx.messageId, "broadcast", log))
      ) {
        log(
          `feishu[${account.accountId}]: broadcast already claimed by another account for message ${ctx.messageId}; skipping`,
        );
        return;
      }

      // --- Broadcast dispatch: send message to all configured agents ---
      const rawStrategy = (
        (cfg as Record<string, unknown>).broadcast as Record<string, unknown> | undefined
      )?.strategy;
      const strategy = rawStrategy === "sequential" ? "sequential" : "parallel";
      const activeAgentId =
        ctx.mentionedBot || !requireMention ? normalizeAgentId(route.agentId) : null;
      const agentIds = (cfg.agents?.list ?? []).map((a: { id: string }) => normalizeAgentId(a.id));
      const hasKnownAgents = agentIds.length > 0;

      log(
        `feishu[${account.accountId}]: broadcasting to ${broadcastAgents.length} agents (strategy=${strategy}, active=${activeAgentId ?? "none"})`,
      );

      const dispatchForAgent = async (agentId: string) => {
        if (hasKnownAgents && !agentIds.includes(normalizeAgentId(agentId))) {
          log(
            `feishu[${account.accountId}]: broadcast agent ${agentId} not found in agents.list; skipping`,
          );
          return;
        }

        const agentSessionKey = buildBroadcastSessionKey(route.sessionKey, route.agentId, agentId);
        const agentStorePath = core.channel.session.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const agentRecord = {
          updateLastRoute: buildFeishuInboundLastRouteUpdate({
            sessionKey: agentSessionKey,
            accountId: route.accountId,
          }),
          onRecordError: (err: unknown) => {
            log(
              `feishu[${account.accountId}]: failed to record broadcast inbound session ${agentSessionKey}: ${String(err)}`,
            );
          },
        };
        const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
          cfg,
          agentId,
          storePath: agentStorePath,
          sessionKey: agentSessionKey,
        });
        const agentCtx = await buildCtxPayloadForAgent(
          agentId,
          agentSessionKey,
          route.accountId,
          ctx.mentionedBot && agentId === activeAgentId,
        );

        if (agentId === activeAgentId) {
          // Active agent: real Feishu dispatcher (responds on Feishu)
          const identity = resolveAgentOutboundIdentity(cfg, agentId);
          const { dispatcher, replyOptions, markDispatchIdle, ensureNoVisibleReplyFallback } =
            createFeishuReplyDispatcher({
              cfg,
              agentId,
              runtime: runtime as RuntimeEnv,
              chatId: ctx.chatId,
              sendTarget: feishuTo,
              allowReasoningPreview,
              replyToMessageId: replyTargetMessageId,
              typingTargetMessageId,
              skipReplyToInMessages: !isGroup && !directThreadReply,
              replyInThread,
              rootId: ctx.rootId,
              threadReply,
              accountId: account.accountId,
              identity,
              mentionTargets: ctx.mentionTargets,
              messageCreateTimeMs,
              sessionKey: agentSessionKey,
            });

          log(
            `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          const turnResult = await core.channel.inbound.run({
            channel: "feishu",
            accountId: route.accountId,
            raw: ctx,
            adapter: {
              ingest: () => ({
                id: ctx.messageId,
                timestamp: messageCreateTimeMs,
                rawText: ctx.content,
                textForAgent: agentCtx.BodyForAgent,
                textForCommands: agentCtx.CommandBody,
                raw: ctx,
              }),
              resolveTurn: () => ({
                channel: "feishu",
                accountId: route.accountId,
                routeSessionKey: agentSessionKey,
                storePath: agentStorePath,
                ctxPayload: agentCtx,
                recordInboundSession: core.channel.session.recordInboundSession,
                record: agentRecord,
                onPreDispatchFailure: () =>
                  core.channel.reply.settleReplyDispatcher({
                    dispatcher,
                    onSettled: () => markDispatchIdle(),
                  }),
                runDispatch: () =>
                  core.channel.reply.withReplyDispatcher({
                    dispatcher,
                    onSettled: () => markDispatchIdle(),
                    run: () =>
                      core.channel.reply.dispatchReplyFromConfig({
                        ctx: agentCtx,
                        cfg,
                        dispatcher,
                        replyOptions,
                      }),
                  }),
              }),
            },
          });
          if (
            turnResult.dispatched &&
            shouldSendNoVisibleReplyFallback({
              ...turnResult.dispatchResult,
              failedCounts: dispatcher.getFailedCounts?.() ?? { tool: 0, block: 0, final: 0 },
            })
          ) {
            await ensureNoVisibleReplyFallback("broadcast-dispatch-complete-no-visible-reply");
          }
        } else {
          // Observer agent: no-op dispatcher (session entry + inference, no Feishu reply).
          // Strip CommandAuthorized so slash commands (e.g. /reset) don't silently
          // mutate observer sessions — only the active agent should execute commands.
          delete (agentCtx as Record<string, unknown>).CommandAuthorized;
          const noopDispatcher = {
            sendToolResult: () => false,
            sendBlockReply: () => false,
            sendFinalReply: () => false,
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
            markComplete: () => {},
          };

          log(
            `feishu[${account.accountId}]: broadcast observer dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          await core.channel.inbound.run({
            channel: "feishu",
            accountId: route.accountId,
            raw: ctx,
            adapter: {
              ingest: () => ({
                id: ctx.messageId,
                timestamp: messageCreateTimeMs,
                rawText: ctx.content,
                textForAgent: agentCtx.BodyForAgent,
                textForCommands: agentCtx.CommandBody,
                raw: ctx,
              }),
              resolveTurn: () => ({
                channel: "feishu",
                accountId: route.accountId,
                routeSessionKey: agentSessionKey,
                storePath: agentStorePath,
                ctxPayload: agentCtx,
                recordInboundSession: core.channel.session.recordInboundSession,
                record: agentRecord,
                runDispatch: () =>
                  core.channel.reply.withReplyDispatcher({
                    dispatcher: noopDispatcher,
                    run: () =>
                      core.channel.reply.dispatchReplyFromConfig({
                        ctx: agentCtx,
                        cfg,
                        dispatcher: noopDispatcher,
                      }),
                  }),
              }),
            },
          });
        }
      };

      if (strategy === "sequential") {
        for (const agentId of broadcastAgents) {
          try {
            await dispatchForAgent(agentId);
          } catch (err) {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(err)}`,
            );
          }
        }
      } else {
        const results = await Promise.allSettled(broadcastAgents.map(dispatchForAgent));
        for (const [i, result] of results.entries()) {
          if (result.status === "rejected") {
            const agentId = broadcastAgents.at(i);
            if (agentId === undefined) {
              continue;
            }
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${agentId}: ${String(result.reason)}`,
            );
          }
        }
      }

      if (isGroup && historyKey && chatHistories) {
        createChannelHistoryWindow({ historyMap: chatHistories }).clear({
          historyKey,
          limit: historyLimit,
        });
      }

      log(
        `feishu[${account.accountId}]: broadcast dispatch complete for ${broadcastAgents.length} agents`,
      );
    } else {
      // --- Single-agent dispatch (existing behavior) ---
      const ctxPayload = await buildCtxPayloadForAgent(
        route.agentId,
        route.sessionKey,
        route.accountId,
        ctx.mentionedBot,
      );

      const identity = resolveAgentOutboundIdentity(effectiveCfg, route.agentId);
      const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
        agentId: route.agentId,
      });
      const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
        cfg: effectiveCfg,
        agentId: route.agentId,
        storePath,
        sessionKey: route.sessionKey,
      });
      const { dispatcher, replyOptions, markDispatchIdle, ensureNoVisibleReplyFallback } =
        createFeishuReplyDispatcher({
          cfg: effectiveCfg,
          agentId: route.agentId,
          runtime: runtime as RuntimeEnv,
          chatId: ctx.chatId,
          sendTarget: feishuTo,
          allowReasoningPreview,
          replyToMessageId: replyTargetMessageId,
          typingTargetMessageId,
          skipReplyToInMessages: !isGroup && !directThreadReply,
          replyInThread,
          rootId: ctx.rootId,
          threadReply,
          accountId: account.accountId,
          identity,
          mentionTargets: ctx.mentionTargets,
          messageCreateTimeMs,
          sessionKey: route.sessionKey,
        });

      log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
      const turnResult = await core.channel.inbound.run({
        channel: "feishu",
        accountId: route.accountId,
        raw: ctx,
        adapter: {
          ingest: () => ({
            id: ctx.messageId,
            timestamp: messageCreateTimeMs,
            rawText: ctx.content,
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: ctx,
          }),
          resolveTurn: () => ({
            channel: "feishu",
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath,
            ctxPayload,
            recordInboundSession: core.channel.session.recordInboundSession,
            record: {
              updateLastRoute: buildFeishuInboundLastRouteUpdate({
                sessionKey: route.sessionKey,
                accountId: route.accountId,
              }),
              onRecordError: (err) => {
                log(
                  `feishu[${account.accountId}]: failed to record inbound session ${route.sessionKey}: ${String(err)}`,
                );
              },
            },
            history: {
              isGroup,
              historyKey,
              historyMap: chatHistories,
              limit: historyLimit,
            },
            onPreDispatchFailure: () =>
              core.channel.reply.settleReplyDispatcher({
                dispatcher,
                onSettled: () => markDispatchIdle(),
              }),
            runDispatch: () =>
              core.channel.reply.withReplyDispatcher({
                dispatcher,
                onSettled: () => {
                  markDispatchIdle();
                },
                run: () =>
                  core.channel.reply.dispatchReplyFromConfig({
                    ctx: ctxPayload,
                    cfg: effectiveCfg,
                    dispatcher,
                    replyOptions,
                  }),
              }),
          }),
        },
      });
      if (!turnResult.dispatched) {
        return;
      }
      const { dispatchResult } = turnResult;
      const { queuedFinal, counts } = dispatchResult;
      if (
        shouldSendNoVisibleReplyFallback({
          ...dispatchResult,
          failedCounts: dispatcher.getFailedCounts?.() ?? { tool: 0, block: 0, final: 0 },
        })
      ) {
        await ensureNoVisibleReplyFallback("dispatch-complete-no-visible-reply");
      }

      log(
        `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
      );
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
