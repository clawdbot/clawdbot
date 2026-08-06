/**
 * Outbound ClickClack delivery helpers for channel messages, thread replies,
 * and direct messages.
 */
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

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
}): Promise<string | undefined> {
  const text = sanitizeAssistantVisibleText(params.text);
  if (!text) {
    return undefined;
  }
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createClickClackClient({ baseUrl: account.baseUrl, token: account.token });
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || parsed.kind === "thread") {
    // Explicit thread/reply context wins over the target kind so OpenClaw reply
    // hooks keep conversations attached to the original ClickClack root.
    const rootId = explicitThreadId || parsed.id;
    const message = await client.createThreadReply(rootId, text);
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
  const message = await client.createChannelMessage(channelId, text, {
    quotedMessageId: replyToId || undefined,
  });
  return message.id;
}
