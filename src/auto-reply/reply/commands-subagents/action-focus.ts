import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import { normalizeChatType } from "../../../channels/chat-type.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingPlacementForCurrentContext,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import { normalizeConversationRef } from "../../../infra/outbound/session-binding-normalization.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { resolveConversationBindingContextFromAcpCommand } from "../conversation-binding-input.js";
import {
  type SubagentsCommandContext,
  resolveCommandSubagentController,
  resolveFocusTargetSession,
  stopWithText,
} from "./shared.js";

type FocusBindingContext = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  placement: "current" | "child";
};

function resolveFocusBindingContext(
  params: SubagentsCommandContext["params"],
): FocusBindingContext | null {
  const bindingContext = resolveConversationBindingContextFromAcpCommand(params);
  if (!bindingContext) {
    return null;
  }
  const chatType = normalizeChatType(params.ctx.ChatType);
  const conversation = normalizeConversationRef({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
  });
  return {
    channel: conversation.channel,
    accountId: conversation.accountId,
    conversationId: conversation.conversationId,
    ...(conversation.parentConversationId
      ? { parentConversationId: conversation.parentConversationId }
      : {}),
    placement:
      chatType === "direct"
        ? "current"
        : resolveThreadBindingPlacementForCurrentContext({
            channel: bindingContext.channel,
            threadId: bindingContext.threadId || undefined,
          }),
  };
}

export async function handleSubagentsFocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params, runs, restTokens } = ctx;
  const token = restTokens.join(" ").trim();
  if (!token) {
    return stopWithText("Usage: /focus <subagent-label|session-key|session-id|session-label>");
  }

  const controller = resolveCommandSubagentController(params, ctx.requesterKey);
  if (controller.controlScope !== "children") {
    return stopWithText("⚠️ Leaf subagents cannot control other sessions.");
  }

  const bindingContext = resolveFocusBindingContext(params);
  if (!bindingContext) {
    return stopWithText("⚠️ /focus must be run inside a bindable conversation.");
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  const focusTarget = await resolveFocusTargetSession({
    runs,
    token,
    requesterKey: controller.controllerSessionKey,
  });
  if (!focusTarget) {
    return stopWithText(`⚠️ Unable to resolve focus target: ${token}`);
  }

  if (bindingContext.placement === "child") {
    const spawnPolicy = resolveThreadBindingSpawnPolicy({
      cfg: params.cfg,
      channel: bindingContext.channel,
      accountId: bindingContext.accountId,
      kind: "subagent",
    });
    if (!spawnPolicy.enabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingDisabledError({
          channel: spawnPolicy.channel,
          accountId: spawnPolicy.accountId,
          kind: "subagent",
        })}`,
      );
    }
    if (bindingContext.placement === "child" && !spawnPolicy.spawnEnabled) {
      return stopWithText(
        `⚠️ ${formatThreadBindingSpawnDisabledError({
          channel: spawnPolicy.channel,
          accountId: spawnPolicy.accountId,
          kind: "subagent",
        })}`,
      );
    }
  }

  const senderId = normalizeOptionalString(params.command.senderId) ?? "";
  const conversationRef = normalizeConversationRef({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
  });
  const existingBinding = bindingService.resolveByConversation(conversationRef);
  const boundBy =
    typeof existingBinding?.metadata?.boundBy === "string"
      ? existingBinding.metadata.boundBy.trim()
      : "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return stopWithText(`⚠️ Only ${boundBy} can refocus this conversation.`);
  }

  const label = focusTarget.label || token;
  const accountId = bindingContext.accountId;
  const acpMeta =
    focusTarget.targetKind === "acp"
      ? readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: focusTarget.targetSessionKey,
        })?.acp
      : undefined;
  if (!capabilities.placements.includes(bindingContext.placement)) {
    return stopWithText("⚠️ Conversation bindings are unavailable for this account.");
  }

  let binding;
  try {
    binding = await bindingService.bind({
      targetSessionKey: focusTarget.targetSessionKey,
      targetKind: focusTarget.targetKind === "acp" ? "session" : "subagent",
      conversation: normalizeConversationRef({
        channel: bindingContext.channel,
        accountId: bindingContext.accountId,
        conversationId: bindingContext.conversationId,
        parentConversationId: bindingContext.parentConversationId,
      }),
      placement: bindingContext.placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: focusTarget.agentId,
          label,
        }),
        agentId: focusTarget.agentId,
        label,
        boundBy: senderId || "unknown",
        introText: resolveThreadBindingIntroText({
          agentId: focusTarget.agentId,
          label,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: bindingContext.channel,
            accountId,
          }),
          sessionCwd: focusTarget.targetKind === "acp" ? resolveAcpSessionCwd(acpMeta) : undefined,
          sessionDetails:
            focusTarget.targetKind === "acp"
              ? resolveAcpThreadSessionDetailLines({
                  sessionKey: focusTarget.targetSessionKey,
                  meta: acpMeta,
                })
              : [],
        }),
      },
    });
  } catch {
    return stopWithText("⚠️ Failed to bind this conversation to the target session.");
  }

  const actionText =
    bindingContext.placement === "child"
      ? `created child conversation ${binding.conversation.conversationId} and bound it to ${binding.targetSessionKey}`
      : `bound this conversation to ${binding.targetSessionKey}`;
  return stopWithText(`✅ ${actionText} (${focusTarget.targetKind}).`);
}
