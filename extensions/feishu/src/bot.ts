import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "openclaw/plugin-sdk/conversation-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentOutboundIdentity } from "openclaw/plugin-sdk/outbound-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { deriveLastRoutePolicy } from "openclaw/plugin-sdk/routing";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import {
  checkBotMentioned,
  normalizeFeishuCommandProbeBody,
  normalizeMentions,
  parseMergeForwardContent,
  parseMessageContent,
  resolveFeishuGroupSession,
  resolveFeishuMediaList,
  toMessageResourceType,
} from "./bot-content.js";
import {
  buildAgentMediaPayload,
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  normalizeAgentId,
  resolveChannelContextVisibilityMode,
} from "./bot-runtime-api.js";
import type { ClawdbotConfig, RuntimeEnv } from "./bot-runtime-api.js";
import { type FeishuPermissionError, resolveFeishuSenderName } from "./bot-sender-name.js";
import { createFeishuClient } from "./client.js";
import { finalizeFeishuMessageProcessing, tryRecordMessagePersistent } from "./dedup.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import { extractMentionTargets, isMentionForwardRequest } from "./mention.js";
import {
  resolveFeishuGroupConfig,
  resolveFeishuReplyPolicy,
  resolveFeishuAllowlistMatch,
  isFeishuGroupAllowed,
} from "./policy.js";
import { resolveFeishuReasoningPreviewEnabled } from "./reasoning-preview.js";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu, listFeishuThreadMessages, sendMessageFeishu } from "./send.js";
export type { FeishuBotAddedEvent, FeishuMessageEvent } from "./event-types.js";
import type { FeishuMessageEvent } from "./event-types.js";
import type { FeishuMessageContext, FeishuMessageInfo } from "./types.js";
import type { DynamicAgentCreationConfig } from "./types.js";

export { toMessageResourceType } from "./bot-content.js";

// Cache permission errors to avoid spamming the user with repeated notifications.
// Key: appId or "default", Value: timestamp of last notification
const permissionErrorNotifiedAt = new Map<string, number>();
const PERMISSION_ERROR_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// --- Broadcast support ---
// Resolve broadcast agent list for a given peer (group) ID.
// Returns null if no broadcast config exists or the peer is not in the broadcast list.
export function resolveBroadcastAgents(cfg: ClawdbotConfig, peerId: string): string[] | null {
  const broadcast = (cfg as Record<string, unknown>).broadcast;
  if (!broadcast || typeof broadcast !== "object") {
    return null;
  }
  const agents = (broadcast as Record<string, unknown>)[peerId];
  if (!Array.isArray(agents) || agents.length === 0) {
    return null;
  }
  return agents as string[];
}

// Build a session key for a broadcast target agent by replacing the agent ID prefix.
// Session keys follow the format: agent:<agentId>:<channel>:<peerKind>:<peerId>
export function buildBroadcastSessionKey(
  baseSessionKey: string,
  originalAgentId: string,
  targetAgentId: string,
): string {
  const prefix = `agent:${originalAgentId}:`;
  if (baseSessionKey.startsWith(prefix)) {
    return `agent:${targetAgentId}:${baseSessionKey.slice(prefix.length)}`;
  }
  return baseSessionKey;
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
  if (isMentionForwardRequest(event, botOpenId)) {
    const mentionTargets = extractMentionTargets(event, botOpenId);
    if (mentionTargets.length > 0) {
      ctx.mentionTargets = mentionTargets;
    }
  }

  return ctx;
}

