// Feishu plugin module implements channel behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-resolution";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createActionGate, ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import {
  adaptScopedAccountAccessor,
  createHybridChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  defineChannelMessageAdapter,
  createRuntimeOutboundDelegates,
  createAccountStatusSink,
  type ChannelMessageSendResult,
  type MessageReceiptPartKind,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { resolveLegacyInteractiveTextFallback } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  buildProbeChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import type {
  ChannelMessageActionName,
  ChannelMeta,
  ChannelPlugin,
  ClawdbotConfig,
  PluginRuntime,
} from "../runtime-api.js";
import {
  inspectFeishuCredentials,
  listEnabledFeishuAccounts,
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { feishuApprovalAuth } from "./approval-auth.js";
import { FEISHU_CARD_INTERACTION_VERSION } from "./card-interaction.js";
import { normalizeFeishuChatType, resolveFeishuChatType } from "./chat-type.js";
import { FeishuChannelConfigSchema } from "./config-schema.js";
import {
  buildFeishuConversationId,
  buildFeishuModelOverrideParentCandidates,
  parseFeishuConversationId,
  parseFeishuDirectConversationId,
  parseFeishuTargetId,
} from "./conversation-id.js";
import {
  listAuthorizedFeishuDirectoryGroups,
  listAuthorizedFeishuDirectoryPeers,
  listFeishuDirectoryGroups,
  listFeishuDirectoryPeers,
} from "./directory.static.js";
import { feishuDoctor } from "./doctor.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { chunkFeishuMarkdown } from "./markdown.js";
import { messageActionTargetAliases } from "./message-action-contract.js";
import { readNativeFeishuCardJson } from "./native-card.js";
import {
  FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER,
  resolveFeishuReplyMode,
  type FeishuOutboundSendMedia,
} from "./outbound.js";
import { resolveFeishuGroupToolPolicy } from "./policy.js";
import {
  assertFeishuCardWithinEnvelope,
  buildFeishuPresentationCard,
  isFeishuCardWithinEnvelope,
  resolveFeishuRichReply,
} from "./presentation-card.js";
import {
  assertFeishuChatReadAllowed,
  authorizeFeishuChatMemberRead,
  canEnumerateAllFeishuGroups,
  canEnumerateAllFeishuPeers,
  isFeishuGroupReadAllowed,
  isFeishuGroupReadEnabled,
  resolveFeishuChatReadPreliminaryAuthorization,
} from "./read-policy.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { collectFeishuSecurityAuditFindings } from "./security-audit.js";
import { createFeishuSendReceipt } from "./send-result.js";
import { resolveFeishuSessionConversation } from "./session-conversation.js";
import { resolveFeishuOutboundSessionRoute } from "./session-route.js";
import { feishuSetupContract } from "./setup-core.js";
import { feishuSetupWizard, runFeishuLogin } from "./setup-surface.js";
import { resolveFeishuStickerSet, searchFeishuStickerSet } from "./sticker-catalog.js";
import { looksLikeFeishuId, normalizeFeishuTarget, resolveReceiveIdType } from "./targets.js";
import type { FeishuConfig, FeishuProbeResult, ResolvedFeishuAccount } from "./types.js";

function resolveFeishuSendAttachmentMedia(params: Record<string, unknown>): string | undefined {
  const sourceKeys = ["media", "mediaUrl", "path", "filePath", "fileUrl", "image"];
  const candidates: string[] = [];
  let unsupportedPayload = false;
  let unsupportedFile = false;
  let malformed = false;

  const read = (record: Record<string, unknown>, key: string): unknown => {
    if (Object.hasOwn(record, key)) {
      return record[key];
    }
    const snakeKey = key
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    return snakeKey !== key && Object.hasOwn(record, snakeKey) ? record[snakeKey] : undefined;
  };

  const inspect = (record: Record<string, unknown>, nested = false): void => {
    const keys = nested ? [...sourceKeys.slice(0, -1), "url", "image"] : sourceKeys;
    for (const key of keys) {
      const value = read(record, key);
      if (value === undefined) {
        continue;
      }
      if (typeof value !== "string") {
        malformed = true;
        continue;
      }
      const normalized = normalizeOptionalString(value);
      if (normalized) {
        candidates.push(normalized);
      }
    }

    const multiple = read(record, "mediaUrls");
    if (multiple !== undefined) {
      for (const value of Array.isArray(multiple) ? multiple : [multiple]) {
        if (typeof value !== "string") {
          malformed = true;
          continue;
        }
        const normalized = normalizeOptionalString(value);
        if (normalized) {
          candidates.push(normalized);
        }
      }
    }

    for (const key of ["buffer", "base64"]) {
      const value = read(record, key);
      unsupportedPayload ||=
        value !== undefined &&
        (typeof value !== "string" || Boolean(normalizeOptionalString(value)));
    }
    const file = read(record, "file");
    unsupportedFile ||=
      file !== undefined && (typeof file !== "string" || Boolean(normalizeOptionalString(file)));
  };

  inspect(params);
  const attachments = params.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    malformed = true;
  } else if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!isRecord(attachment)) {
        malformed = true;
      } else {
        inspect(attachment, true);
      }
    }
  }

  if (unsupportedPayload) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.",
    );
  }
  if (malformed) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; a present malformed media source value is not supported — use a string path/URL (or a string array for mediaUrls) instead.",
    );
  }
  if (unsupportedFile) {
    throw new Error(
      "Feishu send supports media attachments through media, mediaUrl, path, filePath, fileUrl, image, mediaUrls, or attachments[] with one of those fields; the `file` attachment-intent parameter is not supported — use one of the supported media sources instead.",
    );
  }
  const urls = [...new Set(candidates)];
  if (urls.length > 1) {
    throw new Error("Feishu send supports a single media attachment.");
  }
  return urls[0];
}

function readBooleanParam(params: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function hasLegacyFeishuCardCommandValue(actionValue: unknown): boolean {
  return (
    isRecord(actionValue) &&
    actionValue.oc !== FEISHU_CARD_INTERACTION_VERSION &&
    (Boolean(typeof actionValue.command === "string" && actionValue.command.trim()) ||
      Boolean(typeof actionValue.text === "string" && actionValue.text.trim()))
  );
}

function containsLegacyFeishuCardCommandValue(node: unknown): boolean {
  if (Array.isArray(node)) {
    return node.some((item) => containsLegacyFeishuCardCommandValue(item));
  }
  if (!isRecord(node)) {
    return false;
  }

  if (node.tag === "button" && hasLegacyFeishuCardCommandValue(node.value)) {
    return true;
  }
  if (
    node.tag === "button" &&
    Array.isArray(node.behaviors) &&
    node.behaviors.some(
      (behavior) => isRecord(behavior) && hasLegacyFeishuCardCommandValue(behavior.value),
    )
  ) {
    return true;
  }

  return Object.values(node).some((value) => containsLegacyFeishuCardCommandValue(value));
}

const meta: ChannelMeta = {
  id: "feishu",
  label: "Feishu",
  selectionLabel: "Feishu/Lark (飞书)",
  docsPath: "/channels/feishu",
  docsLabel: "feishu",
  blurb: "飞书/Lark enterprise messaging.",
  aliases: ["lark"],
  order: 70,
  preferSessionLookupForAnnounceTarget: true,
};

const loadFeishuChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "feishuChannelRuntime",
);

