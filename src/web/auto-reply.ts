import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  deriveSessionKey,
  loadSessionStore,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
import { danger, info, isVerbose, logVerbose, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { getQueueSize } from "../process/command-queue.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { monitorWebInbox } from "./inbound.js";
import { sendViaIpc, startIpcServer, stopIpcServer } from "./ipc.js";
import { loadWebMedia } from "./media.js";
import { sendMessageWeb } from "./outbound.js";
import {
  computeBackoff,
  newConnectionId,
  type ReconnectPolicy,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "./reconnect.js";
import { getWebAuthAgeMs } from "./session.js";

/**
 * Send a message via IPC if relay is running, otherwise fall back to direct.
 * This avoids Signal session corruption from multiple Baileys connections.
 */
async function sendWithIpcFallback(
  to: string,
  message: string,
  opts: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  const ipcResult = await sendViaIpc(to, message, opts.mediaUrl);
  if (ipcResult?.success && ipcResult.messageId) {
    if (opts.verbose) {
      console.log(info(`Sent via relay IPC (avoiding session corruption)`));
    }
    return { messageId: ipcResult.messageId, toJid: `${to}@s.whatsapp.net` };
  }
  // Fall back to direct send
  return sendMessageWeb(to, message, opts);
}

const DEFAULT_WEB_MEDIA_BYTES = 5 * 1024 * 1024;
type WebInboundMsg = Parameters<
  typeof monitorWebInbox
>[0]["onMessage"] extends (msg: infer M) => unknown
  ? M
  : never;

export type WebMonitorTuning = {
  reconnect?: Partial<ReconnectPolicy>;
  heartbeatSeconds?: number;
  replyHeartbeatMinutes?: number;
  replyHeartbeatNow?: boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

const formatDuration = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;

const DEFAULT_REPLY_HEARTBEAT_MINUTES = 30;
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";
export const HEARTBEAT_PROMPT = "HEARTBEAT ultrathink";

export function resolveReplyHeartbeatMinutes(
  cfg: ReturnType<typeof loadConfig>,
  overrideMinutes?: number,
) {
  const raw = overrideMinutes ?? cfg.inbound?.reply?.heartbeatMinutes;
  if (raw === 0) return null;
  if (typeof raw === "number" && raw > 0) return raw;
  return cfg.inbound?.reply?.mode === "command"
    ? DEFAULT_REPLY_HEARTBEAT_MINUTES
    : null;
}

export function stripHeartbeatToken(raw?: string) {
  if (!raw) return { shouldSkip: true, text: "" };
  const trimmed = raw.trim();
  if (!trimmed) return { shouldSkip: true, text: "" };
  if (trimmed === HEARTBEAT_TOKEN) return { shouldSkip: true, text: "" };
  const withoutToken = trimmed.replaceAll(HEARTBEAT_TOKEN, "").trim();
  return {
    shouldSkip: withoutToken.length === 0,
    text: withoutToken || trimmed,
  };
}

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof loadConfig>;
  to: string;
  verbose?: boolean;
  replyResolver?: typeof getReplyFromConfig;
  runtime?: RuntimeEnv;
  sender?: typeof sendMessageWeb;
  sessionId?: string;
  overrideBody?: string;
  dryRun?: boolean;
}) {
  const {
    cfg: cfgOverride,
    to,
    verbose = false,
    sessionId,
    overrideBody,
    dryRun = false,
  } = opts;
  const _runtime = opts.runtime ?? defaultRuntime;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendWithIpcFallback;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = cfgOverride ?? loadConfig();
  if (sessionId) {
    const storePath = resolveStorePath(cfg.inbound?.reply?.session?.store);
    const store = loadSessionStore(storePath);
    store[to] = {
      ...(store[to] ?? {}),
      sessionId,
      updatedAt: Date.now(),
    };
    await saveSessionStore(storePath, store);
  }
  const sessionSnapshot = getSessionSnapshot(cfg, to, true);
  if (verbose) {
    heartbeatLogger.info(
      {
        to,
        sessionKey: sessionSnapshot.key,
        sessionId: sessionId ?? sessionSnapshot.entry?.sessionId ?? null,
        sessionFresh: sessionSnapshot.fresh,
        idleMinutes: sessionSnapshot.idleMinutes,
      },
      "heartbeat session snapshot",
    );
  }

  if (overrideBody && overrideBody.trim().length === 0) {
    throw new Error("Override body must be non-empty when provided.");
  }

  try {
    if (overrideBody) {
      if (dryRun) {
        console.log(
          success(
            `[dry-run] web send -> ${to}: ${overrideBody.trim()} (manual message)`,
          ),
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose });
      heartbeatLogger.info(
        {
          to,
          messageId: sendResult.messageId,
          chars: overrideBody.length,
          reason: "manual-message",
        },
        "manual heartbeat message sent",
      );
      console.log(
        success(
          `sent manual message to ${to} (web), id ${sendResult.messageId}`,
        ),
      );
      return;
    }

    const replyResult = await replyResolver(
      {
        Body: HEARTBEAT_PROMPT,
        From: to,
        To: to,
        MessageSid: sessionId ?? sessionSnapshot.entry?.sessionId,
      },
      undefined,
      cfg,
    );
    if (
      !replyResult ||
      (!replyResult.text &&
        !replyResult.mediaUrl &&
        !replyResult.mediaUrls?.length)
    ) {
      heartbeatLogger.info(
        {
          to,
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
        },
        "heartbeat skipped",
      );
      if (verbose) console.log(success("heartbeat: ok (empty reply)"));
      return;
    }

    const hasMedia = Boolean(
      replyResult.mediaUrl || (replyResult.mediaUrls?.length ?? 0) > 0,
    );
    const stripped = stripHeartbeatToken(replyResult.text);
    if (stripped.shouldSkip && !hasMedia) {
      // Don't let heartbeats keep sessions alive: restore previous updatedAt so idle expiry still works.
      const sessionCfg = cfg.inbound?.reply?.session;
      const storePath = resolveStorePath(sessionCfg?.store);
      const store = loadSessionStore(storePath);
      if (sessionSnapshot.entry && store[sessionSnapshot.key]) {
        store[sessionSnapshot.key].updatedAt = sessionSnapshot.entry.updatedAt;
        await saveSessionStore(storePath, store);
      }

      heartbeatLogger.info(
        { to, reason: "heartbeat-token", rawLength: replyResult.text?.length },
        "heartbeat skipped",
      );
      console.log(success("heartbeat: ok (HEARTBEAT_OK)"));
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn(
        { to },
        "heartbeat reply contained media; sending text only",
      );
    }

    const finalText = stripped.text || replyResult.text || "";
    if (dryRun) {
      heartbeatLogger.info(
        { to, reason: "dry-run", chars: finalText.length },
        "heartbeat dry-run",
      );
      console.log(
        success(`[dry-run] heartbeat -> ${to}: ${finalText.slice(0, 200)}`),
      );
      return;
    }

    const sendResult = await sender(to, finalText, { verbose });
    heartbeatLogger.info(
      { to, messageId: sendResult.messageId, chars: finalText.length },
      "heartbeat sent",
    );
    console.log(success(`heartbeat: alert sent to ${to}`));
  } catch (err) {
    heartbeatLogger.warn({ to, error: String(err) }, "heartbeat failed");
    console.log(danger(`heartbeat: failed - ${String(err)}`));
    throw err;
  }
}

function getFallbackRecipient(cfg: ReturnType<typeof loadConfig>) {
  const sessionCfg = cfg.inbound?.reply?.session;
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  const candidates = Object.entries(store).filter(([key]) => key !== "global");
  if (candidates.length === 0) {
    const allowFrom =
      Array.isArray(cfg.inbound?.allowFrom) && cfg.inbound.allowFrom.length > 0
        ? cfg.inbound.allowFrom.filter((v) => v !== "*")
        : [];
    if (allowFrom.length === 0) return null;
    return allowFrom[0] ? normalizeE164(allowFrom[0]) : null;
  }
  const mostRecent = candidates.sort(
    (a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0),
  )[0];
  return mostRecent ? normalizeE164(mostRecent[0]) : null;
}

function getSessionRecipients(cfg: ReturnType<typeof loadConfig>) {
  const sessionCfg = cfg.inbound?.reply?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  if (scope === "global") return [];
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  return Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({
      to: normalizeE164(key),
      updatedAt: entry?.updatedAt ?? 0,
    }))
    .filter(({ to }) => Boolean(to))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean } = {},
) {
  if (opts.to) return { recipients: [normalizeE164(opts.to)], source: "flag" };

  const sessionRecipients = getSessionRecipients(cfg);
  const allowFrom =
    Array.isArray(cfg.inbound?.allowFrom) && cfg.inbound.allowFrom.length > 0
      ? cfg.inbound.allowFrom.filter((v) => v !== "*").map(normalizeE164)
      : [];

  const unique = (list: string[]) => [...new Set(list.filter(Boolean))];

  if (opts.all) {
    const all = unique([...sessionRecipients.map((s) => s.to), ...allowFrom]);
    return { recipients: all, source: "all" as const };
  }

  if (sessionRecipients.length === 1) {
    return { recipients: [sessionRecipients[0].to], source: "session-single" };
  }
  if (sessionRecipients.length > 1) {
    return {
      recipients: sessionRecipients.map((s) => s.to),
      source: "session-ambiguous" as const,
    };
  }

  return { recipients: allowFrom, source: "allowFrom" as const };
}

