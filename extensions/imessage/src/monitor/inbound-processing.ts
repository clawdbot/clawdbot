import {
  buildMentionRegexes,
  type EnvelopeFormatOptions,
  formatInboundEnvelope,
  formatInboundFromLabel,
  logInboundDrop,
  matchesMentionPatterns,
  resolveEnvelopeFormatOptions,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth-native";
import type { DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveIMessageConversationRoute } from "../conversation-route.js";
import {
  isKnownFromMeIMessageMessageId,
  rememberIMessageReplyCache,
} from "../monitor-reply-cache.js";
import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
  parseIMessageAllowTarget,
} from "../targets.js";
import { detectReflectedContent } from "./reflection-guard.js";
import type { SelfChatCache } from "./self-chat-cache.js";
import type { MonitorIMessageOpts, IMessagePayload } from "./types.js";

type IMessageReactionNotificationMode = "off" | "own" | "all";

type IMessageReplyContext = {
  id?: string;
  body: string;
  sender?: string;
};

type IMessageReactionContext = {
  action: "added" | "removed";
  emoji: string;
  targetGuid?: string;
  targetGuids?: string[];
  targetText?: string;
};

const TAPBACK_TEXT_PATTERNS: Array<{
  prefix: string;
  action: "added" | "removed";
  emoji: string;
}> = [
  { prefix: "loved", action: "added", emoji: "❤️" },
  { prefix: "liked", action: "added", emoji: "👍" },
  { prefix: "disliked", action: "added", emoji: "👎" },
  { prefix: "laughed at", action: "added", emoji: "😂" },
  { prefix: "emphasized", action: "added", emoji: "‼️" },
  { prefix: "questioned", action: "added", emoji: "❓" },
  { prefix: "removed a heart from", action: "removed", emoji: "❤️" },
  { prefix: "removed a like from", action: "removed", emoji: "👍" },
  { prefix: "removed a dislike from", action: "removed", emoji: "👎" },
  { prefix: "removed a laugh from", action: "removed", emoji: "😂" },
  { prefix: "removed an emphasis from", action: "removed", emoji: "‼️" },
  { prefix: "removed a question from", action: "removed", emoji: "❓" },
];

function normalizeReactionValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().replace(/^p:\d+\//iu, "") || undefined
    : undefined;
}