async function resolveFeishuMessageSender<TSender>(params: {
  resolve: (
    runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>,
  ) => TSender | null | undefined;
  unavailableMessage: string;
}): Promise<TSender> {
  try {
    const sender = params.resolve(await loadFeishuChannelRuntime());
    if (sender) {
      return sender;
    }
    throw new Error(params.unavailableMessage);
  } catch (error) {
    if (error instanceof PlatformMessageNotDispatchedError) {
      throw error;
    }
    throw new PlatformMessageNotDispatchedError(params.unavailableMessage, { cause: error });
  }
}

const resolveFeishuTextSender = () =>
  resolveFeishuMessageSender({
    resolve: (runtime) => runtime.feishuOutbound.sendText,
    unavailableMessage: "Feishu text sending is not available.",
  });

const resolveFeishuMediaSender = () =>
  resolveFeishuMessageSender({
    resolve: (runtime) => runtime.feishuOutbound.sendMedia,
    unavailableMessage: "Feishu media sending is not available.",
  });

function toFeishuMessageSendResult(
  result: { messageId?: string; chatId?: string; receipt?: ChannelMessageSendResult["receipt"] },
  kind: MessageReceiptPartKind,
): ChannelMessageSendResult {
  const receipt =
    result.receipt ??
    createFeishuSendReceipt({
      messageId: result.messageId,
      chatId: result.chatId ?? "",
      kind,
    });
  return {
    messageId: result.messageId || receipt.primaryPlatformMessageId,
    receipt,
  };
}

const feishuMessageAdapter = defineChannelMessageAdapter({
  id: "feishu",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
    },
  },
  send: {
    lifecycle: {
      // Resolve process-stable runtime methods before core records platform-send start.
      // Provider invocation stays below so a lost provider result remains ambiguous.
      beforeSendAttempt: async (ctx) => {
        if (ctx.kind === "text") {
          await resolveFeishuTextSender();
        } else if (ctx.kind === "media") {
          await resolveFeishuMediaSender();
        }
      },
    },
    text: async (ctx) => {
      const sendText = await resolveFeishuTextSender();
      const { onDeliveryResult, ...outboundCtx } = ctx;
      const result = await sendText({
        ...outboundCtx,
        ...(onDeliveryResult
          ? {
              onDeliveryResult: async (progress) => {
                await onDeliveryResult(toFeishuMessageSendResult(progress, "text"));
              },
            }
          : {}),
      });
      return toFeishuMessageSendResult(result, "text");
    },
    media: async (ctx) => {
      const sendMedia = await resolveFeishuMediaSender();
      const { onDeliveryResult, ...outboundCtx } = ctx;
      const result = await sendMedia({
        ...outboundCtx,
        ...(onDeliveryResult
          ? {
              onDeliveryResult: async (progress) => {
                await onDeliveryResult(toFeishuMessageSendResult(progress, "media"));
              },
            }
          : {}),
      });
      return toFeishuMessageSendResult(result, "media");
    },
  },
});

async function createFeishuActionClient(account: ResolvedFeishuAccount) {
  const { createFeishuClient } = await import("./client.js");
  return createFeishuClient(account);
}

async function resolveFeishuChatTypeById(params: {
  account: ResolvedFeishuAccount;
  chatId: string;
  runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>;
}) {
  const client = await createFeishuActionClient(params.account);
  const chat = await params.runtime.getChatInfo(client, params.chatId);
  return resolveFeishuChatType(chat);
}

async function resolveFeishuMessageChatType(params: {
  account: ResolvedFeishuAccount;
  message: { chatId: string; chatType?: unknown };
  runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>;
}) {
  const knownChatType = normalizeFeishuChatType(params.message.chatType);
  if (knownChatType) {
    return knownChatType;
  }
  return resolveFeishuChatTypeById({
    account: params.account,
    chatId: params.message.chatId,
    runtime: params.runtime,
  });
}

const collectFeishuSecurityWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
  cfg: ClawdbotConfig;
  accountId?: string | null;
}>({
  providerConfigPresent: (cfg) => cfg.channels?.feishu !== undefined,
  resolveGroupPolicy: ({ cfg, accountId }) =>
    resolveFeishuAccount({ cfg, accountId }).config?.groupPolicy,
  collect: ({ cfg, accountId, groupPolicy }) => {
    if (groupPolicy !== "open") {
      return [];
    }
    const account = resolveFeishuAccount({ cfg, accountId });
    return [
      `- Feishu[${account.accountId}] groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu.groupPolicy="allowlist" + channels.feishu.groupAllowFrom to restrict senders.`,
    ];
  },
});
const collectFeishuOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectFeishuSecurityWarnings,
  checkId: "channels.feishu.groups.open",
  severity: "critical",
  title: "Feishu security warning",
});

function describeFeishuMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabledAccounts = accountId
    ? [resolveFeishuAccount({ cfg, accountId })].filter(
        (account) => account.enabled && account.configured,
      )
    : listEnabledFeishuAccounts(cfg);
  const enabled =
    enabledAccounts.length > 0 ||
    (!accountId &&
      cfg.channels?.feishu?.enabled !== false &&
      Boolean(inspectFeishuCredentials(cfg.channels?.feishu as FeishuConfig | undefined, cfg)));
  if (enabledAccounts.length === 0) {
    return {
      actions: [],
      capabilities: enabled ? ["presentation"] : [],
    };
  }
  const actions = new Set<ChannelMessageActionName>([
    "send",
    "read",
    "edit",
    "thread-reply",
    "pin",
    "list-pins",
    "unpin",
    "member-info",
    "channel-info",
    "channel-list",
  ]);
  if (enabledAccounts.some((account) => isFeishuActionEnabled(account, "reactions"))) {
    actions.add("react");
    actions.add("reactions");
  }
  if (enabledAccounts.some((account) => isFeishuActionEnabled(account, "sticker"))) {
    actions.add("sticker");
  }
  const selectedAccount = resolveFeishuAccount({ cfg, accountId });
  if (
    isFeishuActionEnabled(selectedAccount, "sticker") &&
    resolveFeishuStickerSet(cfg, selectedAccount).length > 0
  ) {
    actions.add("sticker-search");
  }
  return {
    actions: Array.from(actions),
    capabilities: enabled ? ["presentation"] : [],
  };
}

const feishuConfigAdapter = createHybridChannelConfigAdapter<
  ResolvedFeishuAccount,
  ResolvedFeishuAccount
>({
  sectionKey: "feishu",
  listAccountIds: listFeishuAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveFeishuAccount),
  defaultAccountId: resolveDefaultFeishuAccountId,
  clearBaseFields: [],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
});

function isFeishuActionEnabled(
  account: ResolvedFeishuAccount,
  action: "reactions" | "sticker",
): boolean {
  if (!account.enabled || !account.configured) {
    return false;
  }
  return createActionGate(account.config.actions)(action, action === "reactions");
}

function isFeishuGroupTopicSessionKey(sessionKey: string | null | undefined): boolean {
  if (typeof sessionKey !== "string" || !sessionKey) {
    return false;
  }
  const parsed = parseFeishuConversationId({ conversationId: sessionKey });
  return parsed?.scope === "group_topic" || parsed?.scope === "group_topic_sender";
}

type FeishuActionReplyAnchor = {
  replyToMessageId: string | undefined;
  replyInThread: boolean;
};

type FeishuSendActionContext = Pick<
  ChannelMessageActionContext,
  "action" | "params" | "sessionKey" | "toolContext" | "requesterAccountId" | "reply"
>;