export function buildFeishuAgentBody(params: {
  ctx: Pick<
    FeishuMessageContext,
    "content" | "senderName" | "senderOpenId" | "mentionTargets" | "messageId" | "hasAnyMention"
  >;
  quotedContent?: string;
  permissionErrorForAgent?: FeishuPermissionError;
  botOpenId?: string;
}): string {
  const { ctx, quotedContent, permissionErrorForAgent, botOpenId } = params;
  let messageBody = ctx.content;
  if (quotedContent) {
    messageBody = `[Replying to: "${quotedContent}"]\n\n${ctx.content}`;
  }

  // DMs already have per-sender sessions, but this label still improves attribution.
  const speaker = ctx.senderName ?? ctx.senderOpenId;
  messageBody = `${speaker}: ${messageBody}`;

  if (ctx.hasAnyMention) {
    const botIdHint = botOpenId?.trim();
    messageBody +=
      `\n\n[System: The content may include mention tags in the form <at user_id="...">name</at>. ` +
      `Treat these as real mentions of Feishu entities (users or bots).]`;
    if (botIdHint) {
      messageBody += `\n[System: If user_id is "${botIdHint}", that mention refers to you.]`;
    }
  }

  if (ctx.mentionTargets && ctx.mentionTargets.length > 0) {
    const targetNames = ctx.mentionTargets.map((t) => t.name).join(", ");
    messageBody += `\n\n[System: Your reply will automatically @mention: ${targetNames}. Do not write @xxx yourself.]`;
  }

  // Keep message_id on its own line so shared message-id hint stripping can parse it reliably.
  messageBody = `[message_id: ${ctx.messageId}]\n${messageBody}`;

  if (permissionErrorForAgent) {
    const grantUrl = permissionErrorForAgent.grantUrl ?? "";
    messageBody += `\n\n[System: The bot encountered a Feishu API permission error. Please inform the user about this issue and provide the permission grant URL for the admin to authorize. Permission grant URL: ${grantUrl}]`;
  }

  return messageBody;
}

function isFetchedGroupContextSenderAllowed(params: {
  isGroup: boolean;
  allowFrom: Array<string | number>;
  senderId?: string;
  senderType?: string;
}): boolean {
  if (!params.isGroup || params.allowFrom.length === 0) {
    return true;
  }
  if (params.senderType === "app") {
    return true;
  }
  const senderId = params.senderId?.trim();
  const senderAllowed =
    !!senderId &&
    isFeishuGroupAllowed({
      groupPolicy: "allowlist",
      allowFrom: params.allowFrom,
      senderId,
      senderName: undefined,
    });
  return senderAllowed;
}

function shouldIncludeFetchedGroupContextMessage(params: {
  isGroup: boolean;
  allowFrom: Array<string | number>;
  mode: "all" | "allowlist" | "allowlist_quote";
  kind: "quote" | "thread" | "history";
  senderId?: string;
  senderType?: string;
}): boolean {
  const senderAllowed = isFetchedGroupContextSenderAllowed({
    isGroup: params.isGroup,
    allowFrom: params.allowFrom,
    senderId: params.senderId,
    senderType: params.senderType,
  });
  return evaluateSupplementalContextVisibility({
    mode: params.mode,
    kind: params.kind,
    senderAllowed,
  }).include;
}

function filterFetchedGroupContextMessages<
  T extends Pick<FeishuMessageInfo, "senderId" | "senderType">,
>(
  messages: readonly T[],
  params: {
    isGroup: boolean;
    allowFrom: Array<string | number>;
    mode: "all" | "allowlist" | "allowlist_quote";
    kind: "quote" | "thread" | "history";
  },
): T[] {
  return filterSupplementalContextItems({
    items: messages,
    mode: params.mode,
    kind: params.kind,
    isSenderAllowed: (message) =>
      isFetchedGroupContextSenderAllowed({
        isGroup: params.isGroup,
        allowFrom: params.allowFrom,
        senderId: message.senderId,
        senderType: message.senderType,
      }),
  }).items;
}

