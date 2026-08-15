/**
 * Gateway loop for polling ClickClack backlog events, opening the realtime
 * websocket, and dispatching user messages into OpenClaw.
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { RawData } from "ws";
import { resolveClickClackInboundAccess } from "./access.js";
import { resolveClickClackAccount } from "./accounts.js";
import { syncClickClackCommandMenu } from "./command-menu.js";
import {
  ClickClackHttpError,
  createClickClackClient,
  normalizeClickClackCorrelationId,
} from "./http-client.js";
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
  return readStringField(event.payload, key) ?? "";
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
  try {
    return await params.client.message(messageId);
  } catch (error) {
    if (error instanceof ClickClackHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function parseSocketEvent(data: RawData): ClickClackEvent | null {
  try {
    return JSON.parse(rawDataToString(data)) as ClickClackEvent;
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
  buildContext?: typeof buildChannelInboundEventContext;
  log?: { info: (message: string) => void; warn?: (message: string) => void };
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
        baseUrl: params.account.apiEndpoint,
        token: params.account.token,
        correlationId,
      })
    : params.client;
  const message = await resolveEventMessage({ client: messageClient, event: params.event });
  if (!message) {
    params.log?.warn?.(
      `[${params.account.accountId}] skipped unreadable ClickClack message before agent dispatch: ` +
        `type=${params.event.type} messageId=${payloadString(params.event, "message_id") || "unknown"}`,
    );
    return;
  }
  if (message.author_id === params.botUserId) {
    return;
  }
  const access = await resolveClickClackInboundAccess({
    account: params.account,
    config: params.config,
    message,
  });
  if (!access.shouldDispatch) {
    params.log?.info(
      `[${params.account.accountId}] skipped ClickClack message before agent dispatch: ` +
        `kind=${message.direct_conversation_id ? "dm" : "group"} ` +
        `requireMention=${access.requireMention ?? "unknown"} ` +
        `wasMentioned=${access.mentionFacts.wasMentioned} ` +
        `hasAnyMention=${access.mentionFacts.hasAnyMention ?? "unknown"} ` +
        `commandAuthorized=${access.commandAuthorized}`,
    );
    return;
  }
  await handleClickClackInbound({
    account: params.account,
    config: params.config,
    message,
    access,
    buildContext: params.buildContext,
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
    baseUrl: configuredAccount.apiEndpoint,
    token: configuredAccount.token,
  });
  const workspaceId = await resolveWorkspaceId(client, configuredAccount.workspace);
  const me = await client.me();
  const account = {
    ...configuredAccount,
    workspace: workspaceId,
    botUserId: configuredAccount.botUserId ?? me.id,
    botHandle: me.handle,
  };
  const processIncomingEvent = (event: ClickClackEvent) =>
    processEvent({
      account,
      config: ctx.cfg,
      client,
      event,
      botUserId: account.botUserId,
      buildContext: (ctx.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound
        .buildContext,
      log: ctx.log,
    });
  if (account.commandMenu) {
    await syncClickClackCommandMenu({ cfg: ctx.cfg, client, log: ctx.log });
  }
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    lifecycle: "starting",
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
          onEvent: processIncomingEvent,
        });
      }
      if (ctx.abortSignal.aborted) {
        break;
      }
      const socket = client.websocket(workspaceId, afterCursor);
      await new Promise<void>((resolve) => {
        let settled = false;
        let closing = false;
        let loggedMessageFailure = false;
        let messageQueue = Promise.resolve();
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
        const finishAfterQueuedMessages = () => {
          // The queue is scoped to this account/socket. Waiting here preserves
          // its contiguous cursor without blocking unrelated account streams.
          void messageQueue.then(
            () => finishSocketCycle(),
            () => finishSocketCycle(),
          );
        };
        const reconnectAfterMessageFailure = (error: unknown) => {
          if (settled || ctx.abortSignal.aborted) {
            return;
          }
          if (!loggedMessageFailure) {
            loggedMessageFailure = true;
            ctx.log?.warn?.(
              `[${account.accountId}] ClickClack event processing failed; reconnecting: ${
                error instanceof Error ? error.message : formatErrorMessage(error)
              }`,
            );
          }
          if (!closing) {
            // Keep the last successful cursor. Reconnect backlog will replay
            // this event; a repeated failure there remains a surfaced error.
            closing = true;
            socket.close();
          }
        };
        const abort = () => {
          socket.close();
          finishSocketCycle();
        };
        ctx.abortSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.abortSignal.removeEventListener("abort", abort);
        socket.on("open", () => {
          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
        });
        socket.on("message", (data) => {
          if (closing || settled) {
            return;
          }
          // Preserve server event order and commit each cursor only after its
          // handler succeeds, so reconnect backlog can retry a failed event.
          messageQueue = messageQueue.then(async () => {
            const event = parseSocketEvent(data);
            if (!event) {
              ctx.log?.warn?.(
                `[${account.accountId}] skipped malformed ClickClack websocket event`,
              );
              return;
            }
            await processIncomingEvent(event);
            afterCursor = event.cursor || afterCursor;
          });
          void messageQueue.catch(reconnectAfterMessageFailure);
        });
        socket.on("close", () => {
          closing = true;
          if (!ctx.abortSignal.aborted) {
            ctx.setStatus({
              accountId: account.accountId,
              connected: false,
              lifecycle: "recovering",
            });
          }
          finishAfterQueuedMessages();
        });
        socket.on("error", (error) => {
          if (settled || ctx.abortSignal.aborted) {
            finishSocketCycle();
            return;
          }
          if (closing) {
            return;
          }
          ctx.log?.warn?.(
            `[${account.accountId}] ClickClack websocket error; reconnecting: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          ctx.setStatus({
            accountId: account.accountId,
            connected: false,
            lifecycle: "recovering",
            lastError: error instanceof Error ? error.message : String(error),
          });
          closing = true;
          socket.close();
        });
      });
      if (!ctx.abortSignal.aborted) {
        try {
          // The gateway abort owns both the active socket and its reconnect delay;
          // otherwise shutdown can remain pending for the full configured backoff.
          await sleepWithAbort(account.reconnectMs, ctx.abortSignal);
        } catch (error) {
          if (!ctx.abortSignal.aborted) {
            throw error;
          }
        }
      }
    }
  } finally {
    ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
  }
}
