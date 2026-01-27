import { DEFAULT_GROUP_HISTORY_LIMIT } from "../../auto-reply/reply/history.js";
import { getReplyFromConfig } from "../../auto-reply/reply.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { resolveInboundDebounceMs } from "../../auto-reply/inbound-debounce.js";
import { waitForever } from "../../cli/wait.js";
import { loadConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { formatDurationMs } from "../../infra/format-duration.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import { getChildLogger } from "../../logging.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { resolveWhatsAppAccount } from "../accounts.js";
import { setActiveWebListener } from "../active-listener.js";
import { monitorWebInbox } from "../inbound.js";
import {
  computeBackoff,
  newConnectionId,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "../reconnect.js";
import { formatError, getWebAuthAgeMs, readWebSelfId } from "../session.js";
import { DEFAULT_WEB_MEDIA_BYTES } from "./constants.js";
import { whatsappHeartbeatLog, whatsappLog } from "./loggers.js";
import { buildMentionConfig } from "./mentions.js";
import { createEchoTracker } from "./monitor/echo.js";
import { createWebOnMessageHandler } from "./monitor/on-message.js";
import type { WebChannelStatus, WebInboundMsg, WebMonitorTuning } from "./types.js";
import { isLikelyWhatsAppCryptoError } from "./util.js";

export async function monitorWebChannel(
  verbose: boolean,
  listenerFactory: typeof monitorWebInbox | undefined = monitorWebInbox,
  keepAlive = true,
  replyResolver: typeof getReplyFromConfig | undefined = getReplyFromConfig,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const heartbeatLogger = getChildLogger({ module: "web-heartbeat", runId });
  const reconnectLogger = getChildLogger({ module: "web-reconnect", runId });
  const status: WebChannelStatus = {
    running: true,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
  };
  const emitStatus = () => {
    tuning.statusSink?.({
      ...status,
      lastDisconnect: status.lastDisconnect ? { ...status.lastDisconnect } : null,
    });
  };
  emitStatus();

  const baseCfg = loadConfig();
  const account = resolveWhatsAppAccount({
    cfg: baseCfg,
    accountId: tuning.accountId,
  });
  const cfg = {
    ...baseCfg,
    channels: {
      ...baseCfg.channels,
      whatsapp: {
        ...baseCfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        chunkMode: account.chunkMode,
        mediaMaxMb: account.mediaMaxMb,
        blockStreaming: account.blockStreaming,
        groups: account.groups,
      },
    },
  } satisfies ReturnType<typeof loadConfig>;

  const configuredMaxMb = cfg.agents?.defaults?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, tuning.heartbeatSeconds);
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const baseMentionConfig = buildMentionConfig(cfg);
  const groupHistoryLimit =
    cfg.channels?.whatsapp?.accounts?.[tuning.accountId ?? ""]?.historyLimit ??
    cfg.channels?.whatsapp?.historyLimit ??
    cfg.messages?.groupChat?.historyLimit ??
    DEFAULT_GROUP_HISTORY_LIMIT;
  const groupHistories = new Map<
    string,
    Array<{
      sender: string;
      body: string;
      timestamp?: number;
      id?: string;
      senderJid?: string;
    }>
  >();
  const groupMemberNames = new Map<string, Map<string, string>>();
  const echoTracker = createEchoTracker({ maxItems: 100, logVerbose });

  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) => sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  // Avoid noisy MaxListenersExceeded warnings in test environments where
  // multiple gateway instances may be constructed.
  const currentMaxListeners = process.getMaxListeners?.() ?? 10;
  if (process.setMaxListeners && currentMaxListeners < 50) {
    process.setMaxListeners(50);
  }

  let sigintStop = false;
  const handleSigint = () => {
    sigintStop = true;
  };
  process.once("SIGINT", handleSigint);

  let reconnectAttempts = 0;

  while (true) {
    if (stopRequested()) break;

    const connectionId = newConnectionId();
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let _lastInboundMsg: WebInboundMsg | null = null;
    let unregisterUnhandled: (() => void) | null = null;

    // Watchdog to detect stuck message processing (e.g., event emitter died)
    const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes without any messages
    const WATCHDOG_CHECK_MS = 60 * 1000; // Check every minute

    const backgroundTasks = new Set<Promise<unknown>>();
    const onMessage = createWebOnMessageHandler({
      cfg,
      verbose,
      connectionId,
      maxMediaBytes,
      groupHistoryLimit,
      groupHistories,
      groupMemberNames,
      echoTracker,
      backgroundTasks,
      replyResolver: replyResolver ?? getReplyFromConfig,
      replyLogger,
      baseMentionConfig,
      account,
    });

    const inboundDebounceMs = resolveInboundDebounceMs({ cfg, channel: "whatsapp" });
    const shouldDebounce = (msg: WebInboundMsg) => {
      if (msg.mediaPath || msg.mediaType) return false;
      if (msg.location) return false;
      if (msg.replyToId || msg.replyToBody) return false;
      return !hasControlCommand(msg.body, cfg);
    };

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      accountId: account.accountId,
      authDir: account.authDir,
      mediaMaxMb: account.mediaMaxMb,
      sendReadReceipts: account.sendReadReceipts,
      debounceMs: inboundDebounceMs,
      shouldDebounce,
      onMessage: async (msg: WebInboundMsg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        status.lastMessageAt = lastMessageAt;
        status.lastEventAt = lastMessageAt;
        emitStatus();
        _lastInboundMsg = msg;
        await onMessage(msg);
      },
    });

    status.connected = true;
    status.lastConnectedAt = Date.now();
    status.lastEventAt = status.lastConnectedAt;
    status.lastError = null;
    emitStatus();

    // Surface a concise connection event for the next main-session turn/heartbeat.
    const { e164: selfE164 } = readWebSelfId(account.authDir);
    const connectRoute = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      accountId: account.accountId,
    });
    enqueueSystemEvent(`WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`, {
      sessionKey: connectRoute.sessionKey,
    });

    setActiveWebListener(account.accountId, listener);
    unregisterUnhandled = registerUnhandledRejectionHandler((reason) => {
      if (!isLikelyWhatsAppCryptoError(reason)) return false;
      const errorStr = formatError(reason);
      reconnectLogger.warn(
        { connectionId, error: errorStr },
        "web reconnect: unhandled rejection from WhatsApp socket; forcing reconnect",
      );
      listener.signalClose?.({
        status: 499,
        isLoggedOut: false,
        error: reason,
      });
      return true;
    });

    const closeListener = async () => {
      setActiveWebListener(account.accountId, null);
      if (unregisterUnhandled) {
        unregisterUnhandled();
        unregisterUnhandled = null;
      }
      if (heartbeat) clearInterval(heartbeat);
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (backgroundTasks.size > 0) {
        await Promise.allSettled(backgroundTasks);
        backgroundTasks.clear();
      }
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${formatError(err)}`);
      }
    };

    if (keepAlive) {
      heartbeat = setInterval(() => {
        const authAgeMs = getWebAuthAgeMs(account.authDir);
        const minutesSinceLastMessage = lastMessageAt
          ? Math.floor((Date.now() - lastMessageAt) / 60000)
          : null;

        const logData = {
          connectionId,
          reconnectAttempts,
          messagesHandled: handledMessages,
          lastMessageAt,
          authAgeMs,
          uptimeMs: Date.now() - startedAt,
          ...(minutesSinceLastMessage !== null && minutesSinceLastMessage > 30
            ? { minutesSinceLastMessage }
            : {}),
        };

        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          heartbeatLogger.warn(logData, "⚠️ web gateway heartbeat - no messages in 30+ minutes");
        } else {
          heartbeatLogger.info(logData, "web gateway heartbeat");
        }
      }, heartbeatSeconds * 1000);

      watchdogTimer = setInterval(() => {
        if (!lastMessageAt) return;
        const timeSinceLastMessage = Date.now() - lastMessageAt;
        if (timeSinceLastMessage <= MESSAGE_TIMEOUT_MS) return;
        const minutesSinceLastMessage = Math.floor(timeSinceLastMessage / 60000);
        heartbeatLogger.warn(
          {
            connectionId,
            minutesSinceLastMessage,
            lastMessageAt: new Date(lastMessageAt),
            messagesHandled: handledMessages,
          },
          "Message timeout detected - forcing reconnect",
        );
        whatsappHeartbeatLog.warn(
          `No messages received in ${minutesSinceLastMessage}m - restarting connection`,
        );
        void closeListener().catch((err) => {
          logVerbose(`Close listener failed: ${formatError(err)}`);
        });
        listener.signalClose?.({
          status: 499,
          isLoggedOut: false,
          error: "watchdog-timeout",
        });
      }, WATCHDOG_CHECK_MS);
    }

    whatsappLog.info("Listening for personal WhatsApp inbound messages.");
    if (process.stdout.isTTY || process.stderr.isTTY) {
      whatsappLog.raw("Ctrl+C to stop.");
    }

    if (!keepAlive) {
      await closeListener();
      return;
    }

    const reason = await Promise.race([
      listener.onClose?.catch((err) => {
        reconnectLogger.error({ error: formatError(err) }, "listener.onClose rejected");
        return { status: 500, isLoggedOut: false, error: err };
      }) ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > heartbeatSeconds * 1000) {
      reconnectAttempts = 0; // Healthy stretch; reset the backoff.
    }
    status.reconnectAttempts = reconnectAttempts;
    emitStatus();

    if (stopRequested() || sigintStop || reason === "aborted") {
      await closeListener();
      break;
    }

    const statusCode =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? "unknown";
    const loggedOut =
      typeof reason === "object" &&
      reason &&
      "isLoggedOut" in reason &&
      (reason as { isLoggedOut?: boolean }).isLoggedOut;

    const errorStr = formatError(reason);
    status.connected = false;
    status.lastEventAt = Date.now();
    status.lastDisconnect = {
      at: status.lastEventAt,
      status: typeof statusCode === "number" ? statusCode : undefined,
      error: errorStr,
      loggedOut: Boolean(loggedOut),
    };
    status.lastError = errorStr;
    status.reconnectAttempts = reconnectAttempts;
    emitStatus();

    reconnectLogger.info(
      {
        connectionId,
        status: statusCode,
        loggedOut,
        reconnectAttempts,
        error: errorStr,
      },
      "web reconnect: connection closed",
    );

    enqueueSystemEvent(`WhatsApp gateway disconnected (status ${statusCode ?? "unknown"})`, {
      sessionKey: connectRoute.sessionKey,
    });

    if (loggedOut) {
      runtime.error(
        `WhatsApp session logged out. Run \`${formatCliCommand("moltbot channels login --channel web")}\` to relink.`,
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    status.reconnectAttempts = reconnectAttempts;
    emitStatus();
    if (reconnectPolicy.maxAttempts > 0 && reconnectAttempts >= reconnectPolicy.maxAttempts) {
      reconnectLogger.warn(
        {
          connectionId,
          status: statusCode,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts,
        },
        "web reconnect: max attempts reached; continuing in degraded mode",
      );
      runtime.error(
        `WhatsApp Web reconnect: max attempts reached (${reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`,
      );
      await closeListener();
      break;
    }

    const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
    reconnectLogger.info(
      {
        connectionId,
        status: statusCode,
        reconnectAttempts,
        maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
        delayMs: delay,
      },
      "web reconnect: scheduling retry",
    );
    runtime.error(
      `WhatsApp Web connection closed (status ${statusCode}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationMs(delay)}… (${errorStr})`,
    );
    await closeListener();
    try {
      await sleep(delay, abortSignal);
    } catch {
      break;
    }
  }

  status.running = false;
  status.connected = false;
  status.lastEventAt = Date.now();
  emitStatus();

  process.removeListener("SIGINT", handleSigint);
}
