/**
 * Gateway loop for polling ClickClack backlog events, opening the realtime
 * websocket, and dispatching user messages into OpenClaw.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RawData } from "ws";
import { resolveClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
import { createClickClackClient, normalizeClickClackCorrelationId } from "./http-client.js";
import { handleClickClackInbound } from "./inbound.js";
import { resolveWorkspaceId } from "./resolve.js";
import type {
  ClickClackEvent,
  ClickClackMessage,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const CLICKCLACK_EVENT_PAGE_LIMIT = 500;

function payloadString(event: ClickClackEvent, key: string): string {
  const value = event.payload?.[key];
  return typeof value === "string" ? value : "";
}

function eventCorrelationId(event: ClickClackEvent): string | undefined {
  return normalizeClickClackCorrelationId(event.payload?.correlation_id);
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
    // ClickClack event payloads carry ids and cursors; fetch a narrow window
    // around the sequence so the message body/author fields stay authoritative.
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

function parseSocketEvent(data: RawData): ClickClackEvent | null {
  try {
    return JSON.parse(decodeSocketMessage(data)) as ClickClackEvent;
  } catch {
    return null;
  }
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
  const correlationId = eventCorrelationId(params.event);
  // The event body is only a routing hint. Re-fetch the authoritative message
  // under the same safe correlation id before dispatching any model work.
  const messageClient = correlationId
    ? createClickClackClient({
        baseUrl: params.account.baseUrl,
        token: params.account.token,
        correlationId,
      })
    : params.client;
  const message = await resolveEventMessage({ client: messageClient, event: params.event });
  if (!message || message.author_id === params.botUserId) {
    return;
  }
  if (message.author?.kind === "bot") {
    return;
  }
  const access = await resolveClickClackInboundAccess({
    account: params.account,
    config: params.config,
    message,
  });
  if (!access.shouldDispatch) {
    return;
  }
  await handleClickClackInbound({
    account: params.account,
    config: params.config,
    message,
    access,
    ...(correlationId ? { correlationId } : {}),
  });
}

async function drainEventBacklog(params: {
  client: ReturnType<typeof createClickClackClient>;
  workspaceId: string;
  afterCursor: string;
  abortSignal: AbortSignal;
  onEvent: (event: ClickClackEvent) => Promise<void>;
}): Promise<string> {
  let afterCursor = params.afterCursor;
  while (!params.abortSignal.aborted) {
    const page = await params.client.eventPage(params.workspaceId, {
      afterCursor,
      limit: CLICKCLACK_EVENT_PAGE_LIMIT,
    });
    const events = page.events;
    for (const event of events) {
      if (params.abortSignal.aborted) {
        return afterCursor;
      }
      if (!event.cursor || event.cursor === afterCursor) {
        throw new Error("ClickClack event backlog returned a non-advancing cursor");
      }
      await params.onEvent(event);
      afterCursor = event.cursor;
    }
    if (events.length === 0) {
      return afterCursor;
    }
  }
  return afterCursor;
}

export async function startClickClackGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedClickClackAccount>,
) {
  const configuredAccount = resolveClickClackAccount({
    cfg: ctx.cfg,
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
  try {
    while (!ctx.abortSignal.aborted) {
      if (!initialized) {
        const page = await client.eventPage(workspaceId, { includeTail: true });
        // Newer servers capture this cursor before listing the page, so events
        // created during startup remain eligible for websocket delivery.
        if (page.tailCursor !== undefined) {
          afterCursor = page.tailCursor;
        } else {
          // Older servers omit tail_cursor; preserve the shipped one-page
          // startup behavior instead of extending the history-skip window.
          for (const event of page.events) {
            afterCursor = event.cursor || afterCursor;
          }
        }
        initialized = true;
      } else {
        afterCursor = await drainEventBacklog({
          client,
          workspaceId,
          afterCursor,
          abortSignal: ctx.abortSignal,
          onEvent: async (event) => {
            await processEvent({
              account,
              config: ctx.cfg,
              client,
              event,
              botUserId: account.botUserId,
            });
          },
        });
      }
      if (ctx.abortSignal.aborted) {
        break;
      }
      const socket = client.websocket(workspaceId, afterCursor);
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let removeAbortListener: (() => void) | undefined;
        const finishSocketCycle = () => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener?.();
          removeAbortListener = undefined;
          resolve();
        };
        const abort = () => {
          socket.close();
          finishSocketCycle();
        };
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.abortSignal.removeEventListener("abort", abort);
        socket.on("message", (data) => {
          void (async () => {
            const event = parseSocketEvent(data);
            if (!event) {
              ctx.log?.warn?.(
                `[${account.accountId}] skipped malformed ClickClack websocket event`,
              );
              return;
            }
            afterCursor = event.cursor || afterCursor;
            await processEvent({
              account,
              config: ctx.cfg,
              client,
              event,
              botUserId: account.botUserId ?? "",
            });
          })().catch((e: unknown) =>
            reject(
              e instanceof Error
                ? e
                : new Error(`ClickClack ws message failed: ${formatErrorMessage(e)}`, {
                    cause: e,
                  }),
            ),
          );
        });
        socket.on("close", finishSocketCycle);
        socket.on("error", (error) => {
          if (settled || ctx.abortSignal.aborted) {
            finishSocketCycle();
            return;
          }
          ctx.log?.warn?.(
            `[${account.accountId}] ClickClack websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          finishSocketCycle();
          socket.close();
        });
      });
      if (!ctx.abortSignal.aborted) {
        await new Promise((resolve) => {
          setTimeout(resolve, account.reconnectMs);
        });
      }
    }
  } finally {
    ctx.setStatus({ accountId: account.accountId, running: false });
  }
}
