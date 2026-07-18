// Whatsapp plugin module implements monitor behavior.
import type { WAMessageKey } from "baileys";
import { resolveAccountEntry } from "openclaw/plugin-sdk/account-core";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-runtime";
import { shouldDebounceTextInbound } from "openclaw/plugin-sdk/channel-inbound";
import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { registerUnhandledRejectionHandler } from "openclaw/plugin-sdk/runtime-env";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  defaultRuntime,
  formatDurationPrecise,
  warn,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { resolveWhatsAppAccount, resolveWhatsAppMediaMaxBytes } from "../accounts.js";
import { WHATSAPP_AUTH_UNSTABLE_CODE, WhatsAppAuthUnstableError } from "../auth-store.js";
import {
  WhatsAppConnectionController,
  WHATSAPP_WATCHDOG_TIMEOUT_ERROR,
  type ManagedWhatsAppListener,
} from "../connection-controller.js";
import { resolveWhatsAppInboundPolicy } from "../inbound-policy.js";
import { normalizeWebInboundMessage } from "../inbound/message-aliases.js";
import {
  attachWebInboxToSocket,
  readWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
  type WhatsAppBaileysMessageCache,
  type WhatsAppGroupMetadataCache,
} from "../inbound/monitor.js";
import type { WebInboundMessageInput } from "../inbound/types.js";
import {
  newConnectionId,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "../reconnect.js";
import { formatError, getWebAuthAgeMs, readWebSelfId } from "../session.js";
import { resolveWhatsAppSocketTiming } from "../socket-timing.js";
import { getRuntimeConfig, getRuntimeConfigSourceSnapshot } from "./config.runtime.js";
import { whatsappHeartbeatLog, whatsappLog } from "./loggers.js";
import { buildMentionConfig } from "./mentions.js";
import { createWebChannelStatusController } from "./monitor-state.js";
import { createEchoTracker } from "./monitor/echo.js";
import { formatWhatsAppInboundListeningLog } from "./monitor/listener-log.js";
import { createWebOnMessageHandler } from "./monitor/on-message.js";
import type { WebMonitorTuning } from "./types.js";
import { isLikelyWhatsAppCryptoError } from "./util.js";

function isNonRetryableWebCloseStatus(statusCode: unknown): boolean {
  // WhatsApp 440 = session conflict ("Unknown Stream Errored (conflict)").
  // This is persistent until the operator resolves the conflicting session.
  // Baileys 428 = DisconnectReason.connectionClosed, a generic WebSocket close
  // that is often transient and must stay on the reconnect path.
  return statusCode === 440;
}

type ReplyResolver = typeof import("./reply-resolver.runtime.js").getReplyFromConfig;
type WhatsAppRuntimeConfig = ReturnType<typeof getRuntimeConfig>;

const loadReplyResolverRuntime = createLazyRuntimeModule(
  () => import("./reply-resolver.runtime.js"),
);

function resolveWebMonitorConfigSnapshot(params: {
  cfg: WhatsAppRuntimeConfig;
  accountId?: string | null;
}): {
  cfg: WhatsAppRuntimeConfig;
  account: ReturnType<typeof resolveWhatsAppAccount>;
} {
  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const cfg = {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      whatsapp: {
        ...params.cfg.channels?.whatsapp,
        ackReaction: account.ackReaction,
        messagePrefix: account.messagePrefix,
        allowFrom: account.allowFrom,
        groupAllowFrom: account.groupAllowFrom,
        groupPolicy: account.groupPolicy,
        textChunkLimit: account.textChunkLimit,
        // Account merge replaces `streaming` wholesale, so pinning the
        // account-resolved object here keeps downstream root-level resolver
        // reads (chunk mode, block enable/coalesce) on this account's config.
        streaming: account.streaming,
        mediaMaxMb: account.mediaMaxMb,
        groups: account.groups,
      },
    },
  } satisfies WhatsAppRuntimeConfig;
  return { cfg, account };
}

function normalizeReconnectAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
}

function isNoListenerReconnectError(lastError?: string): boolean {
  return typeof lastError === "string" && /No active WhatsApp Web listener/i.test(lastError);
}

