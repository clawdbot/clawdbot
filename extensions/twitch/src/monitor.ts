/**
 * Twitch message monitor - processes incoming messages and routes to agents.
 *
 * This monitor connects to the Twitch client manager, processes incoming messages,
 * resolves agent routes, and handles replies.
 */

import type { ReplyPayload, MoltbotConfig } from "clawdbot/plugin-sdk";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";
import { checkTwitchAccessControl } from "./access-control.js";
import { getTwitchRuntime } from "./runtime.js";
import { getOrCreateClientManager } from "./client-manager-registry.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";

export type TwitchRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type TwitchMonitorOptions = {
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown; // MoltbotConfig
  runtime: TwitchRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

export type TwitchMonitorResult = {
  stop: () => void;
};

type TwitchCoreRuntime = ReturnType<typeof getTwitchRuntime>;

/**
 * Process an incoming Twitch message and dispatch to agent.
 */
async function processTwitchMessage(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown;
  runtime: TwitchRuntimeEnv;
  core: TwitchCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, accountId, config, runtime, core, statusSink } = params;
  const cfg = config as MoltbotConfig;

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "twitch",
    accountId,
    peer: {
      kind: "group", // Twitch chat is always group-like
      id: message.channel,
    },
  });

  const rawBody = message.message;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Twitch",
    from: message.displayName ?? message.username,
    timestamp: message.timestamp?.getTime(),
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `twitch:user:${message.userId}`,
    To: `twitch:channel:${message.channel}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: message.channel,
    SenderName: message.displayName ?? message.username,
    SenderId: message.userId,
    SenderUsername: message.username,
    Provider: "twitch",
    Surface: "twitch",
    MessageSid: message.id,
    OriginatingChannel: "twitch",
    OriginatingTo: `twitch:channel:${message.channel}`,
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`Failed updating session meta: ${String(err)}`);
    },
  });

  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "twitch",
    accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverTwitchReply({
          payload,
          channel: message.channel,
          account,
          accountId,
          config,
          tableMode,
          runtime,
          statusSink,
        });
      },
    },
  });
}

/**
 * Deliver a reply to Twitch chat.
 */
async function deliverTwitchReply(params: {
  payload: ReplyPayload;
  channel: string;
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown;
  tableMode: "off" | "plain" | "markdown" | "bullets" | "code";
  runtime: TwitchRuntimeEnv;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, channel, account, accountId, config, tableMode, runtime, statusSink } = params;

  try {
    const clientManager = getOrCreateClientManager(accountId, {
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
      error: (msg) => runtime.error?.(msg),
      debug: (msg) => runtime.log?.(msg),
    });

    const client = await clientManager.getClient(
      account,
      config as Parameters<typeof clientManager.getClient>[1],
      accountId,
    );
    if (!client) {
      runtime.error?.(`No client available for sending reply`);
      return;
    }

    // Send the reply
    if (!payload.text) {
      runtime.error?.(`No text to send in reply payload`);
      return;
    }

    const textToSend = stripMarkdownForTwitch(payload.text);

    await client.say(channel, textToSend);
    statusSink?.({ lastOutboundAt: Date.now() });
  } catch (err) {
    runtime.error?.(`Failed to send reply: ${String(err)}`);
  }
}

/**
 * Main monitor provider for Twitch.
 *
 * Sets up message handlers and processes incoming messages.
 */
export async function monitorTwitchProvider(
  options: TwitchMonitorOptions,
): Promise<TwitchMonitorResult> {
  const { account, accountId, config, runtime, abortSignal, statusSink } = options;

  const core = getTwitchRuntime();
  let stopped = false;

  const coreLogger = core.logging.getChildLogger({ module: "twitch" });
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) return;
    coreLogger.debug?.(message);
  };
  const logger = {
    info: (msg: string) => coreLogger.info(msg),
    warn: (msg: string) => coreLogger.warn(msg),
    error: (msg: string) => coreLogger.error(msg),
    debug: logVerboseMessage,
  };

  const clientManager = getOrCreateClientManager(accountId, logger);

  try {
    await clientManager.getClient(
      account,
      config as Parameters<typeof clientManager.getClient>[1],
      accountId,
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.error?.(`Failed to connect: ${errorMsg}`);
    throw error;
  }

  const unregisterHandler = clientManager.onMessage(account, (message) => {
    if (stopped) return;

    // Access control check
    const botUsername = account.username.toLowerCase();
    if (message.username.toLowerCase() === botUsername) {
      return; // Ignore own messages
    }

    const access = checkTwitchAccessControl({
      message,
      account,
      botUsername,
    });

    if (!access.allowed) {
      return;
    }

    statusSink?.({ lastInboundAt: Date.now() });

    // Fire-and-forget: process message without blocking
    void processTwitchMessage({
      message,
      account,
      accountId,
      config,
      runtime,
      core,
      statusSink,
    }).catch((err) => {
      runtime.error?.(`Message processing failed: ${String(err)}`);
    });
  });

  const stop = () => {
    stopped = true;
    unregisterHandler();
  };

  abortSignal.addEventListener("abort", stop, { once: true });

  return { stop };
}
