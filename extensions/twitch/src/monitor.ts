/**
 * Twitch message monitor - processes incoming messages and routes to agents.
 *
 * This monitor connects to the Twitch client manager, processes incoming messages,
 * resolves agent routes, and handles replies.
 */

import { createChannelInboundEnvelopeBuilder } from "openclaw/plugin-sdk/channel-inbound";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { checkTwitchAccessControl } from "./access-control.js";
import { getOrCreateClientManager } from "./client-manager-registry.js";
import { getTwitchRuntime } from "./runtime.js";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";

type TwitchRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type TwitchMonitorOptions = {
  account: TwitchAccountConfig;
  accountId: string;
  config: unknown; // OpenClawConfig
  runtime: TwitchRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type TwitchMonitorResult = {
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
  const cfg = config as OpenClawConfig;

  await core.channel.inbound.run({
    channel: "twitch",
    accountId,
    raw: message,
    adapter: {
      ingest: (incoming) => ({
        id: incoming.id ?? `${incoming.channel}:${incoming.timestamp?.getTime() ?? Date.now()}`,
        timestamp: incoming.timestamp?.getTime(),
        rawText: incoming.message,
        textForAgent: incoming.message,
        textForCommands: incoming.message,
        raw: incoming,
      }),
      resolveTurn: async (input) => {
        const route = core.channel.routing.resolveAgentRoute({
          cfg,
          channel: "twitch",
          accountId,
          peer: {
            kind: "group",
            id: message.channel,
          },
        });
        const senderId = message.userId ?? message.username;
        const fromLabel = message.displayName ?? message.username;
        const body = createChannelInboundEnvelopeBuilder({ cfg, route })({
          channel: "Twitch",
          from: fromLabel,
          timestamp: input.timestamp,
          body: input.rawText,
        });
        const ctxPayload = core.channel.inbound.buildContext({
          channel: "twitch",
          accountId,
          messageId: input.id,
          timestamp: input.timestamp,
          from: `twitch:user:${senderId}`,
          sender: {
            id: senderId,
            name: fromLabel,
            username: message.username,
          },
          conversation: {
            kind: "group",
            id: message.channel,
            label: message.channel,
          },
          route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
          },
          reply: {
            to: `twitch:channel:${message.channel}`,
          },
          message: {
            body,
            rawBody: input.rawText,
            bodyForAgent: input.textForAgent,
            commandBody: input.textForCommands,
          },
        });
        const tableMode = core.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "twitch",
          accountId,
        });
        return {
          cfg,
          channel: "twitch",
          accountId,
          route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
          ctxPayload,
          delivery: {
            durable: () => ({
              to: `twitch:channel:${message.channel}`,
            }),
            deliver: async (payload) => {
              return await deliverTwitchReply({
                payload,
                channel: message.channel,
                account,
                accountId,
                config,
                tableMode,
                runtime,
              });
            },
            onDelivered: (_payload, _info, result) => {
              if (result?.visibleReplySent !== false) {
                statusSink?.({ lastOutboundAt: Date.now() });
              }
            },
            onError: (err, info) => {
              runtime.error?.(`Twitch ${info.kind} reply failed: ${String(err)}`);
            },
          },
          replyPipeline: {},
          record: {
            onRecordError: (err) => {
              runtime.error?.(`Failed updating session meta: ${String(err)}`);
            },
          },
        };
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
  tableMode: MarkdownTableMode;
  runtime: TwitchRuntimeEnv;
}): Promise<{ visibleReplySent: boolean }> {
  const { payload, channel, account, accountId, config, runtime } = params;

  try {
    const clientManager = getOrCreateClientManager(accountId, {
      info: (msg) => runtime.log?.(msg),
      warn: (msg) => runtime.log?.(msg),
      error: (msg) => runtime.error?.(msg),
      debug: (msg) => runtime.log?.(msg),
    });

    if (!payload.text) {
      runtime.error?.(`No text to send in reply payload`);
      return { visibleReplySent: false };
    }
    const textToSend = stripMarkdownForTwitch(payload.text);
    if (!textToSend) {
      return { visibleReplySent: false };
    }
    const result = await clientManager.sendMessage(
      account,
      channel,
      textToSend,
      config as Parameters<typeof clientManager.sendMessage>[3],
      accountId,
    );
    if (!result.ok) {
      throw new Error(result.error ?? "Send failed");
    }
    return { visibleReplySent: true };
  } catch (err) {
    runtime.error?.(`Failed to send reply: ${String(err)}`);
    return { visibleReplySent: false };
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
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
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
    const errorMsg = formatErrorMessage(error);
    runtime.error?.(`Failed to connect: ${errorMsg}`);
    throw error;
  }

  const unregisterHandler = clientManager.onMessage(account, (message) => {
    if (stopped) {
      return;
    }

    void (async () => {
      const botUsername = normalizeLowercaseStringOrEmpty(account.username);
      if (normalizeLowercaseStringOrEmpty(message.username) === botUsername) {
        return;
      }

      const access = await checkTwitchAccessControl({
        message,
        account,
        botUsername,
      });

      if (stopped || !access.allowed) {
        return;
      }

      statusSink?.({ lastInboundAt: Date.now() });

      await processTwitchMessage({
        message,
        account,
        accountId,
        config,
        runtime,
        core,
        statusSink,
      });
    })().catch((err: unknown) => {
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