function resolveReactionTargetGuidCandidates(...values: unknown[]): string[] {
  const candidates: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const raw = value.trim();
    if (!raw) {
      continue;
    }
    const normalized = raw.replace(/^p:\d+\//iu, "");
    for (const candidate of [normalized, raw]) {
      if (candidate && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function resolveTapbackTextContext(bodyText: string): IMessageReactionContext | null {
  const lower = bodyText.toLowerCase();
  for (const pattern of TAPBACK_TEXT_PATTERNS) {
    if (!lower.startsWith(pattern.prefix)) {
      continue;
    }
    const afterPrefix = bodyText.slice(pattern.prefix.length).trim();
    if (!/^["\u201c]/u.test(afterPrefix)) {
      continue;
    }
    return {
      action: pattern.action,
      emoji: pattern.emoji,
      targetText: afterPrefix
        .replace(/^["\u201c]/u, "")
        .replace(/["\u201d]$/u, "")
        .trim(),
    };
  }
  return null;
}

export function resolveIMessageReactionContext(
  message: IMessagePayload,
  bodyText: string,
): IMessageReactionContext | null {
  const explicit =
    message.is_reaction === true ||
    message.is_tapback === true ||
    (typeof message.associated_message_type === "number" &&
      Number.isFinite(message.associated_message_type) &&
      message.associated_message_type >= 2000 &&
      message.associated_message_type < 4000);
  if (explicit) {
    const targetGuids = resolveReactionTargetGuidCandidates(
      message.reacted_to_guid,
      message.associated_message_guid,
    );
    return {
      action: message.is_reaction_add === false ? "removed" : "added",
      emoji:
        normalizeReactionValue(message.reaction_emoji) ??
        normalizeReactionValue(message.reaction_type) ??
        "reaction",
      targetGuid: targetGuids[0],
      targetGuids,
    };
  }
  return resolveTapbackTextContext(bodyText);
}

const normalizeNonEmpty = (value: string) => value.trim() || null;

const imessageIngressIdentity = defineStableChannelIngressIdentity({
  key: "imessage-sender",
  normalizeEntry: normalizeIMessageHandleEntry,
  normalizeSubject: normalizeIMessageHandle,
  sensitivity: "pii",
  aliases: (
    [
      ["imessage-chat-id", "plugin:imessage-chat-id", normalizeIMessageChatIdEntry],
      ["imessage-chat-guid", "plugin:imessage-chat-guid", normalizeIMessageChatGuidEntry],
      [
        "imessage-chat-identifier",
        "plugin:imessage-chat-identifier",
        normalizeIMessageChatIdentifierEntry,
      ],
    ] as const
  ).map(([key, kind, normalizeEntry]) => ({
    key,
    kind,
    normalizeEntry,
    normalizeSubject: normalizeNonEmpty,
    sensitivity: "pii",
  })),
  resolveEntryId: ({ entryIndex }) => `imessage-entry-${entryIndex + 1}`,
});

function normalizeIMessageHandleEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "handle" ? normalizeIMessageHandle(parsed.handle) : null;
}

function normalizeIMessageChatIdEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_id" ? String(parsed.chatId) : null;
}

function normalizeIMessageChatGuidEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_guid" ? parsed.chatGuid.trim() || null : null;
}

function normalizeIMessageChatIdentifierEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_identifier" ? parsed.chatIdentifier.trim() || null : null;
}

function normalizeDmPolicy(policy: string): DmPolicy {
  return policy === "open" || policy === "allowlist" || policy === "disabled" ? policy : "pairing";
}

function normalizeGroupPolicy(policy: string): GroupPolicy {
  return policy === "open" || policy === "disabled" ? policy : "allowlist";
}

function normalizeReplyField(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}

function describeReplyContext(message: IMessagePayload): IMessageReplyContext | null {
  const body = normalizeReplyField(message.reply_to_text);
  if (!body) {
    return null;
  }
  const id = normalizeReplyField(message.reply_to_id);
  const sender = normalizeReplyField(message.reply_to_sender);
  return { body, id, sender };
}

function resolveInboundEchoMessageIds(message: IMessagePayload): string[] {
  const values = [
    message.id != null ? String(message.id) : undefined,
    normalizeReplyField(message.guid),
  ];
  const ids: string[] = [];
  for (const value of values) {
    if (!value || ids.includes(value)) {
      continue;
    }
    ids.push(value);
  }
  return ids;
}

function hasIMessageEchoMatch(params: {
  echoCache: {
    has: (
      scope: string,
      lookup: { text?: string; messageId?: string },
      skipIdShortCircuit?: boolean,
    ) => boolean;
  };
  scope: string | readonly string[];
  text?: string;
  messageIds: string[];
  skipIdShortCircuit?: boolean;
}): boolean {
  // Outbound sends persist echo scopes keyed by whichever target shape was
  // used (chat_id, chat_guid, chat_identifier, or imessage:<handle>). Inbound
  // messages from chat.db typically carry chat_id + chat_guid + chat_identifier
  // for groups and just sender for DMs, so the same conversation can be
  // echo-cached under one shape and re-encountered under another. Probe every
  // candidate scope so a chat_guid-keyed send isn't surfaced back to the agent
  // as a fresh inbound when chat.db only annotates it with chat_id (or
  // vice-versa).
  const scopes = typeof params.scope === "string" ? [params.scope] : params.scope;
  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    for (const messageId of params.messageIds) {
      if (params.echoCache.has(scope, { messageId })) {
        return true;
      }
    }
    const fallbackMessageId = params.messageIds[0];
    if (!params.text && !fallbackMessageId) {
      continue;
    }
    if (
      params.echoCache.has(
        scope,
        { text: params.text, messageId: fallbackMessageId },
        params.skipIdShortCircuit,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isKnownFromMeIMessageReactionTarget(params: {
  messageId: string;
  accountId: string;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  isKnownFromMeMessageId?: typeof isKnownFromMeIMessageMessageId;
}): boolean {
  const { messageId, accountId, chatId, chatGuid, chatIdentifier } = params;
  const ctx = {
    accountId,
    chatId,
    chatGuid,
    chatIdentifier,
  };
  if (params.isKnownFromMeMessageId) {
    return params.isKnownFromMeMessageId(messageId, ctx);
  }
  return isKnownFromMeIMessageMessageId(messageId, ctx);
}

/**
 * Per-group `systemPrompt` resolution. Mirrors `resolveWhatsAppGroupSystemPrompt`
 * in `extensions/whatsapp/src/system-prompt.ts`:
 *
 * 1. If the matched per-`chat_id` entry exists AND defines `systemPrompt` (key
 *    is present, value is non-null), use it. Trim whitespace; if the trim
 *    leaves an empty string, return `undefined` and DO NOT fall through to the
 *    wildcard. This is how operators say "this specific group has no prompt"
 *    without inheriting from `groups["*"]`.
 * 2. Otherwise, return the wildcard `groups["*"].systemPrompt` (trimmed; empty
 *    after trim → `undefined`).
 */
export function resolveIMessageGroupSystemPrompt(params: {
  groupConfig: unknown;
  defaultConfig: unknown;
}): string | undefined {
  const specific = params.groupConfig as { systemPrompt?: string | null } | undefined;
  if (specific != null && specific.systemPrompt != null) {
    return specific.systemPrompt.trim() || undefined;
  }
  const wildcard = (params.defaultConfig as { systemPrompt?: string | null } | undefined)
    ?.systemPrompt;
  return wildcard != null ? wildcard.trim() || undefined : undefined;
}

type IMessageInboundDispatchDecision = {
  kind: "dispatch";
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  groupId?: string;
  historyKey?: string;
  sender: string;
  senderNormalized: string;
  route: ReturnType<typeof resolveAgentRoute>;
  bodyText: string;
  createdAt?: number;
  replyContext: IMessageReplyContext | null;
  effectiveWasMentioned: boolean;
  commandAuthorized: boolean;
  // Forwarded as ctxPayload.GroupSystemPrompt for group messages. Resolved
  // from `channels.imessage.groups.<chat_id>.systemPrompt` (or the `"*"`
  // wildcard) at gate time. Always undefined for DMs.
  groupSystemPrompt?: string;
};

type IMessageInboundReactionDecision = {
  kind: "reaction";
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  sender: string;
  senderNormalized: string;
  route: ReturnType<typeof resolveAgentRoute>;
  reaction: IMessageReactionContext;
  text: string;
  contextKey: string;
};

type IMessageInboundDecision =
  | { kind: "drop"; reason: string }
  | { kind: "pairing"; senderId: string }
  | IMessageInboundReactionDecision
  | IMessageInboundDispatchDecision;

export async function resolveIMessageInboundDecision(params: {
  cfg: OpenClawConfig;
  accountId: string;
  message: IMessagePayload;
  opts?: Pick<MonitorIMessageOpts, "requireMention">;
  messageText: string;
  bodyText: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  groupPolicy: string;
  dmPolicy: string;
  storeAllowFrom: string[];
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
  echoCache?: {
    has: (
      scope: string,
      lookup: { text?: string; messageId?: string },
      skipIdShortCircuit?: boolean,
    ) => boolean;
  };
  selfChatCache?: SelfChatCache;
  reactionNotifications?: IMessageReactionNotificationMode;
  isKnownFromMeMessageId?: typeof isKnownFromMeIMessageMessageId;
  logVerbose?: (msg: string) => void;
}): Promise<IMessageInboundDecision> {
  const senderRaw = params.message.sender ?? "";
  const sender = senderRaw.trim();
  if (!sender) {
    return { kind: "drop", reason: "missing sender" };
  }
  const senderNormalized = normalizeIMessageHandle(sender);
  const chatId = params.message.chat_id ?? undefined;
  const chatGuid = params.message.chat_guid ?? undefined;
  const chatIdentifier = params.message.chat_identifier ?? undefined;
  const destinationCallerId = params.message.destination_caller_id ?? undefined;
  const createdAt = params.message.created_at ? Date.parse(params.message.created_at) : undefined;
  const messageText = params.messageText.trim();
  const bodyText = params.bodyText.trim();
  const reactionContext = resolveIMessageReactionContext(params.message, bodyText || messageText);

  const groupIdCandidate = chatId !== undefined ? String(chatId) : undefined;
  const groupListPolicy = groupIdCandidate
    ? resolveChannelGroupPolicy({
        cfg: params.cfg,
        channel: "imessage",
        accountId: params.accountId,
        groupId: groupIdCandidate,
      })
    : {
        allowlistEnabled: false,
        allowed: true,
        groupConfig: undefined,
        defaultConfig: undefined,
      };

  // If the owner explicitly configures a chat_id under imessage.groups, treat that thread as a
  // "group" for permission gating + session isolation, even when is_group=false.
  const treatAsGroupByConfig = Boolean(
    groupIdCandidate && groupListPolicy.allowlistEnabled && groupListPolicy.groupConfig,
  );
  const isGroup = Boolean(params.message.is_group) || treatAsGroupByConfig;
  const selfChatLookup = {
    accountId: params.accountId,
    isGroup,
    chatId,
    sender,
    text: bodyText,
    createdAt,
  };
  const chatIdentifierNormalized = normalizeIMessageHandle(chatIdentifier ?? "") || undefined;
  const destinationCallerIdNormalized =
    normalizeIMessageHandle(destinationCallerId ?? "") || undefined;
  // Require an explicit destination handle that matches the sender. When
  // destination_caller_id is missing, sender === chat_identifier is ambiguous:
  // it is true for some DM SQLite rows as well as true self-chat (#63980).
  const matchesSelfChatDestination =
    destinationCallerIdNormalized != null && destinationCallerIdNormalized === senderNormalized;
  const isSelfChat =
    !isGroup &&
    chatIdentifierNormalized != null &&
    senderNormalized === chatIdentifierNormalized &&
    matchesSelfChatDestination;
  const isAmbiguousSelfThread =
    !isGroup &&
    chatIdentifierNormalized != null &&
    senderNormalized === chatIdentifierNormalized &&
    destinationCallerIdNormalized == null;
  let skipSelfChatHasCheck = false;
  const inboundMessageIds = resolveInboundEchoMessageIds(params.message);
  const inboundMessageId = inboundMessageIds[0];
  const hasInboundGuid = Boolean(normalizeReplyField(params.message.guid));

  if (params.message.is_from_me) {
    if (isAmbiguousSelfThread) {
      params.selfChatCache?.remember(selfChatLookup);
    }
    if (isSelfChat) {
      params.selfChatCache?.remember(selfChatLookup);
      const echoScope = buildIMessageEchoScope({
        accountId: params.accountId,
        isGroup,
        chatId,
        chatGuid,
        chatIdentifier,
        sender,
      });
      if (
        params.echoCache &&
        (bodyText || inboundMessageId) &&
        hasIMessageEchoMatch({
          echoCache: params.echoCache,
          scope: echoScope,
          text: bodyText || undefined,
          messageIds: inboundMessageIds,
          skipIdShortCircuit: !hasInboundGuid,
        })
      ) {
        return { kind: "drop", reason: "agent echo in self-chat" };
      }
      skipSelfChatHasCheck = true;
    } else {
      return { kind: "drop", reason: "from me" };
    }
  }
  if (isGroup && !chatId) {
    return { kind: "drop", reason: "group without chat_id" };
  }

  const groupId = isGroup ? groupIdCandidate : undefined;
  const hasControlCommandInMessage = hasControlCommand(messageText, params.cfg);
  const accessDecision = await createChannelIngressResolver({
    channelId: "imessage",
    accountId: params.accountId,
    identity: imessageIngressIdentity,
    cfg: params.cfg,
    readStoreAllowFrom: async () => params.storeAllowFrom,
  }).message({
    subject: {
      stableId: sender,
      aliases: {
        ...(chatId != null ? { "imessage-chat-id": String(chatId) } : {}),
        ...(chatGuid ? { "imessage-chat-guid": chatGuid } : {}),
        ...(chatIdentifier ? { "imessage-chat-identifier": chatIdentifier } : {}),
      },
    },
    conversation: {
      kind: isGroup ? "group" : "direct",
      id: isGroup
        ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
        : normalizeIMessageHandle(sender),
    },
    dmPolicy: normalizeDmPolicy(params.dmPolicy),
    groupPolicy: normalizeGroupPolicy(params.groupPolicy),
    policy: { groupAllowFromFallbackToAllowFrom: false },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    command: {
      allowTextCommands: isGroup,
      hasControlCommand: hasControlCommandInMessage,
      directGroupAllowFrom: "effective",
    },
  });
  const { commandAccess, senderAccess } = accessDecision;
  const effectiveGroupAllowFrom = senderAccess.effectiveGroupAllowFrom;

  if (senderAccess.decision !== "allow") {
    if (isGroup) {
      if (senderAccess.reasonCode === "group_policy_disabled") {
        params.logVerbose?.("Blocked iMessage group message (groupPolicy: disabled)");
        return { kind: "drop", reason: "groupPolicy disabled" };
      }
      if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
        params.logVerbose?.(
          "Blocked iMessage group message (groupPolicy: allowlist, no groupAllowFrom)",
        );
        return { kind: "drop", reason: "groupPolicy allowlist (empty groupAllowFrom)" };
      }
      if (senderAccess.reasonCode === "group_policy_not_allowlisted") {
        params.logVerbose?.(`Blocked iMessage sender ${sender} (not in groupAllowFrom)`);
        return { kind: "drop", reason: "not in groupAllowFrom" };
      }
      params.logVerbose?.(`Blocked iMessage group message (${senderAccess.reasonCode})`);
      return { kind: "drop", reason: senderAccess.reasonCode };
    }
    if (senderAccess.reasonCode === "dm_policy_disabled") {
      return { kind: "drop", reason: "dmPolicy disabled" };
    }
    if (senderAccess.decision === "pairing") {
      return { kind: "pairing", senderId: senderNormalized };
    }
    params.logVerbose?.(`Blocked iMessage sender ${sender} (dmPolicy=${params.dmPolicy})`);
    return { kind: "drop", reason: "dmPolicy blocked" };
  }

  if (isGroup && groupListPolicy.allowlistEnabled && !groupListPolicy.allowed) {
    params.logVerbose?.(
      `imessage: skipping group message (${groupId ?? "unknown"}) not in allowlist`,
    );
    return { kind: "drop", reason: "group id not in allowlist" };
  }

  const route = resolveIMessageConversationRoute({
    cfg: params.cfg,
    accountId: params.accountId,
    isGroup,
    peerId: isGroup ? String(chatId ?? "unknown") : senderNormalized,
    sender,
    chatId,
  });
  if (reactionContext) {
    const notificationMode = params.reactionNotifications ?? "own";
    if (notificationMode === "off") {
      return { kind: "drop", reason: "reaction notifications disabled" };
    }
    const targetGuid = reactionContext.targetGuid;
    const targetGuids = reactionContext.targetGuids ?? (targetGuid ? [targetGuid] : []);
    const targetIsOwn = Boolean(
      targetGuid &&
      ((params.echoCache &&
        hasIMessageEchoMatch({
          echoCache: params.echoCache,
          scope: buildIMessageEchoScope({
            accountId: params.accountId,
            isGroup,
            chatId,
            chatGuid,
            chatIdentifier,
            sender,
          }),
          messageIds: targetGuids,
        })) ||
        targetGuids.some((messageId) =>
          isKnownFromMeIMessageReactionTarget({
            messageId,
            accountId: params.accountId,
            chatId,
            chatGuid,
            chatIdentifier,
            isKnownFromMeMessageId: params.isKnownFromMeMessageId,
          }),
        )),
    );
    if (notificationMode === "own" && !targetIsOwn) {
      return { kind: "drop", reason: "reaction target not sent by agent" };
    }
    const target = targetGuid
      ? `msg ${targetGuid}`
      : reactionContext.targetText
        ? `message "${truncateUtf16Safe(reactionContext.targetText, 80)}"`
        : "a message";
    const text = `iMessage reaction ${reactionContext.action}: ${reactionContext.emoji} by ${senderNormalized} on ${target}`;
    const reactionKey = [
      "imessage",
      "reaction",
      reactionContext.action,
      chatId ?? chatGuid ?? chatIdentifier ?? senderNormalized,
      targetGuid ?? reactionContext.targetText ?? "unknown",
      senderNormalized,
      reactionContext.emoji,
    ].join(":");
    return {
      kind: "reaction",
      isGroup,
      chatId,
      chatGuid,
      chatIdentifier,
      sender,
      senderNormalized,
      route,
      reaction: reactionContext,
      text,
      contextKey: reactionKey,
    };
  }
  const mentionRegexes = buildMentionRegexes(params.cfg, route.agentId);
  if (!bodyText) {
    return { kind: "drop", reason: "empty body" };
  }

  const selfChatHit = skipSelfChatHasCheck
    ? false
    : params.selfChatCache?.has({
        ...selfChatLookup,
        text: bodyText,
      });
  if (selfChatHit) {
    const preview = sanitizeTerminalText(truncateUtf16Safe(bodyText, 50));
    params.logVerbose?.(`imessage: dropping self-chat reflected duplicate: "${preview}"`);
    return { kind: "drop", reason: "self-chat echo" };
  }

  // Echo detection: check if the received message matches a recently sent message.
  // Scope by conversation so same text in different chats is not conflated.
  if (params.echoCache && (messageText || inboundMessageId)) {
    const echoScope = buildIMessageEchoScope({
      accountId: params.accountId,
      isGroup,
      chatId,
      chatGuid,
      chatIdentifier,
      sender,
    });
    if (
      hasIMessageEchoMatch({
        echoCache: params.echoCache,
        scope: echoScope,
        text: bodyText || undefined,
        messageIds: inboundMessageIds,
      })
    ) {
      params.logVerbose?.(
        describeIMessageEchoDropLog({ messageText: bodyText, messageId: inboundMessageId }),
      );
      return { kind: "drop", reason: "echo" };
    }
  }

  // Reflection guard: drop inbound messages that contain assistant-internal
  // metadata markers. These indicate outbound content was reflected back as
  // inbound, which causes recursive echo amplification.
  const reflection = detectReflectedContent(messageText);
  if (reflection.isReflection) {
    params.logVerbose?.(
      `imessage: dropping reflected assistant content (markers: ${reflection.matchedLabels.join(", ")})`,
    );
    return { kind: "drop", reason: "reflected assistant content" };
  }

  const replyContext = describeReplyContext(params.message);
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
  });
  const replySenderAllowed =
    !isGroup || effectiveGroupAllowFrom.length === 0
      ? true
      : replyContext?.sender
        ? isAllowedIMessageSender({
            allowFrom: effectiveGroupAllowFrom,
            sender: replyContext.sender,
            chatId,
            chatGuid,
            chatIdentifier,
          })
        : false;
  const filteredReplyContext =
    !replyContext ||
    evaluateSupplementalContextVisibility({
      mode: contextVisibilityMode,
      kind: "quote",
      senderAllowed: replySenderAllowed,
    }).include
      ? replyContext
      : null;
  if (replyContext && !filteredReplyContext && isGroup) {
    params.logVerbose?.(
      `imessage: drop reply context (mode=${contextVisibilityMode}, sender_allowed=${replySenderAllowed ? "yes" : "no"})`,
    );
  }
  const historyKey = isGroup
    ? String(chatId ?? chatGuid ?? chatIdentifier ?? "unknown")
    : undefined;

  const mentioned = isGroup ? matchesMentionPatterns(messageText, mentionRegexes) : true;
  const requireMention = resolveChannelGroupRequireMention({
    cfg: params.cfg,
    channel: "imessage",
    accountId: params.accountId,
    groupId,
    requireMentionOverride: params.opts?.requireMention,
    overrideOrder: "before-config",
  });
  const canDetectMention = mentionRegexes.length > 0;

  const commandAuthorized = commandAccess.authorized;
  if (commandAccess.shouldBlockControlCommand) {
    if (params.logVerbose) {
      logInboundDrop({
        log: params.logVerbose,
        channel: "imessage",
        reason: "control command (unauthorized)",
        target: sender,
      });
    }
    return { kind: "drop", reason: "control command (unauthorized)" };
  }

  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned: mentioned,
      hasAnyMention: false,
      implicitMentionKinds: [],
    },
    policy: {
      isGroup,
      requireMention,
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
    params.logVerbose?.(`imessage: skipping group message (no mention)`);
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.groupHistories,
      historyKey: historyKey ?? "",
      limit: params.historyLimit,
      entry: historyKey
        ? {
            sender: senderNormalized,
            body: bodyText,
            timestamp: createdAt,
            messageId: params.message.id ? String(params.message.id) : undefined,
          }
        : null,
    });
    return { kind: "drop", reason: "no mention" };
  }

  // Per-chat_id `systemPrompt` wins; fall back to the `groups["*"]` wildcard
  // ONLY when the matched group does not define the key at all. If the matched
  // group sets `systemPrompt: ""` the wildcard is suppressed (no prompt is
  // applied to that specific group). Mirrors the resolution semantic in
  // `extensions/whatsapp/src/system-prompt.ts`.
  const groupSystemPrompt = isGroup
    ? resolveIMessageGroupSystemPrompt({
        groupConfig: groupListPolicy.groupConfig,
        defaultConfig: groupListPolicy.defaultConfig,
      })
    : undefined;

  return {
    kind: "dispatch",
    isGroup,
    chatId,
    chatGuid,
    chatIdentifier,
    groupId,
    historyKey,
    sender,
    senderNormalized,
    route,
    bodyText,
    createdAt,
    replyContext: filteredReplyContext,
    effectiveWasMentioned,
    commandAuthorized,
    groupSystemPrompt,
  };
}

export function buildIMessageInboundContext(params: {
  cfg: OpenClawConfig;
  decision: IMessageInboundDispatchDecision;
  message: IMessagePayload;
  envelopeOptions?: EnvelopeFormatOptions;
  previousTimestamp?: number;
  remoteHost?: string;
  media?: {
    path?: string;
    type?: string;
    paths?: string[];
    types?: Array<string | undefined>;
  };
  historyLimit: number;
  groupHistories: Map<string, HistoryEntry[]>;
}): {
  ctxPayload: ReturnType<typeof finalizeInboundContext>;
  fromLabel: string;
  chatTarget?: string;
  imessageTo: string;
  inboundHistory?: Array<{ sender: string; body: string; timestamp?: number }>;
} {
  const envelopeOptions = params.envelopeOptions ?? resolveEnvelopeFormatOptions(params.cfg);
  const { decision } = params;
  const chatId = decision.chatId;
  const chatTarget =
    decision.isGroup && chatId != null ? formatIMessageChatTarget(chatId) : undefined;
  const messageGuid = normalizeReplyField(params.message.guid);
  const rememberedMessage = messageGuid
    ? rememberIMessageReplyCache({
        accountId: decision.route.accountId,
        messageId: messageGuid,
        chatGuid: decision.chatGuid,
        chatIdentifier: decision.chatIdentifier,
        chatId: decision.chatId,
        timestamp: Date.now(),
        isFromMe: false,
      })
    : null;
  // Only surface the gateway-allocated shortId — never the raw chat.db
  // ROWID. Mixing the two namespaces means the agent can call back with a
  // numeric id that the gateway will treat as a shortId but never issued
  // (e.g. chat.db rowid 13 with shortIds only allocated 1..10), and the
  // resolver throws "no longer available". When we have no guid we have
  // no stable handle to expose, so drop the field rather than leak rowids.
  const messageSid = rememberedMessage?.shortId || undefined;

  const replySuffix = decision.replyContext
    ? `\n\n[Replying to ${decision.replyContext.sender ?? "unknown sender"}${
        decision.replyContext.id ? ` id:${decision.replyContext.id}` : ""
      }]\n${decision.replyContext.body}\n[/Replying]`
    : "";

  const fromLabel = formatInboundFromLabel({
    isGroup: decision.isGroup,
    groupLabel: params.message.chat_name ?? undefined,
    groupId: chatId !== undefined ? String(chatId) : "unknown",
    groupFallback: "Group",
    directLabel: decision.senderNormalized,
    directId: decision.sender,
  });

  const body = formatInboundEnvelope({
    channel: "iMessage",
    from: fromLabel,
    timestamp: decision.createdAt,
    body: `${decision.bodyText}${replySuffix}`,
    chatType: decision.isGroup ? "group" : "direct",
    sender: { name: decision.senderNormalized, id: decision.sender },
    previousTimestamp: params.previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  if (decision.isGroup && decision.historyKey) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: params.groupHistories,
      historyKey: decision.historyKey,
      limit: params.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "iMessage",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId}]` : ""}`,
          chatType: "group",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const imessageTo = (decision.isGroup ? chatTarget : undefined) || `imessage:${decision.sender}`;
  const inboundHistory =
    decision.isGroup && decision.historyKey && params.historyLimit > 0
      ? (params.groupHistories.get(decision.historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: decision.bodyText,
    InboundHistory: inboundHistory,
    RawBody: decision.bodyText,
    CommandBody: decision.bodyText,
    From: decision.isGroup
      ? `imessage:group:${chatId ?? "unknown"}`
      : `imessage:${decision.sender}`,
    To: imessageTo,
    SessionKey: decision.route.sessionKey,
    AccountId: decision.route.accountId,
    ChatType: decision.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    GroupSubject: decision.isGroup ? (params.message.chat_name ?? undefined) : undefined,
    GroupSystemPrompt: decision.isGroup ? decision.groupSystemPrompt : undefined,
    GroupMembers: decision.isGroup
      ? (params.message.participants ?? []).filter(Boolean).join(", ")
      : undefined,
    SenderName: decision.senderNormalized,
    SenderId: decision.sender,
    Provider: "imessage",
    Surface: "imessage",
    MessageSid: messageSid,
    MessageSidFull: messageGuid,
    ReplyToId: decision.replyContext?.id,
    ReplyToBody: decision.replyContext?.body,
    ReplyToSender: decision.replyContext?.sender,
    Timestamp: decision.createdAt,
    MediaPath: params.media?.path,
    MediaType: params.media?.type,
    MediaUrl: params.media?.path,
    MediaPaths:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MediaTypes:
      params.media?.types && params.media.types.length > 0 ? params.media.types : undefined,
    MediaUrls:
      params.media?.paths && params.media.paths.length > 0 ? params.media.paths : undefined,
    MediaRemoteHost: params.remoteHost,
    WasMentioned: decision.effectiveWasMentioned,
    CommandAuthorized: decision.commandAuthorized,
    OriginatingChannel: "imessage" as const,
    OriginatingTo: imessageTo,
  });

  return { ctxPayload, fromLabel, chatTarget, imessageTo, inboundHistory };
}

function buildIMessageEchoScope(params: {
  accountId: string;
  isGroup: boolean;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  sender: string;
}): string[] {
  // Mirror every shape resolveOutboundEchoScope can persist (see send.ts).
  // Inbound messages carry chat_id, chat_guid, and chat_identifier when
  // available, but the outbound side only writes one of them — whichever
  // shape the caller used. Returning all candidates lets hasIMessageEchoMatch
  // cross-check, so a chat_guid-keyed send is suppressed even when chat.db
  // annotates the inbound row with chat_id+chat_identifier (or any other
  // permutation).
  const scopes: string[] = [];
  if (params.isGroup) {
    const chatIdScope = formatIMessageChatTarget(params.chatId);
    if (chatIdScope) {
      scopes.push(`${params.accountId}:${chatIdScope}`);
    }
  } else {
    scopes.push(`${params.accountId}:imessage:${params.sender}`);
  }
  if (params.chatGuid) {
    scopes.push(`${params.accountId}:chat_guid:${params.chatGuid}`);
  }
  if (params.chatIdentifier) {
    scopes.push(`${params.accountId}:chat_identifier:${params.chatIdentifier}`);
  }
  return scopes;
}

export function describeIMessageEchoDropLog(params: {
  messageText: string;
  messageId?: string;
}): string {
  const preview = truncateUtf16Safe(params.messageText, 50);
  const messageIdPart = params.messageId ? ` id=${params.messageId}` : "";
  return `imessage: skipping echo message${messageIdPart}: "${preview}"`;
}
