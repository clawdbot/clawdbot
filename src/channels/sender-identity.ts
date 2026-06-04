/**
 * Core sender identity validation for channel contexts before plugins/tools consume them.
 * Keep this generic; channel-specific identity extraction belongs in each plugin.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "./chat-type.js";

/** Validates trusted sender identity fields before channel contexts reach plugins/tools. */
export function validateSenderIdentity(ctx: MsgContext): string[] {
  const issues: string[] = [];

  const chatType = normalizeChatType(ctx.ChatType);
  const isDirect = chatType === "direct";

  const senderId = normalizeOptionalString(ctx.SenderId) || "";
  const senderName = normalizeOptionalString(ctx.SenderName) || "";
  const senderUsername = normalizeOptionalString(ctx.SenderUsername) || "";
  const senderE164 = normalizeOptionalString(ctx.SenderE164) || "";

  if (!isDirect) {
    // Group/channel messages need an actor identity distinct from the conversation target;
    // direct chats can derive the actor from the peer route.
    if (!senderId && !senderName && !senderUsername && !senderE164) {
      issues.push("missing sender identity (SenderId/SenderName/SenderUsername/SenderE164)");
    }
  }

  if (senderE164) {
    // Keep E.164 canonical here so access-group matching does not compare mixed phone formats.
    if (!/^\+\d{3,}$/.test(senderE164)) {
      issues.push(`invalid SenderE164: ${senderE164}`);
    }
  }

  if (senderUsername) {
    // Usernames are handle tokens, not display names or @mentions.
    if (senderUsername.includes("@")) {
      issues.push(`SenderUsername should not include "@": ${senderUsername}`);
    }
    if (/\s/.test(senderUsername)) {
      issues.push(`SenderUsername should not include whitespace: ${senderUsername}`);
    }
  }

  if (ctx.SenderId != null && !senderId) {
    issues.push("SenderId is set but empty");
  }

  return issues;
}