function resolveFeishuTopicAutoThreadAnchor(
  ctx: FeishuSendActionContext,
  accountId: string,
): string | undefined {
  const currentTarget =
    ctx.toolContext?.currentMessagingTarget ?? ctx.toolContext?.currentChannelId;
  const target = resolveFeishuActionTarget(ctx);
  // A reply API addresses only the message ID: inheriting it across targets
  // would send into the source topic while reporting the requested destination.
  if (
    !isFeishuGroupTopicSessionKey(ctx.sessionKey) ||
    ctx.params.topLevel === true ||
    ctx.params.threadId === null ||
    (ctx.requesterAccountId && ctx.requesterAccountId !== accountId) ||
    (ctx.toolContext?.currentChannelProvider &&
      ctx.toolContext.currentChannelProvider !== "feishu") ||
    !currentTarget ||
    !target ||
    normalizeFeishuTarget(currentTarget) !== normalizeFeishuTarget(target)
  ) {
    return undefined;
  }
  const inbound = ctx.toolContext?.currentMessageId;
  return typeof inbound === "string" && inbound.length > 0 ? inbound : undefined;
}

function buildFeishuSendReplyAnchor(
  ctx: FeishuSendActionContext,
  accountId: string,
): FeishuActionReplyAnchor {
  if (ctx.action === "thread-reply") {
    return {
      replyToMessageId: resolveFeishuMessageId(ctx.params),
      replyInThread: true,
    };
  }
  const threadId =
    readFirstString(ctx.params, ["threadId"]) ?? resolveFeishuTopicAutoThreadAnchor(ctx, accountId);
  // Core also writes implicit reply IDs into params; they must not override
  // native topic delivery. Only an explicit reply can choose normal reply mode.
  const replyToId = ctx.reply
    ? ctx.reply.source === "implicit" && threadId
      ? undefined
      : ctx.reply.replyToId
    : readFirstString(ctx.params, ["replyTo", "reply_to"]);
  return resolveFeishuReplyMode({ replyToId, threadId });
}

function isSupportedFeishuDirectConversationId(conversationId: string): boolean {
  const trimmed = conversationId.trim();
  if (!trimmed || trimmed.includes(":")) {
    return false;
  }
  if (trimmed.startsWith("oc_") || trimmed.startsWith("on_")) {
    return false;
  }
  return true;
}

function normalizeFeishuAcpConversationId(conversationId: string) {
  const parsed = parseFeishuConversationId({ conversationId });
  if (
    !parsed ||
    (parsed.scope !== "group_topic" &&
      parsed.scope !== "group_topic_sender" &&
      !isSupportedFeishuDirectConversationId(parsed.canonicalConversationId))
  ) {
    return null;
  }
  return {
    conversationId: parsed.canonicalConversationId,
    parentConversationId:
      parsed.scope === "group_topic" || parsed.scope === "group_topic_sender"
        ? parsed.chatId
        : undefined,
  };
}

function matchFeishuAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeFeishuAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  const incoming = parseFeishuConversationId({
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (
    !incoming ||
    (incoming.scope !== "group_topic" &&
      incoming.scope !== "group_topic_sender" &&
      !isSupportedFeishuDirectConversationId(incoming.canonicalConversationId))
  ) {
    return null;
  }
  const matchesCanonicalConversation = binding.conversationId === incoming.canonicalConversationId;
  const matchesParentTopicForSenderScopedConversation =
    incoming.scope === "group_topic_sender" &&
    binding.parentConversationId === incoming.chatId &&
    binding.conversationId === `${incoming.chatId}:topic:${incoming.topicId}`;
  if (!matchesCanonicalConversation && !matchesParentTopicForSenderScopedConversation) {
    return null;
  }
  return {
    conversationId: matchesParentTopicForSenderScopedConversation
      ? binding.conversationId
      : incoming.canonicalConversationId,
    parentConversationId:
      incoming.scope === "group_topic" || incoming.scope === "group_topic_sender"
        ? incoming.chatId
        : undefined,
    matchPriority: matchesCanonicalConversation ? 2 : 1,
  };
}

function resolveFeishuSenderScopedCommandConversation(params: {
  accountId: string;
  parentConversationId?: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
}): string | undefined {
  const parentConversationId = params.parentConversationId?.trim();
  const threadId = params.threadId?.trim();
  const senderId = params.senderId?.trim();
  if (!parentConversationId || !threadId || !senderId) {
    return undefined;
  }
  const expectedScopePrefix = `feishu:group:${normalizeLowercaseStringOrEmpty(parentConversationId)}:topic:${normalizeLowercaseStringOrEmpty(threadId)}:sender:`;
  const isSenderScopedSession = [params.sessionKey, params.parentSessionKey].some((candidate) => {
    const normalized = normalizeLowercaseStringOrEmpty(candidate ?? "");
    if (!normalized) {
      return false;
    }
    const scopedRest = normalized.replace(/^agent:[^:]+:/, "");
    return scopedRest.startsWith(expectedScopePrefix);
  });
  const senderScopedConversationId = buildFeishuConversationId({
    chatId: parentConversationId,
    scope: "group_topic_sender",
    topicId: threadId,
    senderOpenId: senderId,
  });
  if (isSenderScopedSession) {
    return senderScopedConversationId;
  }
  if (!params.sessionKey?.trim()) {
    return undefined;
  }
  const boundConversation = getSessionBindingService()
    .listBySession(params.sessionKey)
    .find((binding) => {
      if (
        binding.conversation.channel !== "feishu" ||
        binding.conversation.accountId !== params.accountId
      ) {
        return false;
      }
      return binding.conversation.conversationId === senderScopedConversationId;
    });
  return boundConversation?.conversation.conversationId;
}

function resolveFeishuCommandConversation(params: {
  accountId: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  if (params.threadId) {
    const parentConversationId =
      parseFeishuTargetId(params.originatingTo) ??
      parseFeishuTargetId(params.commandTo) ??
      parseFeishuTargetId(params.fallbackTo);
    if (!parentConversationId) {
      return null;
    }
    const senderScopedConversationId = resolveFeishuSenderScopedCommandConversation({
      accountId: params.accountId,
      parentConversationId,
      threadId: params.threadId,
      senderId: params.senderId,
      sessionKey: params.sessionKey,
      parentSessionKey: params.parentSessionKey,
    });
    return {
      conversationId:
        senderScopedConversationId ??
        buildFeishuConversationId({
          chatId: parentConversationId,
          scope: "group_topic",
          topicId: params.threadId,
        }),
      parentConversationId,
    };
  }
  const conversationId =
    parseFeishuDirectConversationId(params.originatingTo) ??
    parseFeishuDirectConversationId(params.commandTo) ??
    parseFeishuDirectConversationId(params.fallbackTo);
  return conversationId ? { conversationId } : null;
}

function jsonActionResult(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
  };
}

function readFirstString(
  params: Record<string, unknown>,
  keys: string[],
  fallback?: string | null,
): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  if (typeof fallback === "string" && fallback.trim()) {
    return fallback.trim();
  }
  return undefined;
}

const UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

function resolveFeishuMessageActionResponsePrefix(ctx: ChannelMessageActionContext) {
  const channel = ctx.cfg.channels?.feishu as
    | { responsePrefix?: string; accounts?: Record<string, { responsePrefix?: string }> }
    | undefined;
  const configured =
    (ctx.accountId ? channel?.accounts?.[ctx.accountId]?.responsePrefix : undefined) ??
    channel?.responsePrefix ??
    (channel === undefined ? ctx.cfg.messages?.responsePrefix : undefined);
  if (!configured) {
    return undefined;
  }
  const identityName = resolveAgentConfig(ctx.cfg, ctx.agentId ?? "main")?.identity?.name?.trim();
  const resolved =
    configured === "auto"
      ? identityName
        ? `[${identityName}]`
        : undefined
      : configured.replace(/\{(?:identity\.name|identityname)\}/gi, identityName ?? "$&");
  return resolved && !UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN.test(resolved) ? resolved : undefined;
}