export async function handleFeishuMessage(params: {
  cfg: ClawdbotConfig;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  accountId?: string;
  processingClaimHeld?: boolean;
}): Promise<void> {
  const {
    cfg,
    event,
    botOpenId,
    botName,
    runtime,
    chatHistories,
    accountId,
    processingClaimHeld = false,
  } = params;

  // Resolve account with merged config
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  const feishuCfg = account.config;

  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const messageId = event.message.message_id;
  if (
    !(await finalizeFeishuMessageProcessing({
      messageId,
      namespace: account.accountId,
      log,
      claimHeld: processingClaimHeld,
    }))
  ) {
    log(`feishu: skipping duplicate message ${messageId}`);
    return;
  }

  let ctx = parseFeishuMessageEvent(event, botOpenId, botName);
  const isGroup = ctx.chatType === "group";
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
        threadId: ctx.threadId,
        groupConfig,
        feishuCfg,
      })
    : null;
  const groupHistoryKey = isGroup ? (groupSession?.peerId ?? ctx.chatId) : undefined;
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const rawBroadcastAgents = isGroup ? resolveBroadcastAgents(cfg, ctx.chatId) : null;
  const broadcastAgents = rawBroadcastAgents
    ? [...new Set(rawBroadcastAgents.map((id) => normalizeAgentId(id)))]
    : null;

  // Parse message create_time early so every downstream consumer (pending
  // history, inbound payload, etc.) uses the original authoring timestamp
  // instead of the delivery/processing time.  Feishu uses a millisecond
  // epoch string; fall back to Date.now() only when the field is absent.
  const messageCreateTimeMs = event.message.create_time
    ? parseInt(event.message.create_time, 10)
    : Date.now();

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

    // Check if this GROUP is allowed (groupAllowFrom contains group IDs like oc_xxx, not user IDs)
    const groupAllowed = isFeishuGroupAllowed({
      groupPolicy,
      allowFrom: groupAllowFrom,
      senderId: ctx.chatId, // Check group ID, not sender ID
      senderName: undefined,
    });

    if (!groupAllowed) {
      log(
        `feishu[${account.accountId}]: group ${ctx.chatId} not in groupAllowFrom (groupPolicy=${groupPolicy})`,
      );
      return;
    }

    // Sender-level allowlist: per-group allowFrom takes precedence, then global groupSenderAllowFrom
    if (effectiveGroupSenderAllowFrom.length > 0) {
      const senderAllowed = isFeishuGroupAllowed({
        groupPolicy: "allowlist",
        allowFrom: effectiveGroupSenderAllowFrom,
        senderId: ctx.senderOpenId,
        senderIds: [senderUserId],
        senderName: ctx.senderName,
      });
      if (!senderAllowed) {
        log(`feishu: sender ${ctx.senderOpenId} not in group ${ctx.chatId} sender allowlist`);
        return;
      }
    }

    ({ requireMention } = resolveFeishuReplyPolicy({
      isDirectMessage: false,
      cfg,
      accountId: account.accountId,
      groupId: ctx.chatId,
      groupPolicy,
    }));

    if (requireMention && !ctx.mentionedBot) {
      log(`feishu[${account.accountId}]: message in group ${ctx.chatId} did not mention bot`);
      // Record to pending history for non-broadcast groups only. For broadcast groups,
      // the mentioned handler's broadcast dispatch writes the turn directly into all
      // agent sessions — buffering here would cause duplicate replay when this account
      // later becomes active via buildPendingHistoryContextFromMap.
      if (!broadcastAgents && chatHistories && groupHistoryKey) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
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
  } else {
  }

  try {
    const core = getFeishuRuntime();
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
    const storeAllowFrom =
      !isGroup &&
      dmPolicy !== "allowlist" &&
      (dmPolicy !== "open" || shouldComputeCommandAuthorized)
        ? await pairing.readAllowFromStore().catch(() => [])
        : [];
    const effectiveDmAllowFrom = [...configAllowFrom, ...storeAllowFrom];
    const dmAllowed = resolveFeishuAllowlistMatch({
      allowFrom: effectiveDmAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;

    if (isDirect && dmPolicy !== "open" && !dmAllowed) {
      if (dmPolicy === "pairing") {
        await pairing.issueChallenge({
          senderId: ctx.senderOpenId,
          senderIdLine: `Your Feishu user id: ${ctx.senderOpenId}`,
          meta: { name: ctx.senderName },
          onCreated: () => {
            log(`feishu[${account.accountId}]: pairing request sender=${ctx.senderOpenId}`);
          },
          sendPairingReply: async (text) => {
            await sendMessageFeishu({
              cfg,
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
          `feishu[${account.accountId}]: blocked unauthorized sender ${ctx.senderOpenId} (dmPolicy=${dmPolicy})`,
        );
      }
      return;
    }

    const commandAllowFrom = isGroup
      ? (groupConfig?.allowFrom ?? configAllowFrom)
      : effectiveDmAllowFrom;
    const senderAllowedForCommands = resolveFeishuAllowlistMatch({
      allowFrom: commandAllowFrom,
      senderId: ctx.senderOpenId,
      senderIds: [senderUserId],
      senderName: ctx.senderName,
    }).allowed;
    const commandAuthorized = shouldComputeCommandAuthorized
      ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
          useAccessGroups,
          authorizers: [
            { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
          ],
        })
      : undefined;

    // In group chats, the session is scoped to the group, but the *speaker* is the sender.
    // Using a group-scoped From causes the agent to treat different users as the same person.
    const feishuFrom = `feishu:${ctx.senderOpenId}`;
    const feishuTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderOpenId}`;
    const peerId = isGroup ? (groupSession?.peerId ?? ctx.chatId) : ctx.senderOpenId;
    const parentPeer = isGroup ? (groupSession?.parentPeer ?? null) : null;
    const replyInThread = isGroup ? (groupSession?.replyInThread ?? false) : false;
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
      cfg,
      channel: "feishu",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: peerId,
      },
      parentPeer,
    });

    // Dynamic agent creation for DM users
    // When enabled, creates a unique agent instance with its own workspace for each DM user.
    let effectiveCfg = cfg;
    if (!isGroup && route.matchedBy === "default") {
      const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
      if (dynamicCfg?.enabled) {
        const runtime = getFeishuRuntime();
        const result = await maybeCreateDynamicAgent({
          cfg,
          runtime,
          senderOpenId: ctx.senderOpenId,
          dynamicCfg,
          log: (msg) => log(msg),
        });
        if (result.created) {
          effectiveCfg = result.updatedCfg;
          // Re-resolve route with updated config
          route = core.channel.routing.resolveAgentRoute({
            cfg: result.updatedCfg,
            channel: "feishu",
            accountId: account.accountId,
            peer: { kind: "direct", id: ctx.senderOpenId },
          });
          log(
            `feishu[${account.accountId}]: dynamic agent created, new route: ${route.sessionKey}`,
          );
        }
      }
    }

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
      const threadBinding = getSessionBindingService().resolveByConversation({
        channel: "feishu",
        accountId: account.accountId,
        conversationId: currentConversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
      });
      const boundSessionKey = threadBinding?.targetSessionKey?.trim();
      if (threadBinding && boundSessionKey) {
        route = {
          ...route,
          sessionKey: boundSessionKey,
          agentId: resolveAgentIdFromSessionKey(boundSessionKey) || route.agentId,
          lastRoutePolicy: deriveLastRoutePolicy({
            sessionKey: boundSessionKey,
            mainSessionKey: route.mainSessionKey,
          }),
          matchedBy: "binding.channel",
        };
        configuredBinding = null;
        getSessionBindingService().touch(threadBinding.bindingId);
        log(
          `feishu[${account.accountId}]: routed via bound conversation ${currentConversationId} -> ${boundSessionKey}`,
        );
      }
    }

    if (configuredBinding) {
      const ensured = await ensureConfiguredBindingRouteReady({
        cfg: effectiveCfg,
        bindingResolution: configuredBinding,
      });
      if (!ensured.ok) {
        const replyTargetMessageId =
          isGroup &&
          (groupSession?.groupSessionScope === "group_topic" ||
            groupSession?.groupSessionScope === "group_topic_sender")
            ? (ctx.rootId ?? ctx.messageId)
            : ctx.messageId;
        await sendMessageFeishu({
          cfg: effectiveCfg,
          to: `chat:${ctx.chatId}`,
          text: `⚠️ Failed to initialize the configured ACP session for this Feishu conversation: ${ensured.error}`,
          replyToMessageId: replyTargetMessageId,
          replyInThread: isGroup ? (groupSession?.replyInThread ?? false) : false,
          accountId: account.accountId,
        }).catch((err) => {
          log(`feishu[${account.accountId}]: failed to send ACP init error reply: ${String(err)}`);
        });
        return;
      }
    }

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
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
    const mediaList = await resolveFeishuMediaList({
      cfg,
      messageId: ctx.messageId,
      messageType: event.message.message_type,
      content: event.message.content,
      maxBytes: mediaMaxBytes,
      log,
      accountId: account.accountId,
    });
    const mediaPayload = buildAgentMediaPayload(mediaList);

    // Fetch quoted/replied message content if parentId exists
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
          shouldIncludeFetchedGroupContextMessage({
            isGroup,
            allowFrom: effectiveGroupSenderAllowFrom,
            mode: contextVisibilityMode,
            kind: "quote",
            senderId: quotedMessageInfo.senderId,
            senderType: quotedMessageInfo.senderType,
          })
        ) {
          quotedContent = quotedMessageInfo.content;
          log(
            `feishu[${account.accountId}]: fetched quoted message: ${quotedContent?.slice(0, 100)}`,
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

    const isTopicSessionForThread =
      isGroup &&
      (groupSession?.groupSessionScope === "group_topic" ||
        groupSession?.groupSessionScope === "group_topic_sender");

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const messageBody = buildFeishuAgentBody({
      ctx,
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
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
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
        ? (chatHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
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
          !shouldIncludeFetchedGroupContextMessage({
            isGroup,
            allowFrom: effectiveGroupSenderAllowFrom,
            mode: contextVisibilityMode,
            kind: "thread",
            senderId: rootMessageInfo.senderId,
            senderType: rootMessageInfo.senderType,
          })
        ) {
          log(
            `feishu[${account.accountId}]: skipped thread starter from sender ${rootMessageInfo.senderId ?? "unknown"} (mode=${contextVisibilityMode})`,
          );
          rootMessageInfo = null;
        }
      }
      return rootMessageInfo ?? null;
    };
    const resolveThreadContextForAgent = async (agentId: string, agentSessionKey: string) => {
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
            ? `Feishu thread in ${ctx.chatId}`
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
      let feishuThreadId = ctx.threadId ?? rootMessageThreadId ?? rootMsg?.threadId;
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
        const allowlistedMessages = filterFetchedGroupContextMessages(threadMessages, {
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
      const threadContext = await resolveThreadContextForAgent(agentId, agentSessionKey);
      return core.channel.reply.finalizeInboundContext({
        Body: combinedBody,
        BodyForAgent: messageBody,
        InboundHistory: inboundHistory,
        ReplyToId: ctx.parentId,
        RootMessageId: ctx.rootId,
        RawBody: ctx.content,
        CommandBody: ctx.content,
        From: feishuFrom,
        To: feishuTo,
        SessionKey: agentSessionKey,
        AccountId: agentAccountId,
        ChatType: isGroup ? "group" : "direct",
        GroupSubject: isGroup ? ctx.chatId : undefined,
        SenderName: ctx.senderName ?? ctx.senderOpenId,
        SenderId: ctx.senderOpenId,
        Provider: "feishu" as const,
        Surface: "feishu" as const,
        MessageSid: ctx.messageId,
        ReplyToBody: quotedContent ?? undefined,
        ThreadStarterBody: threadContext.threadStarterBody,
        ThreadHistoryBody: threadContext.threadHistoryBody,
        ThreadLabel: threadContext.threadLabel,
        // Only use rootId (om_* message anchor) — threadId (omt_*) is a container
        // ID and would produce invalid reply targets downstream.
        MessageThreadId: ctx.rootId && isTopicSessionForThread ? ctx.rootId : undefined,
        Timestamp: messageCreateTimeMs,
        WasMentioned: wasMentioned,
        CommandAuthorized: commandAuthorized,
        OriginatingChannel: "feishu" as const,
        OriginatingTo: feishuTo,
        GroupSystemPrompt: isGroup ? normalizeOptionalString(groupConfig?.systemPrompt) : undefined,
        ...mediaPayload,
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
    const replyTargetMessageId =
      isTopicSession || configReplyInThread ? (ctx.rootId ?? ctx.messageId) : ctx.messageId;
    const threadReply = isGroup ? (groupSession?.threadReply ?? false) : false;

    if (broadcastAgents) {
      // Cross-account dedup: in multi-account setups, Feishu delivers the same
      // event to every bot account in the group. Only one account should handle
      // broadcast dispatch to avoid duplicate agent sessions and race conditions.
      // Uses a shared "broadcast" namespace (not per-account) so the first handler
      // to reach this point claims the message; subsequent accounts skip.
      if (!(await tryRecordMessagePersistent(ctx.messageId, "broadcast", log))) {
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
        const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
          storePath: core.channel.session.resolveStorePath(cfg.session?.store, { agentId }),
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
          const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
            cfg,
            agentId,
            runtime: runtime as RuntimeEnv,
            chatId: ctx.chatId,
            allowReasoningPreview,
            replyToMessageId: replyTargetMessageId,
            skipReplyToInMessages: !isGroup,
            replyInThread,
            rootId: ctx.rootId,
            threadReply,
            mentionTargets: ctx.mentionTargets,
            accountId: account.accountId,
            identity,
            messageCreateTimeMs,
          });

          log(
            `feishu[${account.accountId}]: broadcast active dispatch agent=${agentId} (session=${agentSessionKey})`,
          );
          await core.channel.reply.withReplyDispatcher({
            dispatcher,
            onSettled: () => markDispatchIdle(),
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher,
                replyOptions,
              }),
          });
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
          await core.channel.reply.withReplyDispatcher({
            dispatcher: noopDispatcher,
            run: () =>
              core.channel.reply.dispatchReplyFromConfig({
                ctx: agentCtx,
                cfg,
                dispatcher: noopDispatcher,
              }),
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
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "rejected") {
            log(
              `feishu[${account.accountId}]: broadcast dispatch failed for agent=${broadcastAgents[i]}: ${String((results[i] as PromiseRejectedResult).reason)}`,
            );
          }
        }
      }

      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
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

      const identity = resolveAgentOutboundIdentity(cfg, route.agentId);
      const allowReasoningPreview = resolveFeishuReasoningPreviewEnabled({
        storePath: core.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        }),
        sessionKey: route.sessionKey,
      });
      const { dispatcher, replyOptions, markDispatchIdle } = createFeishuReplyDispatcher({
        cfg,
        agentId: route.agentId,
        runtime: runtime as RuntimeEnv,
        chatId: ctx.chatId,
        allowReasoningPreview,
        replyToMessageId: replyTargetMessageId,
        skipReplyToInMessages: !isGroup,
        replyInThread,
        rootId: ctx.rootId,
        threadReply,
        mentionTargets: ctx.mentionTargets,
        accountId: account.accountId,
        identity,
        messageCreateTimeMs,
      });

      log(`feishu[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);
      const { queuedFinal, counts } = await core.channel.reply.withReplyDispatcher({
        dispatcher,
        onSettled: () => {
          markDispatchIdle();
        },
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions,
          }),
      });

      if (isGroup && historyKey && chatHistories) {
        clearHistoryEntriesIfEnabled({
          historyMap: chatHistories,
          historyKey,
          limit: historyLimit,
        });
      }

      log(
        `feishu[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
      );
    }
  } catch (err) {
    error(`feishu[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}
