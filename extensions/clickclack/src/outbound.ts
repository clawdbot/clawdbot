import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { resolveChannelId, resolveWorkspaceId } from "./resolve.js";
import { parseClickClackTarget } from "./target.js";
import type { CoreConfig } from "./types.js";

export async function sendClickClackText(params: {
  cfg: CoreConfig;
  accountId?: string | null;
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}) {
  const account = resolveClickClackAccount({ cfg: params.cfg, accountId: params.accountId });
  const client = createClickClackClient({ baseUrl: account.baseUrl, token: account.token });
  const workspaceId = await resolveWorkspaceId(client, account.workspace);
  const parsed = parseClickClackTarget(params.to);
  const explicitThreadId = params.threadId == null ? "" : String(params.threadId);
  const replyToId = params.replyToId == null ? "" : String(params.replyToId);
  if (explicitThreadId || replyToId || parsed.kind === "thread") {
    const rootId = explicitThreadId || replyToId || parsed.id;
    const message = await client.createThreadReply(rootId, params.text);
    return { to: params.to, messageId: message.id };
  }
  if (parsed.kind === "dm") {
    const dm = await client.createDirectConversation(workspaceId, [parsed.id]);
    const message = await client.createDirectMessage(dm.id, params.text);
    return { to: params.to, messageId: message.id };
  }
  const channelId = await resolveChannelId(client, workspaceId, parsed.id);
  const message = await client.createChannelMessage(channelId, params.text);
  return { to: params.to, messageId: message.id };
}