function readOptionalPositiveInteger(
  params: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const parsed = parseStrictPositiveInteger(params[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function resolveFeishuActionTarget(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  return readFirstString(ctx.params, ["to", "target"], ctx.toolContext?.currentChannelId);
}

function resolveFeishuChatId(ctx: {
  params: Record<string, unknown>;
  toolContext?: { currentChannelId?: string } | null;
}): string | undefined {
  const raw = readFirstString(
    ctx.params,
    ["chatId", "chat_id", "channelId", "channel_id", "to", "target"],
    ctx.toolContext?.currentChannelId,
  );
  if (!raw) {
    return undefined;
  }
  if (/^(user|dm|open_id):/i.test(raw)) {
    return undefined;
  }
  if (/^(chat|group|channel):/i.test(raw)) {
    return normalizeFeishuTarget(raw) ?? undefined;
  }
  return raw;
}

function resolveFeishuMessageId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, ["messageId", "message_id", "replyTo", "reply_to"]);
}

function resolveFeishuMessageReadTarget(ctx: {
  params: Record<string, unknown>;
  toolContext?: {
    currentChannelId?: string;
    currentChatType?: "direct" | "group" | "channel";
  } | null;
}): { chatId: string; chatType?: "p2p" | "group" } | undefined {
  const explicitChatId = resolveFeishuChatId({ params: ctx.params });
  const currentChatId = resolveFeishuChatId({
    params: {},
    toolContext: ctx.toolContext,
  });
  const chatId = explicitChatId ?? currentChatId;
  if (!chatId) {
    return undefined;
  }
  const normalizedChatId = normalizeFeishuTarget(chatId) ?? chatId.trim();
  const normalizedCurrentChatId = currentChatId
    ? (normalizeFeishuTarget(currentChatId) ?? currentChatId.trim())
    : undefined;
  if (normalizedChatId !== normalizedCurrentChatId) {
    return { chatId: normalizedChatId };
  }
  const currentChatType =
    ctx.toolContext?.currentChatType === "direct"
      ? "p2p"
      : ctx.toolContext?.currentChatType === "group" ||
          ctx.toolContext?.currentChatType === "channel"
        ? "group"
        : undefined;
  return { chatId: normalizedChatId, chatType: currentChatType };
}

function assertFeishuMessageMatchesReadTarget(params: {
  authorizedChatId: string;
  messageChatId: string;
}) {
  const messageChatId = normalizeFeishuTarget(params.messageChatId) ?? params.messageChatId.trim();
  if (messageChatId !== params.authorizedChatId) {
    throw new ToolAuthorizationError("Feishu message target is not allowed.");
  }
}

async function authorizeFeishuMessageReadTarget(params: {
  ctx: ChannelMessageActionContext;
  account: ResolvedFeishuAccount;
  runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>;
  target: NonNullable<ReturnType<typeof resolveFeishuMessageReadTarget>>;
}) {
  const authorize = (chatType?: "p2p" | "group") =>
    assertFeishuChatReadAllowed({
      cfg: params.ctx.cfg,
      account: params.account,
      chatId: params.target.chatId,
      chatType,
      ctx: params.ctx,
    });
  if (params.target.chatType) {
    return authorize(params.target.chatType);
  }
  const preliminary = resolveFeishuChatReadPreliminaryAuthorization({
    cfg: params.ctx.cfg,
    account: params.account,
    chatId: params.target.chatId,
    ctx: params.ctx,
  });
  if (preliminary.decision === "allow") {
    return preliminary.chatId;
  }
  if (preliminary.decision === "deny") {
    throw new ToolAuthorizationError("Feishu read target is not allowed.");
  }
  // Static policy could not distinguish group from DM. Reuse the shared
  // metadata gate so lookup failures cannot become a target-existence oracle.
  await getAuthorizedFeishuChatInfo({
    ctx: params.ctx,
    account: params.account,
    runtime: params.runtime,
    chatId: params.target.chatId,
  });
  return preliminary.chatId;
}

async function getAuthorizedFeishuChatInfo(params: {
  ctx: ChannelMessageActionContext;
  account: ResolvedFeishuAccount;
  runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>;
  chatId: string;
}) {
  const preliminary = resolveFeishuChatReadPreliminaryAuthorization({
    cfg: params.ctx.cfg,
    account: params.account,
    chatId: params.chatId,
    ctx: params.ctx,
  });
  if (preliminary.decision === "deny") {
    throw new ToolAuthorizationError("Feishu read target is not allowed.");
  }
  const client = await createFeishuActionClient(params.account);
  let chat: Awaited<ReturnType<typeof params.runtime.getChatInfo>>;
  try {
    chat = await params.runtime.getChatInfo(client, preliminary.chatId);
  } catch (error) {
    if (preliminary.decision === "needs-metadata") {
      assertFeishuChatReadAllowed({
        cfg: params.ctx.cfg,
        account: params.account,
        chatId: preliminary.chatId,
        ctx: params.ctx,
      });
    }
    throw error;
  }
  assertFeishuChatReadAllowed({
    cfg: params.ctx.cfg,
    account: params.account,
    chatId: preliminary.chatId,
    chatType: resolveFeishuChatType(chat),
    ctx: params.ctx,
  });
  return { chat, client };
}

async function getAuthorizedFeishuMessage(params: {
  ctx: ChannelMessageActionContext;
  account: ResolvedFeishuAccount;
  runtime: Awaited<ReturnType<typeof loadFeishuChannelRuntime>>;
  messageId: string;
}) {
  // An opaque message id cannot authorize its own provider read. Gate an
  // independent chat target first, then bind the provider response to it.
  // Trusted direct operators may retain ID-only workflows because their
  // provider read is not delegated; final account and disabled-scope policy
  // still applies after the message resolves its chat.
  const target = resolveFeishuMessageReadTarget(params.ctx);
  if (!target && params.ctx.conversationReadOrigin !== "direct-operator") {
    throw new ToolAuthorizationError(
      "Feishu message reads require a chat target or current conversation.",
    );
  }
  const authorizedChatId = target
    ? await authorizeFeishuMessageReadTarget({
        ctx: params.ctx,
        account: params.account,
        runtime: params.runtime,
        target,
      })
    : undefined;
  const message = await params.runtime.getMessageFeishu({
    cfg: params.ctx.cfg,
    messageId: params.messageId,
    accountId: params.ctx.accountId ?? undefined,
  });
  if (!message) {
    return null;
  }
  if (authorizedChatId) {
    assertFeishuMessageMatchesReadTarget({
      authorizedChatId,
      messageChatId: message.chatId,
    });
  }
  assertFeishuChatReadAllowed({
    cfg: params.ctx.cfg,
    account: params.account,
    chatId: message.chatId,
    chatType: await resolveFeishuMessageChatType({
      account: params.account,
      message,
      runtime: params.runtime,
    }),
    ctx: params.ctx,
  });
  return message;
}

async function requireAuthorizedFeishuMessage(
  params: Parameters<typeof getAuthorizedFeishuMessage>[0],
) {
  const message = await getAuthorizedFeishuMessage(params);
  if (!message) {
    throw new Error(`Feishu message not found: ${params.messageId}`);
  }
  return message;
}

function resolveFeishuMemberId(params: Record<string, unknown>): string | undefined {
  return readFirstString(params, [
    "memberId",
    "member_id",
    "userId",
    "user_id",
    "openId",
    "open_id",
    "unionId",
    "union_id",
  ]);
}

function resolveFeishuMemberIdType(
  params: Record<string, unknown>,
): "open_id" | "user_id" | "union_id" {
  return resolveRequestedFeishuMemberIdType(params) ?? "open_id";
}

function resolveRequestedFeishuMemberIdType(
  params: Record<string, unknown>,
): "open_id" | "user_id" | "union_id" | undefined {
  const raw = readFirstString(params, [
    "memberIdType",
    "member_id_type",
    "userIdType",
    "user_id_type",
  ]);
  if (raw === "open_id" || raw === "user_id" || raw === "union_id") {
    return raw;
  }
  if (
    readFirstString(params, ["userId", "user_id"]) &&
    !readFirstString(params, ["openId", "open_id", "unionId", "union_id"])
  ) {
    return "user_id";
  }
  if (
    readFirstString(params, ["unionId", "union_id"]) &&
    !readFirstString(params, ["openId", "open_id"])
  ) {
    return "union_id";
  }
  if (readFirstString(params, ["openId", "open_id"])) {
    return "open_id";
  }
  return undefined;
}

export const feishuPlugin: ChannelPlugin<ResolvedFeishuAccount, FeishuProbeResult> =
  createChatChannelPlugin({
    base: {
      id: "feishu",
      meta: {
        ...meta,
      },
      capabilities: {
        chatTypes: ["direct", "channel"],
        polls: false,
        threads: true,
        media: true,
        tts: {
          voice: {
            synthesisTarget: "voice-note",
            transcodesAudio: true,
          },
        },
        reactions: true,
        edit: true,
        reply: true,
      },
      agentPrompt: {
        messageToolHints: ({ cfg, accountId }) => {
          const actions = describeFeishuMessageTool({
            cfg,
            accountId: accountId ?? undefined,
          }).actions;
          return [
            "- Feishu targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:open_id` or `chat:chat_id`.",
            "- Feishu supports interactive cards plus native image, file, audio, and video/media delivery.",
            "- Feishu supports `send`, `read`, `edit`, `thread-reply`, pins, and channel/member lookup, plus reactions when enabled.",
            ...(actions?.includes("sticker")
              ? [
                  "- Feishu stickers: use `action=sticker` with `fileId` (or the first `stickerId`) from a sticker this bot previously received. Sticker upload is not supported.",
                ]
              : []),
            ...(actions?.includes("sticker-search")
              ? [
                  "- Feishu `action=sticker-search`: configured keyword lookup only, not store search or learned/visual matching. Supply `query` (1–128 characters) and optional `limit` (1–10, default 5); send a returned `fileId` with `action=sticker` on the same account. If `truncated` is true, narrow the query.",
                ]
              : []),
          ];
        },
      },
      groups: {
        resolveToolPolicy: resolveFeishuGroupToolPolicy,
      },
      conversationBindings: {
        bindingStore: "adapter",
        defaultTopLevelPlacement: "current",
        buildModelOverrideParentCandidates: ({ parentConversationId }) =>
          buildFeishuModelOverrideParentCandidates(parentConversationId),
      },
      mentions: {
        stripPatterns: () => ['<at user_id="[^"]*">[^<]*</at>'],
      },
      reload: { configPrefixes: ["channels.feishu"] },
      doctor: feishuDoctor,
      configSchema: FeishuChannelConfigSchema,
      config: {
        ...feishuConfigAdapter,
        deleteAccount: ({ cfg, accountId }) => {
          const isDefault = accountId === DEFAULT_ACCOUNT_ID;

          if (isDefault) {
            // Delete entire feishu config
            const next = { ...cfg } as ClawdbotConfig;
            const nextChannels = { ...cfg.channels };
            delete (nextChannels as Record<string, unknown>).feishu;
            if (Object.keys(nextChannels).length > 0) {
              next.channels = nextChannels;
            } else {
              delete next.channels;
            }
            return next;
          }

          // Delete specific account from accounts
          const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
          const accounts = { ...feishuCfg?.accounts };
          delete accounts[accountId];

          return {
            ...cfg,
            channels: {
              ...cfg.channels,
              feishu: {
                ...feishuCfg,
                accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
              },
            },
          };
        },
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              appId: account.appId,
              domain: account.domain,
            },
          }),
      },
      approvalCapability: feishuApprovalAuth,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      actions: {
        providerOwnedReadGates: true,
        messageActionTargetAliases,
        describeMessageTool: describeFeishuMessageTool,
        handleAction: async (ctx) => {
          const account = resolveFeishuAccount({
            cfg: ctx.cfg,
            accountId: ctx.accountId ?? undefined,
          });
          if (
            (ctx.action === "react" || ctx.action === "reactions") &&
            !isFeishuActionEnabled(account, "reactions")
          ) {
            throw new Error("Feishu reactions are disabled via actions.reactions.");
          }
          if (ctx.action === "sticker" || ctx.action === "sticker-search") {
            if (!isFeishuActionEnabled(account, "sticker")) {
              throw new Error(
                "Feishu stickers are disabled; enable actions.sticker for a configured account.",
              );
            }
            if (ctx.action === "sticker-search") {
              const stickers = resolveFeishuStickerSet(ctx.cfg, account);
              if (stickers.length === 0) {
                throw new Error(
                  "Feishu sticker-search requires a nonempty channels.feishu.stickerSets entry for this account's appId.",
                );
              }
              return jsonActionResult(searchFeishuStickerSet(stickers, ctx.params));
            }
            const to = resolveFeishuActionTarget(ctx);
            if (!to) {
              throw new Error("Feishu sticker requires a target (to).");
            }
            const fileKey = normalizeFeishuExternalKey(
              readFirstString(ctx.params, ["fileId"]) ??
                (Array.isArray(ctx.params.stickerId) ? ctx.params.stickerId[0] : undefined),
            );
            if (!fileKey) {
              throw new Error(
                "Feishu sticker requires fileId (or first stickerId): use the file_key of a sticker this bot previously received.",
              );
            }
            const anchor = buildFeishuSendReplyAnchor(ctx, account.accountId);
            const runtime = await loadFeishuChannelRuntime();
            const result = await runtime.sendStickerFeishu({
              cfg: ctx.cfg,
              to,
              fileKey,
              accountId: ctx.accountId ?? undefined,
              replyToMessageId: anchor.replyToMessageId,
              replyInThread: anchor.replyInThread,
            });
            return jsonActionResult({ ok: true, channel: "feishu", action: "sticker", ...result });
          }
          if (ctx.action === "send" || ctx.action === "thread-reply") {
            const to = resolveFeishuActionTarget(ctx);
            if (!to) {
              throw new Error(`Feishu ${ctx.action} requires a target (to).`);
            }
            const { replyToMessageId, replyInThread } = buildFeishuSendReplyAnchor(
              ctx,
              account.accountId,
            );
            if (ctx.action === "thread-reply" && !replyToMessageId) {
              throw new Error("Feishu thread-reply requires messageId.");
            }
            const text = readFirstString(ctx.params, ["text", "message"]);
            const textCard = readNativeFeishuCardJson(text, {
              responsePrefix: resolveFeishuMessageActionResponsePrefix(ctx),
            });
            const { interactive, presentation } = resolveFeishuRichReply(ctx.params);
            // Thread replies share send's validated attachment boundary so aliases
            // and unsupported payloads cannot silently become text-only delivery.
            const mediaUrl = resolveFeishuSendAttachmentMedia(ctx.params);
            const audioAsVoice = readBooleanParam(ctx.params, ["asVoice", "audioAsVoice"]);
            if (textCard && !presentation) {
              assertFeishuCardWithinEnvelope(textCard, "Feishu native card");
            }
            const generatedCard = presentation
              ? buildFeishuPresentationCard({
                  presentation,
                  fallbackText: textCard
                    ? undefined
                    : resolveLegacyInteractiveTextFallback({ text, interactive }),
                })
              : undefined;
            const presentationCard =
              generatedCard && isFeishuCardWithinEnvelope(generatedCard)
                ? generatedCard
                : undefined;
            const presentationFellBack = Boolean(generatedCard && !presentationCard);
            const card = presentation ? presentationCard : textCard;
            if (card && mediaUrl) {
              throw new Error(`Feishu ${ctx.action} does not support card with media.`);
            }
            if (!card && !text && !mediaUrl && !presentationFellBack) {
              throw new Error(`Feishu ${ctx.action} requires text/message, media, or card.`);
            }
            const runtime = await loadFeishuChannelRuntime();
            const maybeSendMedia = runtime.feishuOutbound.sendMedia;
            if (mediaUrl && !maybeSendMedia) {
              throw new Error("Feishu media sending is not available.");
            }
            // The Feishu sendMedia implementation accepts an optional
            // `propagateMediaUploadFailure` flag the shared adapter contract
            // does not; `feishuOutbound` keeps the shared `ChannelOutboundAdapter`
            // shape (optional `sendMedia`), so the direct send action narrows it
            // to `FeishuOutboundSendMedia` here to request a controlled
            // upload-failure outcome without a type assert.
            const sendMedia: FeishuOutboundSendMedia | undefined = maybeSendMedia;
            let result;
            if (presentationFellBack && presentation) {
              const sendPayload = runtime.feishuOutbound.sendPayload;
              if (!sendPayload) {
                throw new Error("Feishu presentation fallback delivery is not available.");
              }
              // Native card JSON is only an alternate representation of the
              // structured presentation; never expose it in the text fallback.
              const fallbackText = textCard ? undefined : text;
              result = await sendPayload({
                cfg: ctx.cfg,
                to,
                text: fallbackText ?? "",
                payload: {
                  text: fallbackText,
                  presentation,
                  ...(mediaUrl ? { mediaUrl } : {}),
                  ...(audioAsVoice === undefined ? {} : { audioAsVoice }),
                  // The direct `send` action must keep an attachment failure
                  // visible on this path too: `sendPayload`'s shared signature
                  // cannot carry `propagateMediaUploadFailure`, so stamp the
                  // marker here and let `sendFeishuFallbackPayload` re-throw the
                  // upload failure instead of returning a fallback-text `ok:true`
                  // receipt (issue #112244, ClawSweeper P1). Scoped to `send`
                  // only — thread-reply keeps its existing fallback behavior.
                  ...(ctx.action === "send"
                    ? {
                        channelData: {
                          feishu: { [FEISHU_PROPAGATE_MEDIA_UPLOAD_FAILURE_MARKER]: true },
                        },
                      }
                    : {}),
                },
                accountId: ctx.accountId ?? undefined,
                ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
                mediaLocalRoots: ctx.mediaLocalRoots,
                ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
                ...(replyInThread
                  ? { threadId: replyToMessageId }
                  : { replyToId: replyToMessageId }),
                ...(audioAsVoice === undefined ? {} : { audioAsVoice }),
              });
            } else if (card) {
              if (containsLegacyFeishuCardCommandValue(card)) {
                throw new Error(
                  "Feishu card buttons that trigger text or commands must use structured interaction envelopes.",
                );
              }
              result = await runtime.sendCardFeishu({
                cfg: ctx.cfg,
                to,
                card,
                accountId: ctx.accountId ?? undefined,
                replyToMessageId,
                replyInThread,
              });
            } else {
              const outboundContext = {
                cfg: ctx.cfg,
                to,
                text: text ?? "",
                accountId: ctx.accountId ?? undefined,
                ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
                mediaLocalRoots: ctx.mediaLocalRoots,
                ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
                ...(replyInThread
                  ? { threadId: replyToMessageId }
                  : { replyToId: replyToMessageId }),
              };
              if (mediaUrl) {
                result = await sendMedia!({
                  ...outboundContext,
                  mediaUrl,
                  ...(audioAsVoice === true ? { audioAsVoice: true } : {}),
                  // Direct sends surface upload failures; thread replies retain
                  // their existing attachment fallback behavior.
                  ...(ctx.action === "send" ? { propagateMediaUploadFailure: true } : {}),
                });
              } else {
                const { target, ...delivery } = await (
                  await resolveFeishuTextSender()
                )(outboundContext);
                result = { ...delivery, chatId: target?.id };
              }
            }
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: ctx.action,
              ...result,
            });
          }

          if (ctx.action === "read") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu read requires messageId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            const message = await getAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            if (!message) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      error: `Feishu read failed or message not found: ${messageId}`,
                    }),
                  },
                ],
                details: { error: `Feishu read failed or message not found: ${messageId}` },
              };
            }
            return jsonActionResult({ ok: true, channel: "feishu", action: "read", message });
          }

          if (ctx.action === "edit") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu edit requires messageId.");
            }
            const text = readFirstString(ctx.params, ["text", "message"]);
            const card =
              ctx.params.card && typeof ctx.params.card === "object"
                ? (ctx.params.card as Record<string, unknown>)
                : undefined;
            const runtime = await loadFeishuChannelRuntime();
            await requireAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            const result = await runtime.editMessageFeishu({
              cfg: ctx.cfg,
              messageId,
              text,
              card,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "edit",
              ...result,
            });
          }

          if (ctx.action === "pin") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu pin requires messageId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            await requireAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            const pin = await runtime.createPinFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, channel: "feishu", action: "pin", pin });
          }

          if (ctx.action === "unpin") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu unpin requires messageId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            await requireAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            await runtime.removePinFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "unpin",
              messageId,
            });
          }

          if (ctx.action === "list-pins") {
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu list-pins requires chatId or channelId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            await getAuthorizedFeishuChatInfo({ ctx, account, runtime, chatId });
            const { listPinsFeishu } = runtime;
            const result = await listPinsFeishu({
              cfg: ctx.cfg,
              chatId,
              startTime: readFirstString(ctx.params, ["startTime", "start_time"]),
              endTime: readFirstString(ctx.params, ["endTime", "end_time"]),
              pageSize: readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]),
              pageToken: readFirstString(ctx.params, ["pageToken", "page_token"]),
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "list-pins",
              ...result,
            });
          }

          if (ctx.action === "channel-info") {
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu channel-info requires chatId or channelId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            const { chat: channel, client } = await getAuthorizedFeishuChatInfo({
              ctx,
              account,
              runtime,
              chatId,
            });
            const chatType = resolveFeishuChatType(channel);
            const includeMembers =
              ctx.params.includeMembers === true || ctx.params.members === true;
            if (!includeMembers) {
              return jsonActionResult({
                ok: true,
                provider: "feishu",
                action: "channel-info",
                channel,
              });
            }
            const requestedMemberIdType = resolveRequestedFeishuMemberIdType(ctx.params);
            const authorization = authorizeFeishuChatMemberRead({
              cfg: ctx.cfg,
              account,
              chatId,
              chatType,
              ctx,
              memberIdType: requestedMemberIdType,
            });
            const members =
              authorization.kind === "direct"
                ? runtime.buildFeishuDirectChatMembers(authorization)
                : await runtime.getChatMembers(
                    client,
                    chatId,
                    readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]),
                    readFirstString(ctx.params, ["pageToken", "page_token"]),
                    resolveFeishuMemberIdType(ctx.params),
                  );
            return jsonActionResult({
              ok: true,
              provider: "feishu",
              action: "channel-info",
              channel,
              members,
            });
          }

          if (ctx.action === "member-info") {
            const runtime = await loadFeishuChannelRuntime();
            const memberId = resolveFeishuMemberId(ctx.params);
            if (memberId) {
              const chatId = resolveFeishuChatId(ctx);
              if (!chatId) {
                throw new Error(
                  "Feishu member-info requires chatId or channelId when memberId is provided.",
                );
              }
              const { chat, client } = await getAuthorizedFeishuChatInfo({
                ctx,
                account,
                runtime,
                chatId,
              });
              const requestedMemberIdType = resolveRequestedFeishuMemberIdType(ctx.params);
              const memberIdType = resolveFeishuMemberIdType(ctx.params);
              const authorization = authorizeFeishuChatMemberRead({
                cfg: ctx.cfg,
                account,
                chatId,
                chatType: resolveFeishuChatType(chat),
                ctx,
                memberId,
                memberIdType: requestedMemberIdType,
              });
              if (authorization.kind === "group") {
                await runtime.assertFeishuChatMember(client, chatId, memberId, memberIdType);
                const member = await runtime.getFeishuMemberInfo(client, memberId, memberIdType);
                return jsonActionResult({
                  ok: true,
                  channel: "feishu",
                  action: "member-info",
                  member,
                });
              }
              const member = await runtime.getFeishuMemberInfo(
                client,
                authorization.memberId,
                authorization.memberIdType,
              );
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "member-info",
                member,
              });
            }
            const chatId = resolveFeishuChatId(ctx);
            if (!chatId) {
              throw new Error("Feishu member-info requires memberId or chatId/channelId.");
            }
            const { chat, client } = await getAuthorizedFeishuChatInfo({
              ctx,
              account,
              runtime,
              chatId,
            });
            const requestedMemberIdType = resolveRequestedFeishuMemberIdType(ctx.params);
            const authorization = authorizeFeishuChatMemberRead({
              cfg: ctx.cfg,
              account,
              chatId,
              chatType: resolveFeishuChatType(chat),
              ctx,
              memberIdType: requestedMemberIdType,
            });
            const members =
              authorization.kind === "direct"
                ? runtime.buildFeishuDirectChatMembers(authorization)
                : await runtime.getChatMembers(
                    client,
                    chatId,
                    readOptionalPositiveInteger(ctx.params, ["pageSize", "page_size"]),
                    readFirstString(ctx.params, ["pageToken", "page_token"]),
                    resolveFeishuMemberIdType(ctx.params),
                  );
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "member-info",
              ...members,
            });
          }

          if (ctx.action === "channel-list") {
            const runtime = await loadFeishuChannelRuntime();
            const query = readFirstString(ctx.params, ["query"]);
            const limit = readOptionalPositiveInteger(ctx.params, ["limit"]);
            const scope = readFirstString(ctx.params, ["scope", "kind"]) ?? "all";
            const directOperator = ctx.conversationReadOrigin === "direct-operator";
            const listGroups =
              directOperator || canEnumerateAllFeishuGroups(ctx.cfg, account)
                ? runtime.listFeishuDirectoryGroupsLive
                : listAuthorizedFeishuDirectoryGroups;
            const listPeers =
              directOperator || canEnumerateAllFeishuPeers(account)
                ? runtime.listFeishuDirectoryPeersLive
                : listAuthorizedFeishuDirectoryPeers;
            const directoryParams = {
              cfg: ctx.cfg,
              query,
              limit,
              accountId: ctx.accountId ?? undefined,
              fallbackToStatic: false,
            };
            const groupDirectoryParams = {
              ...directoryParams,
              filter: directOperator
                ? (group: { id: string }) => isFeishuGroupReadEnabled(ctx.cfg, account, group.id)
                : canEnumerateAllFeishuGroups(ctx.cfg, account)
                  ? (group: { id: string }) =>
                      isFeishuGroupReadAllowed(ctx.cfg, account, group.id, false)
                  : undefined,
            };
            if (
              scope === "groups" ||
              scope === "group" ||
              scope === "channels" ||
              scope === "channel"
            ) {
              const groups = await listGroups(groupDirectoryParams);
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "channel-list",
                groups,
              });
            }
            if (
              scope === "peers" ||
              scope === "peer" ||
              scope === "members" ||
              scope === "member" ||
              scope === "users" ||
              scope === "user"
            ) {
              const peers = await listPeers(directoryParams);
              return jsonActionResult({
                ok: true,
                channel: "feishu",
                action: "channel-list",
                peers,
              });
            }
            const [groups, peers] = await Promise.all([
              listGroups(groupDirectoryParams),
              listPeers(directoryParams),
            ]);
            return jsonActionResult({
              ok: true,
              channel: "feishu",
              action: "channel-list",
              groups,
              peers,
            });
          }

          if (ctx.action === "react") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu reaction requires messageId.");
            }
            const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
            const remove = ctx.params.remove === true;
            const clearAll = ctx.params.clearAll === true;
            if (remove) {
              if (!emoji) {
                throw new Error("Emoji is required to remove a Feishu reaction.");
              }
              const runtime = await loadFeishuChannelRuntime();
              await requireAuthorizedFeishuMessage({
                ctx,
                account,
                runtime,
                messageId,
              });
              const matches = await runtime.listReactionsFeishu({
                cfg: ctx.cfg,
                messageId,
                emojiType: emoji,
                accountId: ctx.accountId ?? undefined,
              });
              const ownReaction = matches.find(
                (entry) =>
                  entry.operatorType === "app" &&
                  Boolean(account.appId) &&
                  entry.operatorId === account.appId,
              );
              if (!ownReaction) {
                return jsonActionResult({ ok: true, removed: null });
              }
              await runtime.removeReactionFeishu({
                cfg: ctx.cfg,
                messageId,
                reactionId: ownReaction.reactionId,
                accountId: ctx.accountId ?? undefined,
              });
              return jsonActionResult({ ok: true, removed: emoji });
            }
            if (!emoji) {
              if (!clearAll) {
                throw new Error(
                  "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
                );
              }
              const runtime = await loadFeishuChannelRuntime();
              await requireAuthorizedFeishuMessage({
                ctx,
                account,
                runtime,
                messageId,
              });
              const reactions = await runtime.listReactionsFeishu({
                cfg: ctx.cfg,
                messageId,
                accountId: ctx.accountId ?? undefined,
              });
              let removed = 0;
              const ownReactions = reactions.filter(
                (entry) =>
                  entry.operatorType === "app" &&
                  Boolean(account.appId) &&
                  entry.operatorId === account.appId,
              );
              for (const reaction of ownReactions) {
                await runtime.removeReactionFeishu({
                  cfg: ctx.cfg,
                  messageId,
                  reactionId: reaction.reactionId,
                  accountId: ctx.accountId ?? undefined,
                });
                removed += 1;
              }
              return jsonActionResult({ ok: true, removed });
            }
            const runtime = await loadFeishuChannelRuntime();
            await requireAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            await runtime.addReactionFeishu({
              cfg: ctx.cfg,
              messageId,
              emojiType: emoji,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, added: emoji });
          }

          if (ctx.action === "reactions") {
            const messageId = resolveFeishuMessageId(ctx.params);
            if (!messageId) {
              throw new Error("Feishu reactions lookup requires messageId.");
            }
            const runtime = await loadFeishuChannelRuntime();
            await requireAuthorizedFeishuMessage({
              ctx,
              account,
              runtime,
              messageId,
            });
            const reactions = await runtime.listReactionsFeishu({
              cfg: ctx.cfg,
              messageId,
              accountId: ctx.accountId ?? undefined,
            });
            return jsonActionResult({ ok: true, reactions });
          }

          throw new Error(`Unsupported Feishu action: "${ctx.action}"`);
        },
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeFeishuAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchFeishuAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: ({
          accountId,
          threadId,
          senderId,
          sessionKey,
          parentSessionKey,
          originatingTo,
          commandTo,
          fallbackTo,
        }) =>
          resolveFeishuCommandConversation({
            accountId,
            threadId,
            senderId,
            sessionKey,
            parentSessionKey,
            originatingTo,
            commandTo,
            fallbackTo,
          }),
      },
      auth: {
        login: async ({ cfg }) => {
          const { createClackPrompter } = await import("openclaw/plugin-sdk/setup-runtime");
          const { replaceConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
          const prompter = createClackPrompter();
          const nextCfg = await runFeishuLogin({ cfg, prompter });
          if (nextCfg !== cfg) {
            await replaceConfigFile({
              nextConfig: nextCfg,
              afterWrite: { mode: "auto" },
            });
          }
        },
      },
      setupContract: feishuSetupContract,
      setupWizard: feishuSetupWizard,
      messaging: {
        targetPrefixes: ["feishu", "lark"],
        normalizeTarget: (raw) => normalizeFeishuTarget(raw) ?? undefined,
        inferTargetChatType: ({ to }) =>
          resolveReceiveIdType(to) === "chat_id" ? "group" : "direct",
        resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
          const directId = parseFeishuDirectConversationId(conversationId);
          if (directId) {
            return { to: `user:${directId}` };
          }
          const parsed = parseFeishuConversationId({ conversationId, parentConversationId });
          if (parsed?.topicId) {
            return {
              to: `chat:${parentConversationId?.trim() || parsed.chatId}`,
              threadId: parsed.topicId,
            };
          }
          return { to: `chat:${parsed?.chatId ?? conversationId.trim()}` };
        },
        // Same function as the public session-key artifact so the pre-registry
        // fast path cannot drift from plugin behavior (pinned by contract test).
        resolveSessionConversation: resolveFeishuSessionConversation,
        resolveOutboundSessionRoute: (params) => resolveFeishuOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeFeishuId,
          hint: "<chatId|user:openId|chat:chatId>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async ({ cfg, query, limit, accountId }) =>
          listFeishuDirectoryPeers({
            cfg,
            query: query ?? undefined,
            limit: limit ?? undefined,
            accountId: accountId ?? undefined,
          }),
        listGroups: async ({ cfg, query, limit, accountId }) =>
          listFeishuDirectoryGroups({
            cfg,
            query: query ?? undefined,
            limit: limit ?? undefined,
            accountId: accountId ?? undefined,
          }),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadFeishuChannelRuntime,
          listPeersLive:
            (runtime) =>
            async ({ cfg, query, limit, accountId }) =>
              await runtime.listFeishuDirectoryPeersLive({
                cfg,
                query: query ?? undefined,
                limit: limit ?? undefined,
                accountId: accountId ?? undefined,
              }),
          listGroupsLive:
            (runtime) =>
            async ({ cfg, query, limit, accountId }) =>
              await runtime.listFeishuDirectoryGroupsLive({
                cfg,
                query: query ?? undefined,
                limit: limit ?? undefined,
                accountId: accountId ?? undefined,
              }),
        }),
      }),
      status: createComputedAccountStatusAdapter<ResolvedFeishuAccount, FeishuProbeResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        probeAccount: async ({ account }) =>
          await (await loadFeishuChannelRuntime()).probeFeishu(account),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          name: account.name,
          extra: {
            appId: account.appId,
            domain: account.domain,
            port: runtime?.port ?? null,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorFeishuProvider } = await import("./monitor.js");
          const account = resolveFeishuRuntimeAccount(
            { cfg: ctx.cfg, accountId: ctx.accountId },
            { requireEventSecrets: true },
          );
          const port = account.config?.webhookPort ?? null;
          ctx.setStatus({ accountId: ctx.accountId, port });
          ctx.log?.info(
            `starting feishu[${ctx.accountId}] (mode: ${account.config?.connectionMode ?? "websocket"})`,
          );
          // Publish Feishu connected state and event recency through the
          // shared channel status sink.
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          return monitorFeishuProvider({
            config: ctx.cfg,
            runtime: ctx.runtime,
            // Gateway provides the full channel runtime here; the public SDK type
            // stays context-only for external compatibility.
            channelRuntime: ctx.channelRuntime as PluginRuntime["channel"] | undefined,
            abortSignal: ctx.abortSignal,
            accountId: ctx.accountId,
            statusSink,
          });
        },
      },
      message: feishuMessageAdapter,
    },
    security: {
      collectWarnings: ({ cfg, accountId }) => collectFeishuOpenGroupFindings({ cfg, accountId }),
      collectAuditFindings: ({ cfg }) => collectFeishuSecurityAuditFindings({ cfg }),
    },
    pairing: {
      text: {
        idLabel: "feishuUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(feishu|user|open_id):/i),
        notify: async ({ cfg, id, message, accountId }) => {
          const { sendMessageFeishu } = await loadFeishuChannelRuntime();
          await sendMessageFeishu({
            cfg,
            to: id,
            text: message,
            accountId,
          });
        },
      },
    },
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) => {
        const normalizedTarget = normalizeFeishuTarget(target);
        if (!normalizedTarget) {
          return false;
        }
        return [toolContext.currentChannelId, toolContext.currentMessagingTarget].some(
          (currentTarget) =>
            currentTarget !== undefined &&
            normalizeFeishuTarget(currentTarget) === normalizedTarget,
        );
      },
      buildToolContext: ({ context, hasRepliedRef }) => ({
        currentChannelId:
          normalizeOptionalString(context.NativeChannelId) ?? normalizeOptionalString(context.To),
        currentChatType:
          context.ChatType === "direct" ||
          context.ChatType === "group" ||
          context.ChatType === "channel"
            ? context.ChatType
            : undefined,
        currentMessagingTarget: normalizeOptionalString(context.To),
        currentThreadTs:
          context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
        hasRepliedRef,
      }),
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkFeishuMarkdown,
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
      presentationCapabilities: {
        supported: true,
        buttons: true,
        selects: false,
        context: true,
        divider: true,
        limits: {
          actions: {
            maxActions: 20,
            maxActionsPerRow: 5,
            maxLabelLength: 40,
            maxValueBytes: 1024,
          },
          text: {
            maxLength: 4000,
            encoding: "characters",
            markdownDialect: "markdown",
          },
        },
      },
      ...createRuntimeOutboundDelegates({
        getRuntime: loadFeishuChannelRuntime,
        renderPresentation: { resolve: (runtime) => runtime.feishuOutbound.renderPresentation },
        sendPayload: {
          resolve: (runtime) => runtime.feishuOutbound.sendPayload,
          unavailableMessage: "Feishu payload sending is not available.",
        },
        sendText: { resolve: (runtime) => runtime.feishuOutbound.sendText },
        sendMedia: { resolve: (runtime) => runtime.feishuOutbound.sendMedia },
      }),
    },
  });
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
