import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import { newConnectionId } from "../reconnect.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  HEARTBEAT_TOKEN,
  appendCronStyleCurrentTimeLine,
  canonicalizeMainSessionAlias,
  emitHeartbeatEvent,
  formatError,
  getRuntimeConfig,
  getChildLogger,
  getReplyFromConfig,
  hasOutboundReplyContent,
  loadSessionStore,
  normalizeMainKey,
  redactIdentifier,
  resolveHeartbeatPrompt,
  resolveHeartbeatReplyPayload,
  resolveHeartbeatVisibility,
  resolveIndicatorType,
  resolveSendableOutboundReplyParts,
  resolveSessionKey,
  resolveStorePath,
  resolveWhatsAppHeartbeatRecipients,
  sendMessageWhatsApp,
  stripHeartbeatToken,
  updateSessionStore,
  whatsappHeartbeatLog,
} from "./heartbeat-runner.runtime.js";
import { getSessionSnapshot } from "./session-snapshot.js";

function resolveDefaultAgentIdFromConfig(cfg: ReturnType<typeof getRuntimeConfig>): string {
  const agents = cfg.agents?.list ?? [];
  const chosen = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? "main";
  return normalizeOptionalLowercaseString(chosen) ?? "main";
}

export async function runWebHeartbeatOnce(opts: {
  cfg?: ReturnType<typeof getRuntimeConfig>;
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
  const redactedTo = redactIdentifier(to);
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to: redactedTo,
  });

  const cfg = cfgOverride ?? getRuntimeConfig();

  // Resolve heartbeat visibility settings for WhatsApp
  const visibility = resolveHeartbeatVisibility({ cfg, channel: "whatsapp" });
  const heartbeatOkText = HEARTBEAT_TOKEN;

  const maybeSendHeartbeatOk = async (): Promise<boolean> => {
    if (!visibility.showOk) {
      return false;
    }
    if (dryRun) {
      whatsappHeartbeatLog.info(`[dry-run] heartbeat ok -> ${redactedTo}`);
      return false;
    }
    const sendResult = await sender(to, heartbeatOkText, { verbose, cfg });
    heartbeatLogger.info(
      {
        to: redactedTo,
        messageId: sendResult.messageId,
        chars: heartbeatOkText.length,
        reason: "heartbeat-ok",
      },
      "heartbeat ok sent",
    );
    whatsappHeartbeatLog.info(`heartbeat ok sent to ${redactedTo} (id ${sendResult.messageId})`);
    return true;
  };

  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  // Canonicalize so the written key matches what read paths produce (#29683).
  const rawSessionKey = resolveSessionKey(sessionScope, { From: to }, mainKey);
  const sessionKey = canonicalizeMainSessionAlias({
    cfg,
    agentId: resolveDefaultAgentIdFromConfig(cfg),
    sessionKey: rawSessionKey,
  });
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
  const sessionSnapshot = getSessionSnapshot(cfg, to, true, { sessionKey });
  if (verbose) {
    heartbeatLogger.info(
      {
        to: redactedTo,
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
          `[dry-run] web send -> ${redactedTo} (${overrideBody.trim().length} chars, manual message)`,
        );
        return;
      }
      const sendResult = await sender(to, overrideBody, { verbose, cfg });
      emitHeartbeatEvent({
        status: "sent",
        to,
        preview: overrideBody.slice(0, 160),
        hasMedia: false,
        channel: "whatsapp",
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      });
      heartbeatLogger.info(
        {
          to: redactedTo,
          messageId: sendResult.messageId,
          chars: overrideBody.length,
          reason: "manual-message",
        },
        "manual heartbeat message sent",
      );
      whatsappHeartbeatLog.info(
        `manual heartbeat sent to ${redactedTo} (id ${sendResult.messageId})`,
      );
      return;
    }

    if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
      heartbeatLogger.info({ to: redactedTo, reason: "alerts-disabled" }, "heartbeat skipped");
      emitHeartbeatEvent({
        status: "skipped",
        to,
        reason: "alerts-disabled",
        channel: "whatsapp",
      });
      return;
    }

    const replyResult = await replyResolver(
      {
        Body: appendCronStyleCurrentTimeLine(
          resolveHeartbeatPrompt(cfg.agents?.defaults?.heartbeat?.prompt),
          cfg,
          Date.now(),
        ),
        From: to,
        To: to,
        MessageSid: sessionId ?? sessionSnapshot.entry?.sessionId,
      },
      { isHeartbeat: true },
      cfg,
    );
    const replyPayload = resolveHeartbeatReplyPayload(replyResult);

    if (!replyPayload || !hasOutboundReplyContent(replyPayload)) {
      heartbeatLogger.info(
        {
          to: redactedTo,
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
        },
        "heartbeat skipped",
      );
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-empty",
        to,
        channel: "whatsapp",
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-empty") : undefined,
      });
      return;
    }

    const reply = resolveSendableOutboundReplyParts(replyPayload);
    const hasMedia = reply.hasMedia;
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
          if (!nextEntry) {
            return;
          }
          nextStore[sessionSnapshot.key] = {
            ...nextEntry,
            updatedAt: sessionSnapshot.entry.updatedAt,
          };
        });
      }

      heartbeatLogger.info(
        { to: redactedTo, reason: "heartbeat-token", rawLength: replyPayload.text?.length },
        "heartbeat skipped",
      );
      const okSent = await maybeSendHeartbeatOk();
      emitHeartbeatEvent({
        status: "ok-token",
        to,
        channel: "whatsapp",
        silent: !okSent,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("ok-token") : undefined,
      });
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn(
        { to: redactedTo },
        "heartbeat reply contained media; sending text only",
      );
    }

    const finalText = stripped.text || reply.text;

    // Check if alerts are disabled for WhatsApp
    if (!visibility.showAlerts) {
      heartbeatLogger.info({ to: redactedTo, reason: "alerts-disabled" }, "heartbeat skipped");
      emitHeartbeatEvent({
        status: "skipped",
        to,
        reason: "alerts-disabled",
        preview: finalText.slice(0, 200),
        channel: "whatsapp",
        hasMedia,
        indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
      });
      return;
    }

    if (dryRun) {
      heartbeatLogger.info(
        { to: redactedTo, reason: "dry-run", chars: finalText.length },
        "heartbeat dry-run",
      );
      whatsappHeartbeatLog.info(`[dry-run] heartbeat -> ${redactedTo} (${finalText.length} chars)`);
      return;
    }

    const sendResult = await sender(to, finalText, { verbose, cfg });
    emitHeartbeatEvent({
      status: "sent",
      to,
      preview: finalText.slice(0, 160),
      hasMedia,
      channel: "whatsapp",
      indicatorType: visibility.useIndicator ? resolveIndicatorType("sent") : undefined,
    });
    heartbeatLogger.info(
      {
        to: redactedTo,
        messageId: sendResult.messageId,
        chars: finalText.length,
      },
      "heartbeat sent",
    );
    whatsappHeartbeatLog.info(`heartbeat alert sent to ${redactedTo}`);
  } catch (err) {
    const reason = formatError(err);
    heartbeatLogger.warn({ to: redactedTo, error: reason }, "heartbeat failed");
    whatsappHeartbeatLog.warn(`heartbeat failed (${reason})`);
    emitHeartbeatEvent({
      status: "failed",
      to,
      reason,
      channel: "whatsapp",
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    throw err;
  }
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof getRuntimeConfig>,
  opts: { to?: string; all?: boolean; accountId?: string } = {},
) {
  return resolveWhatsAppHeartbeatRecipients(cfg, opts);
}
