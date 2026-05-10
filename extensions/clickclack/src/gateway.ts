import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { RawData } from "ws";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient } from "./http-client.js";
import { handleClickClackInbound } from "./inbound.js";
import { resolveWorkspaceId } from "./resolve.js";
import type {
  ClickClackEvent,
  ClickClackMessage,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

function payloadString(event: ClickClackEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : "";
}

async function resolveEventMessage(params: {
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
}): Promise<ClickClackMessage | null> {
  const messageId = payloadString(params.event, "message_id");
  if (!messageId) {
    return null;
  }
  const directConversationId = payloadString(params.event, "direct_conversation_id");
  if (directConversationId && typeof params.event.seq === "number") {
    const messages = await params.client.directMessages(
      directConversationId,
      params.event.seq - 1,
      10,
    );
    return messages.find((message) => message.id === messageId) ?? null;
  }
  if (params.event.type === "thread.reply_created") {
    const rootId = payloadString(params.event, "root_message_id");
    if (!rootId) {
      return null;
    }
    const thread = await params.client.thread(rootId);
    return thread.replies.find((message) => message.id === messageId) ?? null;
  }
  if (params.event.channel_id && typeof params.event.seq === "number") {
    const messages = await params.client.channelMessages(
      params.event.channel_id,
      params.event.seq - 1,
      10,
    );
    return messages.find((message) => message.id === messageId) ?? null;
  }
  return null;
}

function decodeSocketMessage(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

async function processEvent(params: {
  account: ResolvedClickClackAccount;
  config: CoreConfig;
  client: ReturnType<typeof createClickClackClient>;
  event: ClickClackEvent;
  botUserId: string;
}) {
  if (params.event.type !== "message.created" && params.event.type !== "thread.reply_created") {
    return;
  }
  if (payloadString(params.event, "author_id") === params.botUserId) {
    return;
  }
  const message = await resolveEventMessage({ client: params.client, event: params.event });
  if (!message || message.author_id === params.botUserId) {
    return;
  }
  if (message.author?.kind === "bot") {
    return;
  }
  await handleClickClackInbound({ account: params.account, config: params.config, message });
}

export async function startClickClackGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedClickClackAccount>,
) {
  const configuredAccount = resolveClickClackAccount({
    cfg: ctx.cfg as CoreConfig,
    accountId: ctx.account.accountId,
  });
  if (!configuredAccount.configured) {
    throw new Error(`ClickClack is not configured for account "${configuredAccount.accountId}"`);
  }
  const client = createClickClackClient({
    baseUrl: configuredAccount.baseUrl,
    token: configuredAccount.token,
  });
  const workspaceId = await resolveWorkspaceId(client, configuredAccount.workspace);
  const me = await client.me();
  const account = {
    ...configuredAccount,
    workspace: workspaceId,
    botUserId: configuredAccount.botUserId ?? me.id,
  };
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
    enabled: account.enabled,
    baseUrl: account.baseUrl,
  });
  let afterCursor = "";
  let initialized = false;
  while (!ctx.abortSignal.aborted) {
    const backlog = await client.events(workspaceId, afterCursor);
    if (!initialized) {
      for (const event of backlog) {
        afterCursor = event.cursor || afterCursor;
      }
      initialized = true;
    } else {
      for (const event of backlog) {
        afterCursor = event.cursor || afterCursor;
        await processEvent({
          account,
          config: ctx.cfg as CoreConfig,
          client,
          event,
          botUserId: account.botUserId,
        });
      }
    }
    const socket = client.websocket(workspaceId, afterCursor);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        socket.close();
        resolve();
      };
      ctx.abortSignal.addEventListener("abort", abort, { once: true });
      socket.on("message", (data) => {
        void (async () => {
          const event = JSON.parse(decodeSocketMessage(data)) as ClickClackEvent;
          afterCursor = event.cursor || afterCursor;
          await processEvent({
            account,
            config: ctx.cfg as CoreConfig,
            client,
            event,
            botUserId: account.botUserId ?? "",
          });
        })().catch(reject);
      });
      socket.on("close", () => {
        ctx.abortSignal.removeEventListener("abort", abort);
        resolve();
      });
      socket.on("error", reject);
    });
    if (!ctx.abortSignal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, account.reconnectMs));
    }
  }
  ctx.setStatus({ accountId: account.accountId, running: false });
}
