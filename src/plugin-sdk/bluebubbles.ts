import type { ChannelStatusIssue } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedTarget,
  type ParsedChatTarget,
} from "./channel-targets.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

// Narrow plugin-sdk surface for the bundled BlueBubbles plugin.
// Keep this list additive and scoped to the conversation-binding seam only.

type BlueBubblesService = "imessage" | "sms" | "auto";

type BlueBubblesTarget =
  | ParsedChatTarget
  | { kind: "handle"; to: string; service: BlueBubblesService };

export type BlueBubblesConversationBindingManager = {
  stop: () => void;
};

type BlueBubblesFacadeModule = {
  createBlueBubblesConversationBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => BlueBubblesConversationBindingManager;
  collectBlueBubblesStatusIssues: (accounts: unknown[]) => ChannelStatusIssue[];
};

function loadBlueBubblesFacadeModule(): BlueBubblesFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<BlueBubblesFacadeModule>({
    dirName: "bluebubbles",
    artifactBasename: "api.js",
  });
}

export function createBlueBubblesConversationBindingManager(params: {
  accountId?: string;
  cfg: OpenClawConfig;
}): BlueBubblesConversationBindingManager {
  return loadBlueBubblesFacadeModule().createBlueBubblesConversationBindingManager(params);
}

const CHAT_ID_PREFIXES = ["chat_id:", "chatid:", "chat:"];
const CHAT_GUID_PREFIXES = ["chat_guid:", "chatguid:", "guid:"];
const CHAT_IDENTIFIER_PREFIXES = ["chat_identifier:", "chatidentifier:", "chatident:"];
const SERVICE_PREFIXES: Array<{ prefix: string; service: BlueBubblesService }> = [
  { prefix: "imessage:", service: "imessage" },
  { prefix: "sms:", service: "sms" },
  { prefix: "auto:", service: "auto" },
];
const CHAT_IDENTIFIER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_IDENTIFIER_HEX_RE = /^[0-9a-f]{24,64}$/i;

function parseRawChatGuid(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parts = trimmed.split(";");
  if (parts.length !== 3) {
    return null;
  }
  const service = parts[0]?.trim();
  const separator = parts[1]?.trim();
  const identifier = parts[2]?.trim();
  if (!service || !identifier) {
    return null;
  }
  if (separator !== "+" && separator !== "-") {
    return null;
  }
  return `${service};${separator};${identifier}`;
}

function stripPrefix(value: string, prefix: string): string {
  return value.slice(prefix.length).trim();
}

function stripBlueBubblesPrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("bluebubbles:")) {
    return trimmed;
  }
  return trimmed.slice("bluebubbles:".length).trim();
}

function looksLikeRawChatIdentifier(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^chat\d+$/i.test(trimmed)) {
    return true;
  }
  return CHAT_IDENTIFIER_UUID_RE.test(trimmed) || CHAT_IDENTIFIER_HEX_RE.test(trimmed);
}

function parseGroupTarget(params: {
  trimmed: string;
  lower: string;
}): { kind: "chat_id"; chatId: number } | { kind: "chat_guid"; chatGuid: string } | null {
  if (!params.lower.startsWith("group:")) {
    return null;
  }
  const value = stripPrefix(params.trimmed, "group:");
  const chatId = Number.parseInt(value, 10);
  if (Number.isFinite(chatId)) {
    return { kind: "chat_id", chatId };
  }
  if (value) {
    return { kind: "chat_guid", chatGuid: value };
  }
  throw new Error("group target is required");
}

