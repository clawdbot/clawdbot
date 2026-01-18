import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
} from "../../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../../auto-reply/reply.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveWhatsAppHeartbeatRecipients } from "../../channels/plugins/whatsapp-heartbeat.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveSessionKey,
  resolveStorePath,
  updateSessionStore,
} from "../../config/sessions.js";
import { emitHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { getChildLogger } from "../../logging.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import { sendMessageWhatsApp } from "../outbound.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { whatsappHeartbeatLog } from "./loggers.js";
import { getSessionSnapshot } from "./session-snapshot.js";
import { elide } from "./util.js";

function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) return undefined;
  if (!Array.isArray(replyResult)) return replyResult;
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) continue;
    if (payload.text || payload.mediaUrl || (payload.mediaUrls && payload.mediaUrls.length > 0)) {
      return payload;
    }
  }
  return undefined;
}

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof loadConfig>;
  to: string;
  verbose?: boolean;
  replyResolver?: typeof getReplyFromConfig;
  sender?: typeof sendMessageWhatsApp;
  sessionId?: string;
  overrideBody?: string;
  dryRun?: boolean;
}) {
  const { cfg: cfgOverride, to, verbose = false, sessionId, overrideBody, dryRun = false } = opts;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendMessageWhatsApp;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = cfgOverride ?? loadConfig();
  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const sessionKey = resolveSessionKey(sessionScope, { From: to }, mainKey);
  if (sessionId) {
    const storePath = resolveStorePath(cfg.session?.store);
    const store = loadSessionStore(storePath);
    const current = store[sessionKey] ?? {};
    store[sessionKey] = {
      ...current,
      sessionId,
      updatedAt: Date.now(),
    };
    await updateSessionStore(storePath, (nextStore) => {
      const nextCurrent = nextStore[sessionKey] ?? current;
      nextStore[sessionKey] = {
        ...nextCurrent,
        sessionId,
        updatedAt: Date.now(),
      };
    });
  }
  const sessionSnapshot = getSessionSnapshot(cfg, to, true);
  if (verbose) {
    heartbeatLogger.info(
      {
        to,
        sessionKey: sessionSnapshot.key,
        sessionId: sessionId ?? sessionSnapshot.entry?.sessionId ?? null,
        sessionFresh: sessionSnapshot.fresh,
        resetMode: sessionSnapshot.resetPolicy.mode,
        resetAtHour: sessionSnapshot.resetPolicy.atHour,
        idleMinutes: sessionSnapshot.resetPolicy.idleMinutes ?? null,
        dailyResetAt: sessionSnapshot.dailyResetAt ?? null,
        idleExpiresAt: sessionSnapshot.idleExpiresAt ?? null,
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
        whatsappHeartbeatLog.info(
          `[dry-run] web send -> ${to}: ${elide(overrideBody.trim(), 200)} (manual message)`,
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose });
      emitHeartbeatEvent({
        status: "sent",
        to,
        preview: overrideBody.slice(0, 160),
        hasMedia: false,
      });
      heartbeatLogger.info(
        {
          to,
          messageId: sendResult.messageId,
          chars: overrideBody.length,
          reason: "manual-message",
        },
        "manual heartbeat message sent",
      );
      whatsappHeartbeatLog.info(`manual heartbeat sent to ${to} (id ${sendResult.messageId})`);
      return;
    }

    const replyResult = await replyResolver(
      {
        Body: resolveHeartbeatPrompt(cfg.agents?.defaults?.heartbeat?.prompt),
        From: to,
        To: to,
        MessageSid: sessionId ?? sessionSnapshot.entry?.sessionId,
      },
      { isHeartbeat: true },
      cfg,
    );
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);

    if (
      !replyPayload ||
      (!replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length)
    ) {
      heartbeatLogger.info(
        {
          to,
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
        },
        "heartbeat skipped",
      );
      emitHeartbeatEvent({ status: "ok-empty", to });
      return;
    }

    const hasMedia = Boolean(replyPayload.mediaUrl || (replyPayload.mediaUrls?.length ?? 0) > 0);
    const ackMaxChars = Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
    const stripped = stripHeartbeatToken(replyPayload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    if (stripped.shouldSkip && !hasMedia) {
      // Don't let heartbeats keep sessions alive: restore previous updatedAt so idle expiry still works.
      const storePath = resolveStorePath(cfg.session?.store);
      const store = loadSessionStore(storePath);
      if (sessionSnapshot.entry && store[sessionSnapshot.key]) {
        store[sessionSnapshot.key].updatedAt = sessionSnapshot.entry.updatedAt;
        await updateSessionStore(storePath, (nextStore) => {
          const nextEntry = nextStore[sessionSnapshot.key];
          if (!nextEntry) return;
          nextStore[sessionSnapshot.key] = {
            ...nextEntry,
            updatedAt: sessionSnapshot.entry.updatedAt,
          };
        });
      }

      heartbeatLogger.info(
        { to, reason: "heartbeat-token", rawLength: replyPayload.text?.length },
        "heartbeat skipped",
      );
      emitHeartbeatEvent({ status: "ok-token", to });
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn({ to }, "heartbeat reply contained media; sending text only");
    }

    const finalText = stripped.text || replyPayload.text || "";
    if (dryRun) {
      heartbeatLogger.info({ to, reason: "dry-run", chars: finalText.length }, "heartbeat dry-run");
      whatsappHeartbeatLog.info(`[dry-run] heartbeat -> ${to}: ${elide(finalText, 200)}`);
      return;
    }

    const sendResult = await sender(to, finalText, { verbose });
    emitHeartbeatEvent({
      status: "sent",
      to,
      preview: finalText.slice(0, 160),
      hasMedia,
    });
    heartbeatLogger.info(
      {
        to,
        messageId: sendResult.messageId,
        chars: finalText.length,
        preview: elide(finalText, 140),
      },
      "heartbeat sent",
    );
    whatsappHeartbeatLog.info(`heartbeat alert sent to ${to}`);
  } catch (err) {
    const reason = formatError(err);
    heartbeatLogger.warn({ to, error: reason }, "heartbeat failed");
    whatsappHeartbeatLog.warn(`heartbeat failed (${reason})`);
    emitHeartbeatEvent({ status: "failed", to, reason });
    throw err;
  }
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean } = {},
) {
  return resolveWhatsAppHeartbeatRecipients(cfg, opts);
}
