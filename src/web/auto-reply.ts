import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { danger, isVerbose, logVerbose, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { monitorWebInbox } from "./inbound.js";
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
export const HEARTBEAT_PROMPT =
  "HEARTBEAT ping — if nothing important happened, reply exactly HEARTBEAT_OK. Otherwise return a concise alert.";

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
  to: string;
  verbose?: boolean;
  replyResolver?: typeof getReplyFromConfig;
  runtime?: RuntimeEnv;
  sender?: typeof sendMessageWeb;
}) {
  const { to, verbose = false } = opts;
  const _runtime = opts.runtime ?? defaultRuntime;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendMessageWeb;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = loadConfig();

  try {
    const replyResult = await replyResolver(
      {
        Body: HEARTBEAT_PROMPT,
        From: to,
        To: to,
        MessageSid: undefined,
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
      heartbeatLogger.info({ to, reason: "empty-reply" }, "heartbeat skipped");
      if (verbose) console.log(success("heartbeat: ok (empty reply)"));
      return;
    }

    const hasMedia =
      (replyResult.mediaUrl ?? replyResult.mediaUrls?.length ?? 0) > 0;
    const stripped = stripHeartbeatToken(replyResult.text);
    if (stripped.shouldSkip && !hasMedia) {
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
    return (
      (Array.isArray(cfg.inbound?.allowFrom) && cfg.inbound.allowFrom[0]) ||
      null
    );
  }
  const mostRecent = candidates.sort(
    (a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0),
  )[0];
  return mostRecent ? normalizeE164(mostRecent[0]) : null;
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
    let replyHeartbeatTimer: NodeJS.Timeout | null = null;
    let lastMessageAt: number | null = null;
    let handledMessages = 0;
    let lastInboundMsg: WebInboundMsg | null = null;

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      onMessage: async (msg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        const ts = msg.timestamp
          ? new Date(msg.timestamp).toISOString()
          : new Date().toISOString();
        const correlationId = msg.id ?? newConnectionId();
        replyLogger.info(
          {
            connectionId,
            correlationId,
            from: msg.from,
            to: msg.to,
            body: msg.body,
            mediaType: msg.mediaType ?? null,
            mediaPath: msg.mediaPath ?? null,
          },
          "inbound web message",
        );

        console.log(`\n[${ts}] ${msg.from} -> ${msg.to}: ${msg.body}`);

        lastInboundMsg = msg;

        const replyResult = await (replyResolver ?? getReplyFromConfig)(
          {
            Body: msg.body,
            From: msg.from,
            To: msg.to,
            MessageSid: msg.id,
            MediaPath: msg.mediaPath,
            MediaUrl: msg.mediaUrl,
            MediaType: msg.mediaType,
          },
          {
            onReplyStart: msg.sendComposing,
          },
        );
        if (
          !replyResult ||
          (!replyResult.text &&
            !replyResult.mediaUrl &&
            !replyResult.mediaUrls?.length)
        ) {
          logVerbose(
            "Skipping auto-reply: no text/media returned from resolver",
          );
          return;
        }
        try {
          await deliverWebReply({
            replyResult,
            msg,
            maxMediaBytes,
            replyLogger,
            runtime,
            connectionId,
          });
          if (isVerbose()) {
            console.log(
              success(
                `↩️  Auto-replied to ${msg.from} (web${replyResult.mediaUrl || replyResult.mediaUrls?.length ? ", media" : ""})`,
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
            danger(
              `Failed sending web auto-reply to ${msg.from}: ${String(err)}`,
            ),
          );
        }
      },
    });

    const closeListener = async () => {
      if (heartbeat) clearInterval(heartbeat);
      if (replyHeartbeatTimer) clearInterval(replyHeartbeatTimer);
      try {
        await listener.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    };

    if (keepAlive) {
      heartbeat = setInterval(() => {
        const authAgeMs = getWebAuthAgeMs();
        heartbeatLogger.info(
          {
            connectionId,
            reconnectAttempts,
            messagesHandled: handledMessages,
            lastMessageAt,
            authAgeMs,
            uptimeMs: Date.now() - startedAt,
          },
          "web relay heartbeat",
        );
      }, heartbeatSeconds * 1000);
    }

    const runReplyHeartbeat = async () => {
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
        if (isVerbose()) {
          heartbeatLogger.info(
            { connectionId, to: fallbackTo, reason: "fallback-session" },
            "reply heartbeat start",
          );
        }
        await runWebHeartbeatOnce({
          to: fallbackTo,
          verbose,
          replyResolver,
          runtime,
        });
        return;
      }

      try {
        if (isVerbose()) {
          heartbeatLogger.info(
            {
              connectionId,
              to: lastInboundMsg.from,
              intervalMinutes: replyHeartbeatMinutes,
            },
            "reply heartbeat start",
          );
        }
        const replyResult = await (replyResolver ?? getReplyFromConfig)(
          {
            Body: HEARTBEAT_PROMPT,
            From: lastInboundMsg.from,
            To: lastInboundMsg.to,
            MessageSid: undefined,
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
        const hasMedia =
          (replyResult.mediaUrl ?? replyResult.mediaUrls?.length ?? 0) > 0;
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

        const cleanedReply: ReplyPayload = {
          ...replyResult,
          text: stripped.text,
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
      listener.onClose ?? waitForever(),
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