function resolveExplicitWhatsAppDebounceOverride(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  sourceCfg?: ReturnType<typeof getRuntimeConfig> | null;
  accountId: string;
}): number | undefined {
  const channel = params.sourceCfg?.channels?.whatsapp;
  if (!channel) {
    return undefined;
  }

  const accountId = normalizeReconnectAccountId(params.accountId);
  const accountDebounce = resolveAccountEntry(channel.accounts, accountId)?.debounceMs;
  if (accountDebounce !== undefined) {
    return accountDebounce;
  }
  if (accountId !== "default") {
    const defaultAccountDebounce = resolveAccountEntry(channel.accounts, "default")?.debounceMs;
    if (defaultAccountDebounce !== undefined) {
      return defaultAccountDebounce;
    }
  }

  return channel.debounceMs;
}

function isRetryableAuthUnstableError(error: unknown): error is WhatsAppAuthUnstableError {
  return (
    error instanceof WhatsAppAuthUnstableError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === WHATSAPP_AUTH_UNSTABLE_CODE)
  );
}

const DEFAULT_TRANSPORT_TIMEOUT_MS = 5 * 60 * 1000;
const WHATSAPP_RECONNECT_CATCH_UP_MAX_MS = 20 * 60_000;

export async function monitorWebChannel(
  verbose: boolean,
  listenerFactory: typeof attachWebInboxToSocket | undefined = attachWebInboxToSocket,
  keepAlive = true,
  replyResolver?: ReplyResolver,
  runtime: RuntimeEnv = defaultRuntime,
  abortSignal?: AbortSignal,
  tuning: WebMonitorTuning = {},
) {
  const activeReplyResolver =
    replyResolver ?? (await loadReplyResolverRuntime()).getReplyFromConfig;
  const runId = newConnectionId();
  const replyLogger = getChildLogger({ module: "web-auto-reply", runId });
  const heartbeatLogger = getChildLogger({ module: "web-heartbeat", runId });
  const reconnectLogger = getChildLogger({ module: "web-reconnect", runId });
  const baseCfg = getRuntimeConfig();
  const sourceCfg = getRuntimeConfigSourceSnapshot();
  const { cfg, account } = resolveWebMonitorConfigSnapshot({
    cfg: baseCfg,
    accountId: tuning.accountId,
  });
  const loadCurrentMonitorConfig = () =>
    resolveWebMonitorConfigSnapshot({
      cfg: getRuntimeConfig(),
      accountId: account.accountId,
    }).cfg;

  const maxMediaBytes = resolveWhatsAppMediaMaxBytes(account);
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, tuning.heartbeatSeconds);
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const socketTiming = resolveWhatsAppSocketTiming(cfg, tuning.socketTiming);
  const baseMentionConfig = buildMentionConfig(cfg);
  const groupHistoryLimit =
    account.historyLimit ??
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
  const groupMetadataCache: WhatsAppGroupMetadataCache = new Map();
  const recentMessageKeys: WhatsAppBaileysMessageCache = new Map();
  const baileysGroupMetaCache: WhatsAppBaileysGroupMetadataCache = new Map();
  const echoTracker = createEchoTracker({ maxItems: 100, logVerbose });

  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) => sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;

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

  const transportTimeoutMs = tuning.transportTimeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;
  const messageTimeoutMs = tuning.messageTimeoutMs ?? 30 * 60 * 1000;
  const reconnectCatchUpWindowMs = Math.min(
    Math.max(messageTimeoutMs, 60_000),
    WHATSAPP_RECONNECT_CATCH_UP_MAX_MS,
  );
  const watchdogCheckMs = tuning.watchdogCheckMs ?? 60 * 1000;
  const controller = new WhatsAppConnectionController({
    accountId: account.accountId,
    authDir: account.authDir,
    verbose,
    keepAlive,
    heartbeatSeconds,
    transportTimeoutMs,
    messageTimeoutMs,
    watchdogCheckMs,
    reconnectPolicy,
    socketTiming,
    abortSignal,
    sleep,
    isNonRetryableStatus: isNonRetryableWebCloseStatus,
  });
  const statusController = createWebChannelStatusController(tuning.statusSink);
  statusController.emit();

  try {
    while (true) {
      if (stopRequested()) {
        break;
      }

      const connectionId = newConnectionId();
      const inboundDebounceMs = resolveInboundDebounceMs({
        cfg,
        channel: "whatsapp",
        overrideMs: resolveExplicitWhatsAppDebounceOverride({
          cfg,
          sourceCfg,
          accountId: account.accountId,
        }),
      });
      const shouldDebounce = (msg: WebInboundMessageInput) => {
        const normalized = normalizeWebInboundMessage(msg);
        return shouldDebounceTextInbound({
          text: normalized.payload.commandBody ?? normalized.payload.body,
          cfg,
          hasMedia: Boolean(normalized.payload.media?.path || normalized.payload.media?.type),
          allowDebounce: !(
            normalized.payload.location ||
            normalized.quote?.id ||
            normalized.quote?.body
          ),
        });
      };

      let connection;
      try {
        connection = await controller.openConnection({
          connectionId,
          getMessage: async (key: WAMessageKey) =>
            key.id && key.remoteJid
              ? readWhatsAppBaileysCacheEntry(recentMessageKeys, `${key.remoteJid}:${key.id}`)
              : undefined,
          cachedGroupMetadata: async (jid: string) => {
            const meta = readWhatsAppBaileysCacheEntry(baileysGroupMetaCache, jid);
            return meta?.participants?.length ? meta : undefined;
          },
          createListener: async ({ sock, connection: connectionLocal }) => {
            const onMessage = createWebOnMessageHandler({
              cfg,
              loadConfig: loadCurrentMonitorConfig,
              verbose,
              connectionId,
              maxMediaBytes,
              groupHistoryLimit,
              groupHistories,
              groupMemberNames,
              echoTracker,
              backgroundTasks: connectionLocal.backgroundTasks,
              replyResolver: activeReplyResolver,
              replyLogger,
              baseMentionConfig,
              account,
            });
            return (await (listenerFactory ?? attachWebInboxToSocket)({
              cfg,
              loadConfig: loadCurrentMonitorConfig,
              verbose,
              accountId: account.accountId,
              authDir: account.authDir,
              mediaMaxMb: account.mediaMaxMb,
              selfChatMode: account.selfChatMode,
              sendReadReceipts: account.sendReadReceipts,
              socketTiming,
              debounceMs: inboundDebounceMs,
              appendReplyWindow: connectionLocal.openedAfterRecentInbound
                ? {
                    afterMs: connectionLocal.startedAt - reconnectCatchUpWindowMs,
                    untilMs: connectionLocal.startedAt + reconnectCatchUpWindowMs,
                    maxAgeMs: reconnectCatchUpWindowMs,
                  }
                : undefined,
              shouldDebounce,
              socketRef: controller.socketRef,
              shouldRetryDisconnect: () => !sigintStop && controller.shouldRetryDisconnect(),
              disconnectRetryPolicy: reconnectPolicy,
              disconnectRetryAbortSignal: controller.getDisconnectRetryAbortSignal(),
              groupMetadataCache,
              recentMessageKeys,
              baileysGroupMetaCache,
              onMessage: async (msg: WebInboundMessageInput) => {
                const normalized = normalizeWebInboundMessage(msg);
                const inboundAt = Date.now();
                controller.noteInbound(inboundAt);
                statusController.noteInbound(inboundAt);
                await onMessage(normalized);
              },
              onPendingWorkChanged: (pendingWorkCount, at) => {
                statusController.noteBusy(pendingWorkCount > 0, at);
              },
              sock,
            })) as ManagedWhatsAppListener;
          },
          onHeartbeat: (snapshot) => {
            const authAgeMs = getWebAuthAgeMs(account.authDir);
            const minutesSinceLastMessage = snapshot.lastInboundAt
              ? Math.floor((Date.now() - snapshot.lastInboundAt) / 60000)
              : null;

            const logData = {
              connectionId: snapshot.connectionId,
              reconnectAttempts: snapshot.reconnectAttempts,
              messagesHandled: snapshot.handledMessages,
              lastInboundAt: snapshot.lastInboundAt,
              lastTransportActivityAt: snapshot.lastTransportActivityAt,
              authAgeMs,
              uptimeMs: snapshot.uptimeMs,
              ...(minutesSinceLastMessage !== null && minutesSinceLastMessage > 30
                ? { minutesSinceLastMessage }
                : {}),
            };
            statusController.noteTransportActivity(snapshot.lastTransportActivityAt);

            if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
              heartbeatLogger.warn(
                logData,
                "⚠️ web gateway heartbeat - no messages in 30+ minutes",
              );
            } else {
              heartbeatLogger.info(logData, "web gateway heartbeat");
            }
          },
          onWatchdogTimeout: (snapshot) => {
            const now = Date.now();
            const transportSilentMs = now - snapshot.lastTransportActivityAt;
            const appBaselineAt = snapshot.lastInboundAt ?? snapshot.startedAt;
            const minutesSinceTransportActivity = Math.floor(transportSilentMs / 60000);
            const minutesSinceAppActivity = Math.floor((now - appBaselineAt) / 60000);
            const watchdogReason =
              transportSilentMs > transportTimeoutMs ? "transport-inactive" : "app-silent";
            statusController.noteWatchdogStale();
            heartbeatLogger.warn(
              {
                connectionId: snapshot.connectionId,
                watchdogReason,
                minutesSinceTransportActivity,
                minutesSinceAppActivity,
                lastInboundAt: snapshot.lastInboundAt ? new Date(snapshot.lastInboundAt) : null,
                lastTransportActivityAt: new Date(snapshot.lastTransportActivityAt),
                messagesHandled: snapshot.handledMessages,
              },
              "WhatsApp watchdog timeout detected - forcing reconnect",
            );
            whatsappHeartbeatLog.warn(
              `WhatsApp watchdog timeout (${watchdogReason}) - restarting connection`,
            );
          },
        });
      } catch (error) {
        const setupDecision = controller.resolveSetupErrorDecision(error);
        if (setupDecision === "aborted") {
          await controller.shutdown();
          break;
        }
        if (setupDecision) {
          statusController.noteReconnectAttempts(setupDecision.reconnectAttempts);
          statusController.noteClose({
            statusCode: setupDecision.normalized.statusCode,
            error: formatError(error),
            reconnectAttempts: setupDecision.reconnectAttempts,
            healthState: setupDecision.healthState,
          });
          if (setupDecision.action === "stop") {
            reconnectLogger.warn(
              {
                connectionId,
                status: setupDecision.normalized.statusLabel,
                reconnectAttempts: setupDecision.reconnectAttempts,
                maxAttempts: reconnectPolicy.maxAttempts,
              },
              "web reconnect: setup status error; max attempts reached",
            );
            if (setupDecision.healthState === "logged-out") {
              runtime.error(
                `WhatsApp session logged out during setup. Run \`${formatCliCommand("openclaw channels login --channel whatsapp")}\` to relink.`,
              );
            } else if (setupDecision.healthState === "conflict") {
              runtime.error(
                `WhatsApp Web connection closed during setup (status ${setupDecision.normalized.statusLabel}: session conflict). Resolve conflicting WhatsApp Web sessions, then restart the channel. To force a fresh QR, run \`${formatCliCommand("openclaw channels logout --channel whatsapp")}\` before \`${formatCliCommand("openclaw channels login --channel whatsapp")}\`. Stopping web monitoring.`,
              );
            } else {
              runtime.error(
                `WhatsApp Web connection closed during setup (status ${setupDecision.normalized.statusLabel}) after ${setupDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts} attempts. Relink with \`${formatCliCommand("openclaw channels login --channel whatsapp")}\` if the issue persists.`,
              );
            }
            await controller.shutdown();
            break;
          }
          reconnectLogger.info(
            {
              connectionId,
              status: setupDecision.normalized.statusLabel,
              reconnectAttempts: setupDecision.reconnectAttempts,
              delayMs: setupDecision.delayMs,
            },
            "web reconnect: setup status error; retrying",
          );
          runtime.error(
            `WhatsApp Web connection closed during setup (status ${setupDecision.normalized.statusLabel}). Retry ${setupDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(setupDecision.delayMs ?? 0)}.`,
          );
          try {
            await controller.waitBeforeRetry(setupDecision.delayMs ?? 0);
          } catch {
            break;
          }
          continue;
        }
        if (!isRetryableAuthUnstableError(error)) {
          throw error;
        }
        const retryDecision = controller.consumeReconnectAttempt();
        statusController.noteReconnectAttempts(retryDecision.reconnectAttempts);
        statusController.noteClose({
          error: error.message,
          reconnectAttempts: retryDecision.reconnectAttempts,
          healthState: retryDecision.healthState,
        });
        if (retryDecision.action === "stop") {
          reconnectLogger.warn(
            {
              connectionId,
              reconnectAttempts: retryDecision.reconnectAttempts,
              maxAttempts: reconnectPolicy.maxAttempts,
            },
            "web reconnect: auth state stayed unstable; max attempts reached",
          );
          runtime.error(
            `WhatsApp auth state is still stabilizing after ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts} attempts. Stopping web monitoring.`,
          );
          await controller.shutdown();
          break;
        }
        reconnectLogger.info(
          {
            connectionId,
            reconnectAttempts: retryDecision.reconnectAttempts,
            delayMs: retryDecision.delayMs,
          },
          "web reconnect: auth state still stabilizing during inbox attach; retrying",
        );
        runtime.error(
          `WhatsApp auth state is still stabilizing. Retry ${retryDecision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} for inbox attach in ${formatDurationPrecise(retryDecision.delayMs ?? 0)}.`,
        );
        try {
          await controller.waitBeforeRetry(retryDecision.delayMs ?? 0);
        } catch {
          break;
        }
        continue;
      }

      statusController.noteConnected();
      const approvalContextLease = registerChannelRuntimeContext({
        channelRuntime: tuning.channelRuntime,
        channelId: "whatsapp",
        accountId: account.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { accountId: account.accountId },
        abortSignal,
      });
      controller.setUnhandledRejectionCleanup(
        registerUnhandledRejectionHandler((reason) => {
          if (!isLikelyWhatsAppCryptoError(reason)) {
            return false;
          }
          const errorStr = formatError(reason);
          reconnectLogger.warn(
            { connectionId: connection.connectionId, error: errorStr },
            "web reconnect: unhandled rejection from WhatsApp socket; forcing reconnect",
          );
          controller.forceClose({
            status: 499,
            isLoggedOut: false,
            error: reason,
          });
          return true;
        }),
      );

      const { e164: selfE164 } = readWebSelfId(account.authDir);
      const connectRoute = resolveAgentRoute({
        cfg,
        channel: "whatsapp",
        accountId: account.accountId,
      });
      enqueueSystemEvent(`WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`, {
        sessionKey: connectRoute.sessionKey,
      });

      const normalizedAccountId = normalizeReconnectAccountId(account.accountId);
      void drainPendingDeliveries({
        drainKey: `whatsapp:${normalizedAccountId}`,
        logLabel: "WhatsApp reconnect drain",
        cfg,
        log: reconnectLogger,
        selectEntry: (entry) => ({
          match:
            entry.channel === "whatsapp" &&
            normalizeReconnectAccountId(entry.accountId) === normalizedAccountId,
          bypassBackoff: isNoListenerReconnectError(entry.lastError),
        }),
      }).catch((err: unknown) => {
        reconnectLogger.warn(
          { connectionId: connection.connectionId, error: String(err) },
          "reconnect drain failed",
        );
      });

      const periodicDrainInterval = setInterval(() => {
        void drainPendingDeliveries({
          drainKey: `whatsapp:${normalizedAccountId}`,
          logLabel: "WhatsApp periodic drain",
          cfg,
          log: reconnectLogger,
          selectEntry: (entry) => ({
            match:
              entry.channel === "whatsapp" &&
              normalizeReconnectAccountId(entry.accountId) === normalizedAccountId,
            bypassBackoff: false,
          }),
        }).catch((err: unknown) => {
          reconnectLogger.warn(
            { connectionId: connection.connectionId, error: String(err) },
            "periodic drain failed",
          );
        });
      }, 30_000);

      const inboundPolicy = resolveWhatsAppInboundPolicy({
        cfg,
        accountId: account.accountId,
        selfE164: selfE164 ?? null,
      });
      whatsappLog.info(
        formatWhatsAppInboundListeningLog({
          groups: inboundPolicy.account.groups,
          groupPolicy: inboundPolicy.groupPolicy,
          hasGroupAllowFrom: inboundPolicy.groupAllowFrom.length > 0,
        }),
      );
      if (process.stdout.isTTY || process.stderr.isTTY) {
        whatsappLog.raw("Ctrl+C to stop.");
      }

      if (!keepAlive) {
        clearInterval(periodicDrainInterval);
        approvalContextLease?.dispose();
        await controller.shutdown();
        return;
      }

      const reason = await controller.waitForClose().finally(() => {
        clearInterval(periodicDrainInterval);
        approvalContextLease?.dispose();
      });
      if (stopRequested() || sigintStop || reason === "aborted") {
        await controller.shutdown();
        break;
      }

      const decision = controller.resolveCloseDecision(reason);
      if (decision === "aborted") {
        await controller.shutdown();
        break;
      }
      statusController.noteReconnectAttempts(controller.getReconnectAttempts());

      reconnectLogger.info(
        {
          connectionId: connection.connectionId,
          status: decision.normalized.statusLabel,
          loggedOut: decision.normalized.isLoggedOut,
          reconnectAttempts: decision.reconnectAttempts,
          error: decision.normalized.errorText,
        },
        "web reconnect: connection closed",
      );

      enqueueSystemEvent(
        `WhatsApp gateway disconnected (status ${decision.normalized.statusLabel})`,
        {
          sessionKey: connectRoute.sessionKey,
        },
      );

      if (decision.action === "stop") {
        await controller.closeCurrentConnection();
        statusController.noteClose({
          statusCode: decision.normalized.statusCode,
          loggedOut: decision.normalized.isLoggedOut,
          error: decision.normalized.errorText,
          reconnectAttempts: decision.reconnectAttempts,
          healthState: decision.healthState,
        });

        if (decision.healthState === "logged-out") {
          runtime.error(
            `WhatsApp session logged out. Run \`${formatCliCommand("openclaw channels login --channel whatsapp")}\` to relink.`,
          );
        } else if (decision.healthState === "conflict") {
          reconnectLogger.warn(
            {
              connectionId: connection.connectionId,
              status: decision.normalized.statusLabel,
              error: decision.normalized.errorText,
            },
            "web reconnect: non-retryable close status; stopping monitor",
          );
          runtime.error(
            `WhatsApp Web connection closed (status ${decision.normalized.statusLabel}: session conflict). Resolve conflicting WhatsApp Web sessions, then restart the channel. To force a fresh QR, run \`${formatCliCommand("openclaw channels logout --channel whatsapp")}\` before \`${formatCliCommand("openclaw channels login --channel whatsapp")}\`. Stopping web monitoring.`,
          );
        } else {
          reconnectLogger.warn(
            {
              connectionId: connection.connectionId,
              status: decision.normalized.statusLabel,
              reconnectAttempts: decision.reconnectAttempts,
              maxAttempts: reconnectPolicy.maxAttempts,
            },
            "web reconnect: max attempts reached; continuing in degraded mode",
          );
          runtime.error(
            `WhatsApp Web reconnect: max attempts reached (${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts}). Stopping web monitoring.`,
          );
        }

        await controller.shutdown();
        break;
      }

      const isWatchdogRecoveryReconnect =
        decision.normalized.error === WHATSAPP_WATCHDOG_TIMEOUT_ERROR;
      statusController.noteClose({
        statusCode: decision.normalized.statusCode,
        error: decision.normalized.errorText,
        reconnectAttempts: decision.reconnectAttempts,
        healthState: decision.healthState,
        watchdogRecovery: isWatchdogRecoveryReconnect,
      });
      reconnectLogger.info(
        {
          connectionId: connection.connectionId,
          status: decision.normalized.statusLabel,
          reconnectAttempts: decision.reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
          delayMs: decision.delayMs,
        },
        "web reconnect: scheduling retry",
      );
      const reconnectMessage = isWatchdogRecoveryReconnect
        ? `WhatsApp Web watchdog is recovering a stale connection (status ${decision.normalized.statusLabel}). Retry ${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(decision.delayMs ?? 0)}.`
        : `WhatsApp Web connection closed (status ${decision.normalized.statusLabel}). Retry ${decision.reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDurationPrecise(decision.delayMs ?? 0)}… (${decision.normalized.errorText})`;
      if (isWatchdogRecoveryReconnect) {
        runtime.log(warn(reconnectMessage));
      } else {
        runtime.error(reconnectMessage);
      }
      await controller.closeCurrentConnection();
      try {
        await controller.waitBeforeRetry(decision.delayMs ?? 0);
      } catch {
        break;
      }
    }
  } finally {
    statusController.markStopped();
    process.removeListener("SIGINT", handleSigint);
    await controller.shutdown();
  }
}
