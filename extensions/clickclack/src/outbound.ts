/**
 * Outbound ClickClack delivery helpers for channel messages, thread replies,
 * and direct messages.
 */
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { ClickClackMessageProvenance, CoreConfig } from "./types.js";

/**
 * Sends visible text to a normalized ClickClack target and returns the created
 * message id, or undefined when sanitization removes all content.
 */
export async function sendClickClackText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
  /** Safe request correlation inherited from an inbound ClickClack event. */
  correlationId?: string;
  /** Optional model/thinking attribution stamped onto the created message. */
  provenance?: ClickClackMessageProvenance;
}): Promise<string | undefined> {
  // Custom inbound replies bypass shared outbound normalization, so this private
  // sender owns ClickClack assistant-text sanitization for every delivery path.
  const text = sanitizeAssistantVisibleText(params.text);
  if (!text) {
    return undefined;
  }
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createClickClackClient({
    baseUrl: account.baseUrl,
    token: account.token,
    correlationId: params.correlationId,
  });
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || parsed.kind === "thread") {
    // Genuine thread context (the inbound message already lived in a thread, or
    // the target explicitly names a thread) stays in that thread. A bare reply to
    // a top-level message must NOT open a new thread — see the quote-reply paths
    // below — otherwise every channel reply spawns its own thread and the main
    // timeline goes silent.
    const rootId = explicitThreadId || parsed.id;
    const message = await client.createThreadReply(rootId, text, {
      provenance: params.provenance,
    });
    return message.id;
  }
  if (parsed.kind === "dm") {
    const dm = await client.createDirectConversation(workspaceId, [parsed.id]);
    const message = await client.createDirectMessage(dm.id, text, {
      quotedMessageId: replyToId || undefined,
    });
    return message.id;
  }
  const channelId = await resolveChannelId(client, workspaceId, parsed.id);
  // A reply to a top-level channel message is delivered to the main channel as a
  // quote-reply (quoted_message_id), matching the reply-to affordance of the
  // Discord/Slack/Telegram channels, instead of opening a per-reply thread.
  const message = await client.createChannelMessage(channelId, text, {
    provenance: params.provenance,
    quotedMessageId: replyToId || undefined,
  });
  return message.id;
}
