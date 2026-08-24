// Clears active subagent focus for a session or scoped target.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationRef } from "../../../infra/outbound/session-binding-normalization.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult } from "../commands-types.js";
import { resolveConversationBindingContextFromAcpCommand } from "../conversation-binding-input.js";
import type { SubagentsCommandContext } from "./shared.js";

export async function handleSubagentsUnfocusAction(
  ctx: SubagentsCommandContext,
): Promise<CommandHandlerResult> {
  const { params } = ctx;
  const bindingService = getSessionBindingService();
  const bindingContext = resolveConversationBindingContextFromAcpCommand(params);
  if (!bindingContext) {
    return commandReply("⚠️ /unfocus must be run inside a focused conversation.");
  }

  const binding = bindingService.resolveByConversation(
    normalizeConversationRef({
      channel: bindingContext.channel,
      accountId: bindingContext.accountId,
      conversationId: bindingContext.conversationId,
      parentConversationId: bindingContext.parentConversationId,
    }),
  );
  if (!binding) {
    return commandReply("ℹ️ This conversation is not currently focused.");
  }

  const senderId = normalizeOptionalString(params.command.senderId) ?? "";
  const boundBy = normalizeOptionalString(binding.metadata?.boundBy) ?? "";
  if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    return commandReply(`⚠️ Only ${boundBy} can unfocus this conversation.`);
  }

  await bindingService.unbind({
    bindingId: binding.bindingId,
    reason: "manual",
  });
  return commandReply("✅ Conversation unfocused.");
}
