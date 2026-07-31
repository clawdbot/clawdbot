// Irc plugin module implements monitor behavior.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveIrcAccount } from "./accounts.js";
import { connectIrcClient, type IrcClient } from "./client.js";
import { buildIrcConnectOptions } from "./connect-options.js";
import { handleIrcInbound } from "./inbound.js";
import {
  createIrcIngressMonitor,
  type IrcIngressLifecycle,
  type IrcIngressMonitor,
} from "./irc-ingress.js";
import type { RuntimeEnv } from "./runtime-api.js";
import { getIrcRuntime } from "./runtime.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

type IrcMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onMessage?: (message: IrcInboundMessage, client: IrcClient) => void | Promise<void>;
  ingressQueue?: NonNullable<Parameters<typeof createIrcIngressMonitor>[0]["queue"]>;
};

const IRC_MONITOR_RECONNECT_DELAY_MS = 1000;

export async function monitorIrcProvider(
  opts: IrcMonitorOptions,
): Promise<{ stop: () => Promise<void> }> {
  const core = getIrcRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveIrcAccount({
    cfg,
    accountId: opts.accountId,
  });

  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.configured) {
    throw new Error(
      `IRC is not configured for account "${account.accountId}" (need host and nick in channels.irc).`,
    );
  }

  const logger = core.logging.getChildLogger({
    channel: "irc",
    accountId: account.accountId,
  });

  let client: IrcClient | null = null;
  let activeConnectionEpoch: string | null = null;
  let ingressPause: Promise<void> = Promise.resolve();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const monitorAbort = new AbortController();
  let removeAbortListener: (() => void) | null = null;
  if (opts.abortSignal) {
    const forwardAbort = () => monitorAbort.abort();
    if (opts.abortSignal.aborted) {
      forwardAbort();
    } else {
      opts.abortSignal.addEventListener("abort", forwardAbort, { once: true });
      removeAbortListener = () => opts.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  const ingress: IrcIngressMonitor = createIrcIngressMonitor({
    accountId: account.accountId,
    runtime,
    ...(opts.ingressQueue ? { queue: opts.ingressQueue } : {}),
    dispatch: async (
      message,
      turnAdoptionLifecycle: IrcIngressLifecycle,
      context: { connectedNick: string; connectionEpoch: string },
    ) => {
      const activeClient = client;
      if (!activeClient || stopped || monitorAbort.signal.aborted) {
        return {
          kind: "failed-retryable",
          error: new Error("IRC transport disconnected before ingress dispatch."),
        };
      }
      if (
        normalizeLowercaseStringOrEmpty(message.senderNick) ===
        normalizeLowercaseStringOrEmpty(context.connectedNick)
      ) {
        return { kind: "completed" };
      }
      // IRC nicknames can change owners between connections. Channel replay is
      // safe, but a stale DM recipient cannot be revalidated after reconnect.
      if (!message.isGroup && context.connectionEpoch !== activeConnectionEpoch) {
        logger.warn?.(
          `[${account.accountId}] dropping replayed IRC DM after the connection changed`,
        );
        return { kind: "completed" };
      }
      if (opts.onMessage) {
        await opts.onMessage(message, activeClient);
        return { kind: "completed" };
      }
      return await handleIrcInbound({
        message,
        account,
        config: cfg,
        runtime,
        connectedNick: context.connectedNick,
        turnAdoptionLifecycle,
        sendReply: async (target, text) => {
          const replyClient = client;
          if (!replyClient || !replyClient.isReady() || stopped || monitorAbort.signal.aborted) {
            throw new Error("IRC transport disconnected before reply send.");
          }
          if (!message.isGroup && context.connectionEpoch !== activeConnectionEpoch) {
            throw new Error("IRC connection changed before private reply send.");
          }
          replyClient.sendPrivmsg(target, text);
          opts.statusSink?.({ lastOutboundAt: Date.now() });
          core.channel.activity.record({
            channel: "irc",
            accountId: account.accountId,
            direction: "outbound",
          });
        },
        statusSink: opts.statusSink,
      });
    },
  });

  function scheduleReconnect() {
    if (stopped || monitorAbort.signal.aborted || reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch((error: unknown) => {
        if (stopped || monitorAbort.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[${account.accountId}] IRC reconnect failed: ${message}`);
        scheduleReconnect();
      });
    }, IRC_MONITOR_RECONNECT_DELAY_MS);
  }

  async function connect() {
    if (stopped || monitorAbort.signal.aborted) {
      return;
    }
    const ingressConnection = ingress.openConnection();
    const nextClient = await connectIrcClient(
      buildIrcConnectOptions(account, {
        channels: account.config.channels,
        abortSignal: monitorAbort.signal,
        onLine: (line) => {
          if (core.logging.shouldLogVerbose()) {
            logger.debug?.(`[${account.accountId}] << ${line}`);
          }
        },
        onNotice: (text, target) => {
          if (core.logging.shouldLogVerbose()) {
            logger.debug?.(`[${account.accountId}] notice ${target ?? ""}: ${text}`);
          }
        },
        onError: (error) => {
          logger.error(`[${account.accountId}] IRC error: ${error.message}`);
        },
        onDisconnect: () => {
          if (stopped || monitorAbort.signal.aborted) {
            return;
          }
          ingressPause = ingress.pause();
          if (activeConnectionEpoch === ingressConnection.connectionEpoch) {
            activeConnectionEpoch = null;
          }
          client = null;
          logger.warn?.(
            `[${account.accountId}] IRC connection closed; reconnecting in ${IRC_MONITOR_RECONNECT_DELAY_MS}ms`,
          );
          scheduleReconnect();
        },
        onPrivmsg: async (event) => {
          await ingressConnection.accept(event.rawLine, event.connectedNick);
          if (
            normalizeLowercaseStringOrEmpty(event.senderNick) ===
            normalizeLowercaseStringOrEmpty(event.connectedNick)
          ) {
            return;
          }
          core.channel.activity.record({
            channel: "irc",
            accountId: account.accountId,
            direction: "inbound",
            at: Date.now(),
          });
        },
      }),
    );
    if (stopped || monitorAbort.signal.aborted) {
      nextClient.quit("shutdown");
      return;
    }
    client = nextClient;
    activeConnectionEpoch = ingressConnection.connectionEpoch;
    await ingressPause;
    if (client !== nextClient || !nextClient.isReady()) {
      if (activeConnectionEpoch === ingressConnection.connectionEpoch) {
        activeConnectionEpoch = null;
      }
      return;
    }
    ingress.start();

    logger.info(
      `[${account.accountId}] connected to ${account.host}:${account.port}${account.tls ? " (tls)" : ""} as ${nextClient.nick}`,
    );
  }

  try {
    await connect();
  } catch (error) {
    removeAbortListener?.();
    removeAbortListener = null;
    await ingress.stop();
    throw error;
  }

  let stopTask: Promise<void> | undefined;
  return {
    stop: () => {
      stopTask ??= (async () => {
        stopped = true;
        removeAbortListener?.();
        removeAbortListener = null;
        if (!monitorAbort.signal.aborted) {
          monitorAbort.abort();
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        client?.quit("shutdown");
        client = null;
        activeConnectionEpoch = null;
        await ingress.stop();
      })();
      return stopTask;
    },
  };
}
