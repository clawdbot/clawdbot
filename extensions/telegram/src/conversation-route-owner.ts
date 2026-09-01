import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveThreadBindingSpawnPolicy } from "openclaw/plugin-sdk/conversation-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { inspectTelegramConversationRoute } from "./conversation-route.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { parseTelegramTarget } from "./targets.js";
import type { TelegramThreadSpec } from "./thread-spec.js";

function resolveInspectionThread(params: {
  kind: "direct" | "group" | "channel";
  peerId: string;
  target?: string;
  threadId?: string;
}): { chatId: string; threadSpec: TelegramThreadSpec } | null {
  const target = parseTelegramTarget(params.target?.trim() || params.peerId);
  const chatId = target.chatId.trim();
  if (!chatId) {
    return null;
  }
  if (target.directMessagesTopicId != null) {
    return {
      chatId,
      threadSpec: { id: target.directMessagesTopicId, scope: "direct-messages" },
    };
  }
  if (target.messageThreadId != null) {
    return { chatId, threadSpec: { id: target.messageThreadId, scope: "forum" } };
  }
  const threadId = parseStrictNonNegativeInteger(params.threadId);
  return {
    chatId,
    threadSpec:
      threadId == null
        ? { scope: "none" }
        : { id: threadId, scope: params.kind === "direct" ? "dm" : "forum" },
  };
}

export function inspectTelegramConversationRouteOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  conversation: {
    kind: "direct" | "group" | "channel";
    peerId: string;
    target?: string;
    threadId?: string;
  };
}) {
  const parsed = resolveInspectionThread(params.conversation);
  if (!parsed) {
    return null;
  }
  const account = resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId });
  const { topicConfig } = resolveTelegramScopedGroupConfig(
    account.config,
    parsed.chatId,
    parsed.threadSpec.id,
  );
  const result = inspectTelegramConversationRoute({
    cfg: params.cfg,
    accountId: account.accountId,
    chatId: parsed.chatId,
    isGroup: params.conversation.kind !== "direct",
    threadSpec: parsed.threadSpec,
    senderId: params.conversation.kind === "direct" ? params.conversation.peerId : undefined,
    topicAgentId: topicConfig?.agentId,
  });
  if (
    !result.bindingOwnerAvailable &&
    resolveThreadBindingSpawnPolicy({
      cfg: params.cfg,
      channel: "telegram",
      accountId: params.accountId,
      kind: "subagent",
    }).enabled
  ) {
    return { kind: "unavailable" as const };
  }
  if (result.bindingMode.kind !== "plugin-owned-runtime") {
    return { kind: "agent" as const, agentId: result.route.agentId };
  }
  return result.bindingMode.pluginId
    ? {
        kind: "plugin" as const,
        pluginId: result.bindingMode.pluginId,
        fallbackAgentId: result.route.agentId,
      }
    : null;
}