function getSessionSnapshot(
  cfg: ReturnType<typeof loadConfig>,
  from: string,
  isHeartbeat = false,
) {
  const sessionCfg = cfg.inbound?.reply?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key = deriveSessionKey(scope, { From: from, To: "", Body: "" });
  const store = loadSessionStore(resolveStorePath(sessionCfg?.store));
  const entry = store[key];
  const idleMinutes = Math.max(
    (isHeartbeat
      ? (sessionCfg?.heartbeatIdleMinutes ?? sessionCfg?.idleMinutes)
      : sessionCfg?.idleMinutes) ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const fresh = !!(
    entry && Date.now() - entry.updatedAt <= idleMinutes * 60_000
  );
  return { key, entry, fresh, idleMinutes };
}

async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  msg: WebInboundMsg;
  maxMediaBytes: number;
  replyLogger: ReturnType<typeof getChildLogger>;
  runtime: RuntimeEnv;
  connectionId?: string;
  skipLog?: boolean;
}) {
  const {
    replyResult,
    msg,
    maxMediaBytes,
    replyLogger,
    runtime,
    connectionId,
    skipLog,
  } = params;
  const replyStarted = Date.now();
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  if (mediaList.length === 0 && replyResult.text) {
    await msg.reply(replyResult.text || "");
    if (!skipLog) {
      logInfo(
        `✅ Sent web reply to ${msg.from} (${(Date.now() - replyStarted).toFixed(0)}ms)`,
        runtime,
      );
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: replyResult.text,
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    return;
  }

  const cleanText = replyResult.text ?? undefined;
  for (const [index, mediaUrl] of mediaList.entries()) {
    try {
      const media = await loadWebMedia(mediaUrl, maxMediaBytes);
      if (isVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(
          `Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`,
        );
      }
      const caption = index === 0 ? cleanText || undefined : undefined;
      if (media.kind === "image") {
        await msg.sendMedia({
          image: media.buffer,
          caption,
          mimetype: media.contentType,
        });
      } else if (media.kind === "audio") {
        await msg.sendMedia({
          audio: media.buffer,
          ptt: true,
          mimetype: media.contentType,
          caption,
        });
      } else if (media.kind === "video") {
        await msg.sendMedia({
          video: media.buffer,
          caption,
          mimetype: media.contentType,
        });
      } else {
        const fileName = mediaUrl.split("/").pop() ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        await msg.sendMedia({
          document: media.buffer,
          fileName,
          caption,
          mimetype,
        });
      }
      logInfo(
        `✅ Sent web media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
        runtime,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: index === 0 ? (cleanText ?? null) : null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    } catch (err) {
      console.error(
        danger(`Failed sending web media to ${msg.from}: ${String(err)}`),
      );
      if (index === 0 && cleanText) {
        console.log(`⚠️  Media skipped; sent text-only to ${msg.from}`);
        await msg.reply(cleanText || "");
      }
    }
  }
}

export async function monitorWebProvider(
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
  const cfg = loadConfig();
  const configuredMaxMb = cfg.inbound?.reply?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const heartbeatSeconds = resolveHeartbeatSeconds(
    cfg,
    tuning.heartbeatSeconds,
  );
  const replyHeartbeatMinutes = resolveReplyHeartbeatMinutes(
    cfg,
    tuning.replyHeartbeatMinutes,
  );
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const sleep =
    tuning.sleep ??
    ((ms: number, signal?: AbortSignal) =>
      sleepWithAbort(ms, signal ?? abortSignal));
  const stopRequested = () => abortSignal?.aborted === true;
  const abortPromise =
    abortSignal &&
    new Promise<"aborted">((resolve) =>
      abortSignal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      }),
    );

  // Avoid noisy MaxListenersExceeded warnings in test environments where
  // multiple relay instances may be constructed.
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

  // Track recently sent messages to prevent echo loops
  const recentlySent = new Set<string>();
  const MAX_RECENT_MESSAGES = 100;

  while (true) {
    if (stopRequested()) break;

    const connectionId = newConnectionId();
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let replyHeartbeatTimer: NodeJS.Timeout | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let lastInboundMsg: WebInboundMsg | null = null;

    // Watchdog to detect stuck message processing (e.g., event emitter died)
    // Should be significantly longer than heartbeatMinutes to avoid false positives
    const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes without any messages
    const WATCHDOG_CHECK_MS = 60 * 1000; // Check every minute

    // Batch inbound messages while command queue is busy, then send one
    // combined prompt with per-message timestamps (inbound-only behavior).
    type PendingBatch = { messages: WebInboundMsg[]; timer?: NodeJS.Timeout };
    const pendingBatches = new Map<string, PendingBatch>();

    const formatTimestamp = (ts?: number) => {
      const tsCfg = cfg.inbound?.timestampPrefix;
      const tsEnabled = tsCfg !== false; // default true
      if (!tsEnabled) return "";
      const tz = typeof tsCfg === "string" ? tsCfg : "UTC";
      const date = ts ? new Date(ts) : new Date();
      try {
        return `[${date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz })} ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz })}] `;
      } catch {
        return `[${date.toISOString().slice(5, 16).replace("T", " ")}] `;
      }
    };

    const buildLine = (msg: WebInboundMsg) => {
      // Build message prefix: explicit config > default based on allowFrom
      let messagePrefix = cfg.inbound?.messagePrefix;
      if (messagePrefix === undefined) {
        const hasAllowFrom = (cfg.inbound?.allowFrom?.length ?? 0) > 0;
        messagePrefix = hasAllowFrom ? "" : "[warelay]";
      }
      const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
      return `${formatTimestamp(msg.timestamp)}${prefixStr}${msg.body}`;
    };

    const processBatch = async (from: string) => {
      const batch = pendingBatches.get(from);
      if (!batch || batch.messages.length === 0) return;
      if (getQueueSize() > 0) {
        // Wait until command queue is free to run the combined prompt.
        batch.timer = setTimeout(() => void processBatch(from), 150);
        return;
      }
      pendingBatches.delete(from);

      const messages = batch.messages;
      const latest = messages[messages.length - 1];
      const combinedBody = messages.map(buildLine).join("\n");

      // Echo detection uses combined body so we don't respond twice.
      if (recentlySent.has(combinedBody)) {
        logVerbose(`Skipping auto-reply: detected echo for combined batch`);
        recentlySent.delete(combinedBody);
        return;
      }

      const correlationId = latest.id ?? newConnectionId();
      replyLogger.info(
        {
          connectionId,
          correlationId,
          from,
          to: latest.to,
          body: combinedBody,
          mediaType: latest.mediaType ?? null,
          mediaPath: latest.mediaPath ?? null,
          batchSize: messages.length,
        },
        "inbound web message (batched)",
      );

      const tsDisplay = latest.timestamp
        ? new Date(latest.timestamp).toISOString()
        : new Date().toISOString();
      console.log(`\n[${tsDisplay}] ${from} -> ${latest.to}: ${combinedBody}`);

      const replyResult = await (replyResolver ?? getReplyFromConfig)(
        {
          Body: combinedBody,
          From: latest.from,
          To: latest.to,
          MessageSid: latest.id,
          MediaPath: latest.mediaPath,
          MediaUrl: latest.mediaUrl,
          MediaType: latest.mediaType,
        },
        {
          onReplyStart: latest.sendComposing,
        },
      );

      if (
        !replyResult ||
        (!replyResult.text &&
          !replyResult.mediaUrl &&
          !replyResult.mediaUrls?.length)
      ) {
        logVerbose("Skipping auto-reply: no text/media returned from resolver");
        return;
      }

      // Apply response prefix if configured (skip for HEARTBEAT_OK to preserve exact match)
      const responsePrefix = cfg.inbound?.responsePrefix;
      if (
        responsePrefix &&
        replyResult.text &&
        replyResult.text.trim() !== HEARTBEAT_TOKEN
      ) {
        if (!replyResult.text.startsWith(responsePrefix)) {
          replyResult.text = `${responsePrefix} ${replyResult.text}`;
        }
      }

      try {
        await deliverWebReply({
          replyResult,
          msg: latest,
          maxMediaBytes,
          replyLogger,
          runtime,
          connectionId,
        });

        if (replyResult.text) {
          recentlySent.add(replyResult.text);
          recentlySent.add(combinedBody); // Prevent echo on the batch text itself
          logVerbose(
            `Added to echo detection set (size now: ${recentlySent.size}): ${replyResult.text.substring(0, 50)}...`,
          );
          if (recentlySent.size > MAX_RECENT_MESSAGES) {
            const firstKey = recentlySent.values().next().value;
            if (firstKey) recentlySent.delete(firstKey);
          }
        }

        if (isVerbose()) {
          console.log(
            success(
              `↩️  Auto-replied to ${from} (web${replyResult.mediaUrl || replyResult.mediaUrls?.length ? ", media" : ""}; batched ${messages.length})`,
            ),
          );
        } else {
          console.log(
            success(
              `↩️  ${replyResult.text ?? "<media>"}${replyResult.mediaUrl || replyResult.mediaUrls?.length ? " (media)" : ""}`,
            ),
          );
        }
      } catch (err) {
        console.error(
          danger(`Failed sending web auto-reply to ${from}: ${String(err)}`),
        );
      }
    };

    const enqueueBatch = async (msg: WebInboundMsg) => {
      const bucket = pendingBatches.get(msg.from) ?? { messages: [] };
      bucket.messages.push(msg);
      pendingBatches.set(msg.from, bucket);

      // Process immediately when queue is free; otherwise wait until it drains.
      if (getQueueSize() === 0) {
        await processBatch(msg.from);
      } else {
        bucket.timer =
          bucket.timer ?? setTimeout(() => void processBatch(msg.from), 150);
      }
    };

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      onMessage: async (msg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        lastInboundMsg = msg;

        // Same-phone mode logging retained
        if (msg.from === msg.to) {
          logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
        }

        // Skip if this is a message we just sent (echo detection)
        if (recentlySent.has(msg.body)) {
          console.log(`⏭️  Skipping echo: detected recently sent message`);
          logVerbose(
            `Skipping auto-reply: detected echo (message matches recently sent text)`,
          );
          recentlySent.delete(msg.body);
          return;
        }

        return enqueueBatch(msg);
      },
    });

    // Start IPC server so `warelay send` can use this connection
    // instead of creating a new one (which would corrupt Signal session)
    if ("sendMessage" in listener && "sendComposingTo" in listener) {
      startIpcServer(async (to, message, mediaUrl) => {
        let mediaBuffer: Buffer | undefined;
        let mediaType: string | undefined;
        if (mediaUrl) {
          const media = await loadWebMedia(mediaUrl);
          mediaBuffer = media.buffer;
          mediaType = media.contentType;
        }
        const result = await listener.sendMessage(
          to,
          message,
          mediaBuffer,
          mediaType,
        );
        // Add to echo detection so we don't process our own message
        if (message) {
          recentlySent.add(message);
          if (recentlySent.size > MAX_RECENT_MESSAGES) {
            const firstKey = recentlySent.values().next().value;
            if (firstKey) recentlySent.delete(firstKey);
          }
        }
        logInfo(
          `📤 IPC send to ${to}: ${message.substring(0, 50)}...`,
          runtime,
        );
        // Show typing indicator after send so user knows more may be coming
        try {
          await listener.sendComposingTo(to);
        } catch {
          // Ignore typing indicator errors - not critical
        }
        return result;
      });
    }

    const closeListener = async () => {
      stopIpcServer();
      if (heartbeat) clearInterval(heartbeat);
      if (replyHeartbeatTimer) clearInterval(replyHeartbeatTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    };

    if (keepAlive) {
      heartbeat = setInterval(() => {
        const authAgeMs = getWebAuthAgeMs();
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

        // Warn if no messages in 30+ minutes
        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          heartbeatLogger.warn(
            logData,
            "⚠️ web relay heartbeat - no messages in 30+ minutes",
          );
        } else {
          heartbeatLogger.info(logData, "web relay heartbeat");
        }
      }, heartbeatSeconds * 1000);

      // Watchdog: Auto-restart if no messages received for MESSAGE_TIMEOUT_MS
      watchdogTimer = setInterval(() => {
        if (lastMessageAt) {
          const timeSinceLastMessage = Date.now() - lastMessageAt;
          if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
            const minutesSinceLastMessage = Math.floor(
              timeSinceLastMessage / 60000,
            );
            heartbeatLogger.warn(
              {
                connectionId,
                minutesSinceLastMessage,
                lastMessageAt: new Date(lastMessageAt),
                messagesHandled: handledMessages,
              },
              "Message timeout detected - forcing reconnect",
            );
            console.error(
              `⚠️  No messages received in ${minutesSinceLastMessage}m - restarting connection`,
            );
            closeListener(); // Trigger reconnect
          }
        }
      }, WATCHDOG_CHECK_MS);
    }

    const runReplyHeartbeat = async () => {
      const queued = getQueueSize();
      if (queued > 0) {
        heartbeatLogger.info(
          { connectionId, reason: "requests-in-flight", queued },
          "reply heartbeat skipped",
        );
        console.log(success("heartbeat: skipped (requests in flight)"));
        return;
      }
      if (!replyHeartbeatMinutes) return;
      const tickStart = Date.now();
      if (!lastInboundMsg) {
        const fallbackTo = getFallbackRecipient(cfg);
        if (!fallbackTo) {
          heartbeatLogger.info(
            {
              connectionId,
              reason: "no-recent-inbound",
              durationMs: Date.now() - tickStart,
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: skipped (no recent inbound)"));
          return;
        }
        const snapshot = getSessionSnapshot(cfg, fallbackTo, true);
        if (!snapshot.entry) {
          heartbeatLogger.info(
            { connectionId, to: fallbackTo, reason: "no-session-for-fallback" },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: skipped (no session to resume)"));
          return;
        }
        if (isVerbose()) {
          heartbeatLogger.info(
            {
              connectionId,
              to: fallbackTo,
              reason: "fallback-session",
              sessionId: snapshot.entry?.sessionId ?? null,
              sessionFresh: snapshot.fresh,
            },
            "reply heartbeat start",
          );
        }
        await runWebHeartbeatOnce({
          cfg,
          to: fallbackTo,
          verbose,
          replyResolver,
          runtime,
          sessionId: snapshot.entry.sessionId,
        });
        heartbeatLogger.info(
          {
            connectionId,
            to: fallbackTo,
            ...snapshot,
            durationMs: Date.now() - tickStart,
          },
          "reply heartbeat sent (fallback session)",
        );
        return;
      }

      try {
        const snapshot = getSessionSnapshot(cfg, lastInboundMsg.from);
        if (isVerbose()) {
          heartbeatLogger.info(
            {
              connectionId,
              to: lastInboundMsg.from,
              intervalMinutes: replyHeartbeatMinutes,
              sessionKey: snapshot.key,
              sessionId: snapshot.entry?.sessionId ?? null,
              sessionFresh: snapshot.fresh,
            },
            "reply heartbeat start",
          );
        }
        const replyResult = await (replyResolver ?? getReplyFromConfig)(
          {
            Body: HEARTBEAT_PROMPT,
            From: lastInboundMsg.from,
            To: lastInboundMsg.to,
            MessageSid: snapshot.entry?.sessionId,
            MediaPath: undefined,
            MediaUrl: undefined,
            MediaType: undefined,
          },
          {
            onReplyStart: lastInboundMsg.sendComposing,
          },
        );

        if (
          !replyResult ||
          (!replyResult.text &&
            !replyResult.mediaUrl &&
            !replyResult.mediaUrls?.length)
        ) {
          heartbeatLogger.info(
            {
              connectionId,
              durationMs: Date.now() - tickStart,
              reason: "empty-reply",
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: ok (empty reply)"));
          return;
        }

        const stripped = stripHeartbeatToken(replyResult.text);
        const hasMedia = Boolean(
          replyResult.mediaUrl || (replyResult.mediaUrls?.length ?? 0) > 0,
        );
        if (stripped.shouldSkip && !hasMedia) {
          heartbeatLogger.info(
            {
              connectionId,
              durationMs: Date.now() - tickStart,
              reason: "heartbeat-token",
              rawLength: replyResult.text?.length ?? 0,
            },
            "reply heartbeat skipped",
          );
          console.log(success("heartbeat: ok (HEARTBEAT_OK)"));
          return;
        }

        // Apply response prefix if configured (same as regular messages)
        let finalText = stripped.text;
        const responsePrefix = cfg.inbound?.responsePrefix;
        if (
          responsePrefix &&
          finalText &&
          !finalText.startsWith(responsePrefix)
        ) {
          finalText = `${responsePrefix} ${finalText}`;
        }

        const cleanedReply: ReplyPayload = {
          ...replyResult,
          text: finalText,
        };

        await deliverWebReply({
          replyResult: cleanedReply,
          msg: lastInboundMsg,
          maxMediaBytes,
          replyLogger,
          runtime,
          connectionId,
        });

        const durationMs = Date.now() - tickStart;
        const summary = `heartbeat: alert sent (${formatDuration(durationMs)})`;
        console.log(summary);
        heartbeatLogger.info(
          {
            connectionId,
            durationMs,
            hasMedia,
            chars: stripped.text?.length ?? 0,
          },
          "reply heartbeat sent",
        );
      } catch (err) {
        const durationMs = Date.now() - tickStart;
        heartbeatLogger.warn(
          {
            connectionId,
            error: String(err),
            durationMs,
          },
          "reply heartbeat failed",
        );
        console.log(
          danger(`heartbeat: failed (${formatDuration(durationMs)})`),
        );
      }
    };

    if (replyHeartbeatMinutes && !replyHeartbeatTimer) {
      const intervalMs = replyHeartbeatMinutes * 60_000;
      replyHeartbeatTimer = setInterval(() => {
        void runReplyHeartbeat();
      }, intervalMs);
      if (tuning.replyHeartbeatNow) {
        void runReplyHeartbeat();
      }
    }

    logInfo(
      "📡 Listening for personal WhatsApp Web inbound messages. Leave this running; Ctrl+C to stop.",
      runtime,
    );

    if (!keepAlive) {
      await closeListener();
      return;
    }

    const reason = await Promise.race([
      listener.onClose?.catch((err) => {
        reconnectLogger.error(
          { error: String(err) },
          "listener.onClose rejected",
        );
        return { status: 500, isLoggedOut: false, error: err };
      }) ?? waitForever(),
      abortPromise ?? waitForever(),
    ]);

    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > heartbeatSeconds * 1000) {
      reconnectAttempts = 0; // Healthy stretch; reset the backoff.
    }

    if (stopRequested() || sigintStop || reason === "aborted") {
      await closeListener();
      break;
    }

    const status =
      (typeof reason === "object" && reason && "status" in reason
        ? (reason as { status?: number }).status
        : undefined) ?? "unknown";
    const loggedOut =
      typeof reason === "object" &&
      reason &&
      "isLoggedOut" in reason &&
      (reason as { isLoggedOut?: boolean }).isLoggedOut;

    reconnectLogger.info(
      {
        connectionId,
        status,
        loggedOut,
        reconnectAttempts,
      },
      "web reconnect: connection closed",
    );

    if (loggedOut) {
      runtime.error(
        danger(
          "WhatsApp session logged out. Run `warelay login --provider web` to relink.",
        ),
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    if (
      reconnectPolicy.maxAttempts > 0 &&
      reconnectAttempts >= reconnectPolicy.maxAttempts
    ) {
      reconnectLogger.warn(
        {
          connectionId,
          status,
          reconnectAttempts,
          maxAttempts: reconnectPolicy.maxAttempts,
        },
        "web reconnect: max attempts reached",
      );
      runtime.error(
        danger(
          `WhatsApp Web connection closed (status ${status}). Reached max retries (${reconnectPolicy.maxAttempts}); exiting so you can relink.`,
        ),
      );
      await closeListener();
      break;
    }

    const delay = computeBackoff(reconnectPolicy, reconnectAttempts);
    reconnectLogger.info(
      {
        connectionId,
        status,
        reconnectAttempts,
        maxAttempts: reconnectPolicy.maxAttempts || "unlimited",
        delayMs: delay,
      },
      "web reconnect: scheduling retry",
    );
    runtime.error(
      danger(
        `WhatsApp Web connection closed (status ${status}). Retry ${reconnectAttempts}/${reconnectPolicy.maxAttempts || "∞"} in ${formatDuration(delay)}…`,
      ),
    );
    await closeListener();
    try {
      await sleep(delay, abortSignal);
    } catch {
      break;
    }
  }

  process.removeListener("SIGINT", handleSigint);
}

export { DEFAULT_WEB_MEDIA_BYTES };