function parseRawChatIdentifierTarget(
  trimmed: string,
): { kind: "chat_identifier"; chatIdentifier: string } | null {
  if (/^chat\d+$/i.test(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  if (looksLikeRawChatIdentifier(trimmed)) {
    return { kind: "chat_identifier", chatIdentifier: trimmed };
  }
  return null;
}

function normalizeBlueBubblesHandle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.startsWith("imessage:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(9));
  }
  if (lowered.startsWith("sms:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(4));
  }
  if (lowered.startsWith("auto:")) {
    return normalizeBlueBubblesHandle(trimmed.slice(5));
  }
  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  return trimmed.replace(/\s+/g, "");
}

function extractHandleFromChatGuid(chatGuid: string): string | null {
  const parts = chatGuid.split(";");
  if (parts.length === 3 && parts[1] === "-") {
    const handle = parts[2]?.trim();
    if (handle) {
      return normalizeBlueBubblesHandle(handle);
    }
  }
  return null;
}

function parseBlueBubblesTarget(raw: string): BlueBubblesTarget {
  const trimmed = stripBlueBubblesPrefix(raw);
  if (!trimmed) {
    throw new Error("BlueBubbles target is required");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);

  const servicePrefixed = resolveServicePrefixedTarget({
    trimmed,
    lower,
    servicePrefixes: SERVICE_PREFIXES,
    isChatTarget: (remainderLower) =>
      CHAT_ID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      CHAT_GUID_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      CHAT_IDENTIFIER_PREFIXES.some((p) => remainderLower.startsWith(p)) ||
      remainderLower.startsWith("group:"),
    parseTarget: parseBlueBubblesTarget,
  });
  if (servicePrefixed) {
    return servicePrefixed;
  }

  const chatTarget = parseChatTargetPrefixesOrThrow({
    trimmed,
    lower,
    chatIdPrefixes: CHAT_ID_PREFIXES,
    chatGuidPrefixes: CHAT_GUID_PREFIXES,
    chatIdentifierPrefixes: CHAT_IDENTIFIER_PREFIXES,
  });
  if (chatTarget) {
    return chatTarget;
  }

  const groupTarget = parseGroupTarget({ trimmed, lower });
  if (groupTarget) {
    return groupTarget;
  }

  const rawChatGuid = parseRawChatGuid(trimmed);
  if (rawChatGuid) {
    return { kind: "chat_guid", chatGuid: rawChatGuid };
  }

  const rawChatIdentifierTarget = parseRawChatIdentifierTarget(trimmed);
  if (rawChatIdentifierTarget) {
    return rawChatIdentifierTarget;
  }

  return { kind: "handle", to: trimmed, service: "auto" };
}

export function normalizeBlueBubblesAcpConversationId(
  conversationId: string,
): { conversationId: string } | null {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = parseBlueBubblesTarget(trimmed);
    if (parsed.kind === "handle") {
      const handle = normalizeBlueBubblesHandle(parsed.to);
      return handle ? { conversationId: handle } : null;
    }
    if (parsed.kind === "chat_id") {
      return { conversationId: String(parsed.chatId) };
    }
    if (parsed.kind === "chat_guid") {
      const handle = extractHandleFromChatGuid(parsed.chatGuid);
      return {
        conversationId: handle || parsed.chatGuid,
      };
    }
    return { conversationId: parsed.chatIdentifier };
  } catch {
    const handle = normalizeBlueBubblesHandle(trimmed);
    return handle ? { conversationId: handle } : null;
  }
}

export function matchBlueBubblesAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
}): { conversationId: string; matchPriority: number } | null {
  const binding = normalizeBlueBubblesAcpConversationId(params.bindingConversationId);
  const conversation = normalizeBlueBubblesAcpConversationId(params.conversationId);
  if (!binding || !conversation) {
    return null;
  }
  if (binding.conversationId !== conversation.conversationId) {
    return null;
  }
  return {
    conversationId: conversation.conversationId,
    matchPriority: 2,
  };
}

export function resolveBlueBubblesConversationIdFromTarget(target: string): string | undefined {
  return normalizeBlueBubblesAcpConversationId(target)?.conversationId;
}

export function collectBlueBubblesStatusIssues(accounts: unknown[]): ChannelStatusIssue[] {
  return loadBlueBubblesFacadeModule().collectBlueBubblesStatusIssues(accounts);
}

export { resolveAckReaction } from "../agents/identity.js";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "../agents/tools/common.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  evictOldHistoryKeys,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { logAckFailure, logInboundDrop, logTypingFailure } from "../channels/logging.js";
export {
  BLUEBUBBLES_ACTION_NAMES,
  BLUEBUBBLES_ACTIONS,
} from "../channels/plugins/bluebubbles-actions.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./bluebubbles-policy.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export type { DmPolicy, GroupPolicy } from "../config/types.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export {
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedTarget,
  type ParsedChatTarget,
} from "./channel-targets.js";
export { stripMarkdown } from "./text-runtime.js";
export { parseFiniteNumber } from "../infra/parse-finite-number.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { isAllowedParsedChatSender } from "./allow-from.js";
export { readBooleanParam } from "./boolean-param.js";
export { mapAllowFromEntries } from "./channel-config-helpers.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { resolveRequestUrl } from "./request-url.js";
export {
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
} from "./status-helpers.js";
export { isAllowedBlueBubblesSender } from "./bluebubbles-policy.js";
export { extractToolSend } from "./tool-send.js";
export {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  normalizeWebhookPath,
  readWebhookBodyOrReject,
  registerWebhookTargetWithPluginRoute,
  resolveRequestClientIp,
  resolveWebhookTargets,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
} from "./webhook-ingress.js";
