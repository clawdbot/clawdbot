import {
  resolveEffectiveMessagesConfig,
  resolveMessagePrefix,
} from "../agents/identity.js";
import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../auto-reply/group-activation.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  HEARTBEAT_PROMPT,
  resolveHeartbeatPrompt,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  normalizeMentionText,
} from "../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import { HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { waitForever } from "../cli/wait.js";
import { loadConfig } from "../config/config.js";
import {
  resolveProviderGroupPolicy,
  resolveProviderGroupRequireMention,
} from "../config/group-policy.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveGroupSessionKey,
  resolveSessionKey,
  resolveStorePath,
  saveSessionStore,
  updateLastRoute,
} from "../config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { formatDurationMs } from "../infra/format-duration.js";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { registerUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { createSubsystemLogger, getChildLogger } from "../logging.js";
import { toLocationContext } from "../providers/location.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { isSelfChatMode, jidToE164, normalizeE164 } from "../utils.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import { setActiveWebListener } from "./active-listener.js";
import { monitorWebInbox } from "./inbound.js";
import { loadWebMedia } from "./media.js";
import { sendMessageWhatsApp } from "./outbound.js";
import {
  computeBackoff,
  newConnectionId,
  type ReconnectPolicy,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort,
} from "./reconnect.js";
import { formatError, getWebAuthAgeMs, readWebSelfId } from "./session.js";

const DEFAULT_GROUP_HISTORY_LIMIT = 50;
const whatsappLog = createSubsystemLogger("gateway/providers/whatsapp");
const whatsappInboundLog = whatsappLog.child("inbound");
const whatsappOutboundLog = whatsappLog.child("outbound");
const whatsappHeartbeatLog = whatsappLog.child("heartbeat");

const isLikelyWhatsAppCryptoError = (reason: unknown) => {
  const formatReason = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (value instanceof Error) {
      return `${value.message}\n${value.stack ?? ""}`;
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "bigint") return String(value);
    if (typeof value === "symbol") return value.description ?? value.toString();
    if (typeof value === "function")
      return value.name ? `[function ${value.name}]` : "[function]";
    return Object.prototype.toString.call(value);
  };
  const raw =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack ?? ""}`
      : formatReason(reason);
  const haystack = raw.toLowerCase();
  const hasAuthError =
    haystack.includes("unsupported state or unable to authenticate data") ||
    haystack.includes("bad mac");
  if (!hasAuthError) return false;
  return (
    haystack.includes("@whiskeysockets/baileys") ||
    haystack.includes("baileys") ||
    haystack.includes("noise-handler") ||
    haystack.includes("aesdecryptgcm")
  );
};

// Send via the active gateway-backed listener. The monitor already owns the single
// Baileys session, so use its send API directly.
async function sendWithIpcFallback(
  to: string,
  message: string,
  opts: { verbose: boolean; mediaUrl?: string },
): Promise<{ messageId: string; toJid: string }> {
  return sendMessageWhatsApp(to, message, opts);
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
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  statusSink?: (status: WebProviderStatus) => void;
  /** WhatsApp account id. Default: "default". */
  accountId?: string;
};

export { HEARTBEAT_PROMPT, HEARTBEAT_TOKEN, SILENT_REPLY_TOKEN };

export type WebProviderStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
};

function elide(text?: string, limit = 400) {
  if (!text) return text;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (truncated ${text.length - limit} chars)`;
}

type MentionConfig = {
  mentionRegexes: RegExp[];
  allowFrom?: Array<string | number>;
};

function buildMentionConfig(
  cfg: ReturnType<typeof loadConfig>,
  agentId?: string,
): MentionConfig {
  const mentionRegexes = buildMentionRegexes(cfg, agentId);
  return { mentionRegexes, allowFrom: cfg.whatsapp?.allowFrom };
}

function isBotMentioned(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
): boolean {
  const clean = (text: string) =>
    // Remove zero-width and directionality markers WhatsApp injects around display names
    normalizeMentionText(text);

  const isSelfChat = isSelfChatMode(msg.selfE164, mentionCfg.allowFrom);

  if (msg.mentionedJids?.length && !isSelfChat) {
    const normalizedMentions = msg.mentionedJids
      .map((jid) => jidToE164(jid) ?? jid)
      .filter(Boolean);
    if (msg.selfE164 && normalizedMentions.includes(msg.selfE164)) return true;
    if (msg.selfJid && msg.selfE164) {
      // Some mentions use the bare JID; match on E.164 to be safe.
      const bareSelf = msg.selfJid.replace(/:\\d+/, "");
      if (normalizedMentions.includes(bareSelf)) return true;
    }
  } else if (msg.mentionedJids?.length && isSelfChat) {
    // Self-chat mode: ignore WhatsApp @mention JIDs, otherwise @mentioning the owner in group chats triggers the bot.
  }
  const bodyClean = clean(msg.body);
  if (mentionCfg.mentionRegexes.some((re) => re.test(bodyClean))) return true;

  // Fallback: detect body containing our own number (with or without +, spacing)
  if (msg.selfE164) {
    const selfDigits = msg.selfE164.replace(/\D/g, "");
    if (selfDigits) {
      const bodyDigits = bodyClean.replace(/[^\d]/g, "");
      if (bodyDigits.includes(selfDigits)) return true;
      const bodyNoSpace = msg.body.replace(/[\s-]/g, "");
      const pattern = new RegExp(`\\+?${selfDigits}`, "i");
      if (pattern.test(bodyNoSpace)) return true;
    }
  }

  return false;
}

function debugMention(
  msg: WebInboundMsg,
  mentionCfg: MentionConfig,
): { wasMentioned: boolean; details: Record<string, unknown> } {
  const result = isBotMentioned(msg, mentionCfg);
  const details = {
    from: msg.from,
    body: msg.body,
    bodyClean: normalizeMentionText(msg.body),
    mentionedJids: msg.mentionedJids ?? null,
    selfJid: msg.selfJid ?? null,
    selfE164: msg.selfE164 ?? null,
  };
  return { wasMentioned: result, details };
}

export { stripHeartbeatToken };

function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) return undefined;
  if (!Array.isArray(replyResult)) return replyResult;
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) continue;
    if (
      payload.text ||
      payload.mediaUrl ||
      (payload.mediaUrls && payload.mediaUrls.length > 0)
    ) {
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
  const {
    cfg: cfgOverride,
    to,
    verbose = false,
    sessionId,
    overrideBody,
    dryRun = false,
  } = opts;
  const replyResolver = opts.replyResolver ?? getReplyFromConfig;
  const sender = opts.sender ?? sendWithIpcFallback;
  const runId = newConnectionId();
  const heartbeatLogger = getChildLogger({
    module: "web-heartbeat",
    runId,
    to,
  });

  const cfg = cfgOverride ?? loadConfig();
  const sessionCfg = cfg.session;
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = sessionCfg?.mainKey;
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
      whatsappHeartbeatLog.info(
        `manual heartbeat sent to ${to} (id ${sendResult.messageId})`,
      );
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
      (!replyPayload.text &&
        !replyPayload.mediaUrl &&
        !replyPayload.mediaUrls?.length)
    ) {
      heartbeatLogger.info(
        {
          to,
          reason: "empty-reply",
          sessionId: sessionSnapshot.entry?.sessionId ?? null,
        },
        "heartbeat skipped",
      );
      if (shouldLogVerbose()) {
        whatsappHeartbeatLog.debug("heartbeat ok (empty reply)");
      }
      emitHeartbeatEvent({ status: "ok-empty", to });
      return;
    }

    const hasMedia = Boolean(
      replyPayload.mediaUrl || (replyPayload.mediaUrls?.length ?? 0) > 0,
    );
    const ackMaxChars = Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
        DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
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
        await saveSessionStore(storePath, store);
      }

      heartbeatLogger.info(
        { to, reason: "heartbeat-token", rawLength: replyPayload.text?.length },
        "heartbeat skipped",
      );
      if (shouldLogVerbose()) {
        whatsappHeartbeatLog.debug("heartbeat ok (HEARTBEAT_OK)");
      }
      emitHeartbeatEvent({ status: "ok-token", to });
      return;
    }

    if (hasMedia) {
      heartbeatLogger.warn(
        { to },
        "heartbeat reply contained media; sending text only",
      );
    }

    const finalText = stripped.text || replyPayload.text || "";
    if (dryRun) {
      heartbeatLogger.info(
        { to, reason: "dry-run", chars: finalText.length },
        "heartbeat dry-run",
      );
      whatsappHeartbeatLog.info(
        `[dry-run] heartbeat -> ${to}: ${elide(finalText, 200)}`,
      );
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

function getSessionRecipients(cfg: ReturnType<typeof loadConfig>) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  if (scope === "global") return [];
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const isGroupKey = (key: string) =>
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:") ||
    key.includes("@g.us");
  const isCronKey = (key: string) => key.startsWith("cron:");

  const recipients = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .filter(([key]) => !isGroupKey(key) && !isCronKey(key))
    .map(([_, entry]) => ({
      to:
        entry?.lastProvider === "whatsapp" && entry?.lastTo
          ? normalizeE164(entry.lastTo)
          : "",
      updatedAt: entry?.updatedAt ?? 0,
    }))
    .filter(({ to }) => to.length > 1)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Dedupe while preserving recency ordering.
  const seen = new Set<string>();
  return recipients.filter((r) => {
    if (seen.has(r.to)) return false;
    seen.add(r.to);
    return true;
  });
}

export function resolveHeartbeatRecipients(
  cfg: ReturnType<typeof loadConfig>,
  opts: { to?: string; all?: boolean } = {},
) {
  if (opts.to) return { recipients: [normalizeE164(opts.to)], source: "flag" };

  const sessionRecipients = getSessionRecipients(cfg);
  const allowFrom =
    Array.isArray(cfg.whatsapp?.allowFrom) && cfg.whatsapp.allowFrom.length > 0
      ? cfg.whatsapp.allowFrom.filter((v) => v !== "*").map(normalizeE164)
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
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const key = resolveSessionKey(
    scope,
    { From: from, To: "", Body: "" },
    sessionCfg?.mainKey,
  );
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
  textLimit: number;
  replyLogger: ReturnType<typeof getChildLogger>;
  connectionId?: string;
  skipLog?: boolean;
}) {
  const {
    replyResult,
    msg,
    maxMediaBytes,
    textLimit,
    replyLogger,
    connectionId,
    skipLog,
  } = params;
  const replyStarted = Date.now();
  const textChunks = chunkMarkdownText(replyResult.text || "", textLimit);
  const mediaList = replyResult.mediaUrls?.length
    ? replyResult.mediaUrls
    : replyResult.mediaUrl
      ? [replyResult.mediaUrl]
      : [];

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const sendWithRetry = async (
    fn: () => Promise<unknown>,
    label: string,
    maxAttempts = 3,
  ) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatError(err);
        const isLast = attempt === maxAttempts;
        const shouldRetry = /closed|reset|timed\s*out|disconnect/i.test(
          errText,
        );
        if (!shouldRetry || isLast) {
          throw err;
        }
        const backoffMs = 500 * attempt;
        logVerbose(
          `Retrying ${label} to ${msg.from} after failure (${attempt}/${maxAttempts - 1}) in ${backoffMs}ms: ${errText}`,
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      await sendWithRetry(() => msg.reply(chunk), "text");
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${msg.from} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    replyLogger.info(
      {
        correlationId: msg.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: msg.from,
        from: msg.to,
        text: elide(replyResult.text, 240),
        mediaUrl: null,
        mediaSizeBytes: null,
        mediaKind: null,
        durationMs: Date.now() - replyStarted,
      },
      "auto-reply sent (text)",
    );
    return;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  for (const [index, mediaUrl] of mediaList.entries()) {
    const caption =
      index === 0 ? remainingText.shift() || undefined : undefined;
    try {
      const media = await loadWebMedia(mediaUrl, maxMediaBytes);
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(
          `Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`,
        );
      }
      if (media.kind === "image") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              image: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:image",
        );
      } else if (media.kind === "audio") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              audio: media.buffer,
              ptt: true,
              mimetype: media.contentType,
              caption,
            }),
          "media:audio",
        );
      } else if (media.kind === "video") {
        await sendWithRetry(
          () =>
            msg.sendMedia({
              video: media.buffer,
              caption,
              mimetype: media.contentType,
            }),
          "media:video",
        );
      } else {
        const fileName = media.fileName ?? mediaUrl.split("/").pop() ?? "file";
        const mimetype = media.contentType ?? "application/octet-stream";
        await sendWithRetry(
          () =>
            msg.sendMedia({
              document: media.buffer,
              fileName,
              caption,
              mimetype,
            }),
          "media:document",
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${msg.from} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: msg.from,
          from: msg.to,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    } catch (err) {
      whatsappOutboundLog.error(
        `Failed sending web media to ${msg.from}: ${formatError(err)}`,
      );
      replyLogger.warn({ err, mediaUrl }, "failed to send web media reply");
      if (index === 0) {
        const warning =
          err instanceof Error
            ? `⚠️ Media failed: ${err.message}`
            : "⚠️ Media failed.";
        const fallbackTextParts = [
          remainingText.shift() ?? caption ?? "",
          warning,
        ].filter(Boolean);
        const fallbackText = fallbackTextParts.join("\n");
        if (fallbackText) {
          whatsappOutboundLog.warn(
            `Media skipped; sent text-only to ${msg.from}`,
          );
          await msg.reply(fallbackText);
        }
      }
    }
  }

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    await msg.reply(chunk);
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
  const status: WebProviderStatus = {
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
      lastDisconnect: status.lastDisconnect
        ? { ...status.lastDisconnect }
        : null,
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
    whatsapp: {
      ...baseCfg.whatsapp,
      allowFrom: account.allowFrom,
      groupAllowFrom: account.groupAllowFrom,
      groupPolicy: account.groupPolicy,
      textChunkLimit: account.textChunkLimit,
      groups: account.groups,
    },
  } satisfies ReturnType<typeof loadConfig>;
  const configuredMaxMb = cfg.agents?.defaults?.mediaMaxMb;
  const maxMediaBytes =
    typeof configuredMaxMb === "number" && configuredMaxMb > 0
      ? configuredMaxMb * 1024 * 1024
      : DEFAULT_WEB_MEDIA_BYTES;
  const heartbeatSeconds = resolveHeartbeatSeconds(
    cfg,
    tuning.heartbeatSeconds,
  );
  const reconnectPolicy = resolveReconnectPolicy(cfg, tuning.reconnect);
  const resolveMentionConfig = (agentId?: string) =>
    buildMentionConfig(cfg, agentId);
  const baseMentionConfig = resolveMentionConfig();
  const groupHistoryLimit =
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT;
  const groupHistories = new Map<
    string,
    Array<{ sender: string; body: string; timestamp?: number }>
  >();
  const groupMemberNames = new Map<string, Map<string, string>>();
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

  const noteGroupMember = (
    conversationId: string,
    e164?: string,
    name?: string,
  ) => {
    if (!e164 || !name) return;
    const normalized = normalizeE164(e164);
    const key = normalized ?? e164;
    if (!key) return;
    let roster = groupMemberNames.get(conversationId);
    if (!roster) {
      roster = new Map();
      groupMemberNames.set(conversationId, roster);
    }
    roster.set(key, name);
  };

  const formatGroupMembers = (
    participants: string[] | undefined,
    roster: Map<string, string> | undefined,
    fallbackE164?: string,
  ) => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    if (participants?.length) {
      for (const entry of participants) {
        if (!entry) continue;
        const normalized = normalizeE164(entry) ?? entry;
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        ordered.push(normalized);
      }
    }
    if (roster) {
      for (const entry of roster.keys()) {
        const normalized = normalizeE164(entry) ?? entry;
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        ordered.push(normalized);
      }
    }
    if (ordered.length === 0 && fallbackE164) {
      const normalized = normalizeE164(fallbackE164) ?? fallbackE164;
      if (normalized) ordered.push(normalized);
    }
    if (ordered.length === 0) return undefined;
    return ordered
      .map((entry) => {
        const name = roster?.get(entry);
        return name ? `${name} (${entry})` : entry;
      })
      .join(", ");
  };

  const resolveGroupResolution = (conversationId: string) =>
    resolveGroupSessionKey({
      From: conversationId,
      ChatType: "group",
      Provider: "whatsapp",
    });

  const resolveGroupPolicyFor = (conversationId: string) => {
    const groupId =
      resolveGroupResolution(conversationId)?.id ?? conversationId;
    return resolveProviderGroupPolicy({
      cfg,
      provider: "whatsapp",
      groupId,
    });
  };

  const resolveGroupRequireMentionFor = (conversationId: string) => {
    const groupId =
      resolveGroupResolution(conversationId)?.id ?? conversationId;
    return resolveProviderGroupRequireMention({
      cfg,
      provider: "whatsapp",
      groupId,
    });
  };

  const resolveGroupActivationFor = (params: {
    agentId: string;
    sessionKey: string;
    conversationId: string;
  }) => {
    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: params.agentId,
    });
    const store = loadSessionStore(storePath);
    const entry = store[params.sessionKey];
    const requireMention = resolveGroupRequireMentionFor(params.conversationId);
    const defaultActivation = requireMention === false ? "always" : "mention";
    return (
      normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation
    );
  };

  const resolveOwnerList = (selfE164?: string | null) => {
    const allowFrom = baseMentionConfig.allowFrom;
    const raw =
      Array.isArray(allowFrom) && allowFrom.length > 0
        ? allowFrom
        : selfE164
          ? [selfE164]
          : [];
    return raw
      .filter((entry): entry is string => Boolean(entry && entry !== "*"))
      .map((entry) => normalizeE164(entry))
      .filter((entry): entry is string => Boolean(entry));
  };

  const isOwnerSender = (msg: WebInboundMsg) => {
    const sender = normalizeE164(msg.senderE164 ?? "");
    if (!sender) return false;
    const owners = resolveOwnerList(msg.selfE164 ?? undefined);
    return owners.includes(sender);
  };

  const isStatusCommand = (body: string) => {
    const trimmed = body.trim().toLowerCase();
    if (!trimmed) return false;
    return (
      trimmed === "/status" ||
      trimmed === "status" ||
      trimmed.startsWith("/status ")
    );
  };

  const stripMentionsForCommand = (
    text: string,
    mentionRegexes: RegExp[],
    selfE164?: string | null,
  ) => {
    let result = text;
    for (const re of mentionRegexes) {
      result = result.replace(re, " ");
    }
    if (selfE164) {
      const digits = selfE164.replace(/\D/g, "");
      if (digits) {
        const pattern = new RegExp(`\\+?${digits}`, "g");
        result = result.replace(pattern, " ");
      }
    }
    return result.replace(/\s+/g, " ").trim();
  };

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

  // Track recently sent messages to prevent echo loops
  const recentlySent = new Set<string>();
  const MAX_RECENT_MESSAGES = 100;
  const rememberSentText = (
    text: string | undefined,
    opts: { combinedBody: string; logVerboseMessage?: boolean },
  ) => {
    if (!text) return;
    recentlySent.add(text);
    if (opts.combinedBody) {
      recentlySent.add(opts.combinedBody);
    }
    if (opts.logVerboseMessage) {
      logVerbose(
        `Added to echo detection set (size now: ${recentlySent.size}): ${text.substring(0, 50)}...`,
      );
    }
    if (recentlySent.size > MAX_RECENT_MESSAGES) {
      const firstKey = recentlySent.values().next().value;
      if (firstKey) recentlySent.delete(firstKey);
    }
  };

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
    // Should be significantly longer than the reply heartbeat interval to avoid false positives
    const MESSAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes without any messages
    const WATCHDOG_CHECK_MS = 60 * 1000; // Check every minute

    const backgroundTasks = new Set<Promise<unknown>>();

    const formatReplyContext = (msg: WebInboundMsg) => {
      if (!msg.replyToBody) return null;
      const sender = msg.replyToSender ?? "unknown sender";
      const idPart = msg.replyToId ? ` id:${msg.replyToId}` : "";
      return `[Replying to ${sender}${idPart}]\n${msg.replyToBody}\n[/Replying]`;
    };

    const buildLine = (msg: WebInboundMsg, agentId: string) => {
      // Build message prefix: explicit config > identity name > default based on allowFrom
      const messagePrefix = resolveMessagePrefix(cfg, agentId, {
        hasAllowFrom: (cfg.whatsapp?.allowFrom?.length ?? 0) > 0,
      });
      const prefixStr = messagePrefix ? `${messagePrefix} ` : "";
      const senderLabel =
        msg.chatType === "group"
          ? `${msg.senderName ?? msg.senderE164 ?? "Someone"}: `
          : "";
      const replyContext = formatReplyContext(msg);
      const baseLine = `${prefixStr}${senderLabel}${msg.body}${
        replyContext ? `\n\n${replyContext}` : ""
      }`;

      // Wrap with standardized envelope for the agent.
      return formatAgentEnvelope({
        provider: "WhatsApp",
        from:
          msg.chatType === "group"
            ? msg.from
            : msg.from?.replace(/^whatsapp:/, ""),
        timestamp: msg.timestamp,
        body: baseLine,
      });
    };

    const processMessage = async (
      msg: WebInboundMsg,
      route: ReturnType<typeof resolveAgentRoute>,
    ) => {
      status.lastMessageAt = Date.now();
      status.lastEventAt = status.lastMessageAt;
      emitStatus();
      const conversationId = msg.conversationId ?? msg.from;
      let combinedBody = buildLine(msg, route.agentId);
      let shouldClearGroupHistory = false;

      if (msg.chatType === "group") {
        const history = groupHistories.get(route.sessionKey) ?? [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((m) =>
              formatAgentEnvelope({
                provider: "WhatsApp",
                from: conversationId,
                timestamp: m.timestamp,
                body: `${m.sender}: ${m.body}`,
              }),
            )
            .join("\\n");
          combinedBody = `[Chat messages since your last reply - for context]\\n${historyText}\\n\\n[Current message - respond to this]\\n${buildLine(
            msg,
            route.agentId,
          )}`;
        }
        // Always surface who sent the triggering message so the agent can address them.
        const senderLabel =
          msg.senderName && msg.senderE164
            ? `${msg.senderName} (${msg.senderE164})`
            : (msg.senderName ?? msg.senderE164 ?? "Unknown");
        combinedBody = `${combinedBody}\\n[from: ${senderLabel}]`;
        shouldClearGroupHistory = true;
      }

      // Echo detection uses combined body so we don't respond twice.
      if (recentlySent.has(combinedBody)) {
        logVerbose(`Skipping auto-reply: detected echo for combined message`);
        recentlySent.delete(combinedBody);
        return;
      }

      const correlationId = msg.id ?? newConnectionId();
      replyLogger.info(
        {
          connectionId,
          correlationId,
          from: msg.chatType === "group" ? conversationId : msg.from,
          to: msg.to,
          body: elide(combinedBody, 240),
          mediaType: msg.mediaType ?? null,
          mediaPath: msg.mediaPath ?? null,
        },
        "inbound web message",
      );

      const fromDisplay = msg.chatType === "group" ? conversationId : msg.from;
      const kindLabel = msg.mediaType ? `, ${msg.mediaType}` : "";
      whatsappInboundLog.info(
        `Inbound message ${fromDisplay} -> ${msg.to} (${msg.chatType}${kindLabel}, ${combinedBody.length} chars)`,
      );
      if (shouldLogVerbose()) {
        whatsappInboundLog.debug(`Inbound body: ${elide(combinedBody, 400)}`);
      }

      if (msg.chatType !== "group") {
        const sessionCfg = cfg.session;
        const storePath = resolveStorePath(sessionCfg?.store, {
          agentId: route.agentId,
        });
        const to = (() => {
          if (msg.senderE164) return normalizeE164(msg.senderE164);
          // In direct chats, `msg.from` is already the canonical conversation id,
          // which is an E.164 string (e.g. "+1555"). Only fall back to JID parsing
          // when we were handed a JID-like string.
          if (msg.from.includes("@")) return jidToE164(msg.from);
          return normalizeE164(msg.from);
        })();
        if (to) {
          const task = updateLastRoute({
            storePath,
            sessionKey: route.mainSessionKey,
            provider: "whatsapp",
            to,
            accountId: route.accountId,
          }).catch((err) => {
            replyLogger.warn(
              {
                error: formatError(err),
                storePath,
                sessionKey: route.mainSessionKey,
                to,
              },
              "failed updating last route",
            );
          });
          backgroundTasks.add(task);
          void task.finally(() => {
            backgroundTasks.delete(task);
          });
        }
      }

      const textLimit = resolveTextChunkLimit(cfg, "whatsapp");
      let didLogHeartbeatStrip = false;
      let didSendReply = false;
      const responsePrefix = resolveEffectiveMessagesConfig(
        cfg,
        route.agentId,
      ).responsePrefix;
      const { dispatcher, replyOptions, markDispatchIdle } =
        createReplyDispatcherWithTyping({
          responsePrefix,
          onHeartbeatStrip: () => {
            if (!didLogHeartbeatStrip) {
              didLogHeartbeatStrip = true;
              logVerbose("Stripped stray HEARTBEAT_OK token from web reply");
            }
          },
          deliver: async (payload, info) => {
            await deliverWebReply({
              replyResult: payload,
              msg,
              maxMediaBytes,
              textLimit,
              replyLogger,
              connectionId,
              // Tool + block updates are noisy; skip their log lines.
              skipLog: info.kind !== "final",
            });
            didSendReply = true;
            if (info.kind === "tool") {
              rememberSentText(payload.text, { combinedBody: "" });
              return;
            }
            const shouldLog =
              info.kind === "final" && payload.text ? true : undefined;
            rememberSentText(payload.text, {
              combinedBody,
              logVerboseMessage: shouldLog,
            });
            if (info.kind === "final") {
              const fromDisplay =
                msg.chatType === "group"
                  ? conversationId
                  : (msg.from ?? "unknown");
              const hasMedia = Boolean(
                payload.mediaUrl || payload.mediaUrls?.length,
              );
              whatsappOutboundLog.info(
                `Auto-replied to ${fromDisplay}${hasMedia ? " (media)" : ""}`,
              );
              if (shouldLogVerbose()) {
                const preview =
                  payload.text != null ? elide(payload.text, 400) : "<media>";
                whatsappOutboundLog.debug(
                  `Reply body: ${preview}${hasMedia ? " (media)" : ""}`,
                );
              }
            }
          },
          onError: (err, info) => {
            const label =
              info.kind === "tool"
                ? "tool update"
                : info.kind === "block"
                  ? "block update"
                  : "auto-reply";
            whatsappOutboundLog.error(
              `Failed sending web ${label} to ${msg.from ?? conversationId}: ${formatError(err)}`,
            );
          },
          onReplyStart: msg.sendComposing,
        });

      const { queuedFinal } = await dispatchReplyFromConfig({
        ctx: {
          Body: combinedBody,
          From: msg.from,
          To: msg.to,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          MessageSid: msg.id,
          ReplyToId: msg.replyToId,
          ReplyToBody: msg.replyToBody,
          ReplyToSender: msg.replyToSender,
          MediaPath: msg.mediaPath,
          MediaUrl: msg.mediaUrl,
          MediaType: msg.mediaType,
          ChatType: msg.chatType,
          GroupSubject: msg.groupSubject,
          GroupMembers: formatGroupMembers(
            msg.groupParticipants,
            groupMemberNames.get(route.sessionKey),
            msg.senderE164,
          ),
          SenderName: msg.senderName,
          SenderE164: msg.senderE164,
          WasMentioned: msg.wasMentioned,
          ...(msg.location ? toLocationContext(msg.location) : {}),
          Provider: "whatsapp",
          Surface: "whatsapp",
          OriginatingChannel: "whatsapp",
          OriginatingTo: msg.from,
        },
        cfg,
        dispatcher,
        replyResolver,
        replyOptions,
      });
      markDispatchIdle();
      if (!queuedFinal) {
        if (shouldClearGroupHistory && didSendReply) {
          groupHistories.set(route.sessionKey, []);
        }
        logVerbose(
          "Skipping auto-reply: silent token or no text/media returned from resolver",
        );
        return;
      }

      if (shouldClearGroupHistory && didSendReply) {
        groupHistories.set(route.sessionKey, []);
      }
    };

    const listener = await (listenerFactory ?? monitorWebInbox)({
      verbose,
      accountId: account.accountId,
      authDir: account.authDir,
      onMessage: async (msg) => {
        handledMessages += 1;
        lastMessageAt = Date.now();
        status.lastMessageAt = lastMessageAt;
        status.lastEventAt = lastMessageAt;
        emitStatus();
        _lastInboundMsg = msg;
        const conversationId = msg.conversationId ?? msg.from;
        const peerId =
          msg.chatType === "group"
            ? conversationId
            : (() => {
                if (msg.senderE164) {
                  return normalizeE164(msg.senderE164) ?? msg.senderE164;
                }
                if (msg.from.includes("@")) {
                  return jidToE164(msg.from) ?? msg.from;
                }
                return normalizeE164(msg.from) ?? msg.from;
              })();
        const route = resolveAgentRoute({
          cfg,
          provider: "whatsapp",
          accountId: msg.accountId,
          peer: {
            kind: msg.chatType === "group" ? "group" : "dm",
            id: peerId,
          },
        });
        const groupHistoryKey = route.sessionKey;

        // Same-phone mode logging retained
        if (msg.from === msg.to) {
          logVerbose(`📱 Same-phone mode detected (from === to: ${msg.from})`);
        }

        // Skip if this is a message we just sent (echo detection)
        if (recentlySent.has(msg.body)) {
          whatsappInboundLog.debug(
            "Skipping echo: detected recently sent message",
          );
          logVerbose(
            `Skipping auto-reply: detected echo (message matches recently sent text)`,
          );
          recentlySent.delete(msg.body);
          return;
        }

        if (msg.chatType === "group") {
          const groupPolicy = resolveGroupPolicyFor(conversationId);
          if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
            logVerbose(
              `Skipping group message ${conversationId} (not in allowlist)`,
            );
            return;
          }
          {
            const storePath = resolveStorePath(cfg.session?.store, {
              agentId: route.agentId,
            });
            const task = updateLastRoute({
              storePath,
              sessionKey: route.sessionKey,
              provider: "whatsapp",
              to: conversationId,
              accountId: route.accountId,
            }).catch((err) => {
              replyLogger.warn(
                {
                  error: formatError(err),
                  storePath,
                  sessionKey: route.sessionKey,
                  to: conversationId,
                },
                "failed updating last route",
              );
            });
            backgroundTasks.add(task);
            void task.finally(() => {
              backgroundTasks.delete(task);
            });
          }
          noteGroupMember(groupHistoryKey, msg.senderE164, msg.senderName);
          const mentionConfig = resolveMentionConfig(route.agentId);
          const commandBody = stripMentionsForCommand(
            msg.body,
            mentionConfig.mentionRegexes,
            msg.selfE164,
          );
          const activationCommand = parseActivationCommand(commandBody);
          const isOwner = isOwnerSender(msg);
          const statusCommand = isStatusCommand(commandBody);
          const shouldBypassMention =
            isOwner && (activationCommand.hasCommand || statusCommand);

          if (activationCommand.hasCommand && !isOwner) {
            logVerbose(
              `Ignoring /activation from non-owner in group ${conversationId}`,
            );
            return;
          }

          if (!shouldBypassMention) {
            const history =
              groupHistories.get(groupHistoryKey) ??
              ([] as Array<{
                sender: string;
                body: string;
                timestamp?: number;
              }>);
            history.push({
              sender: msg.senderName ?? msg.senderE164 ?? "Unknown",
              body: msg.body,
              timestamp: msg.timestamp,
            });
            while (history.length > groupHistoryLimit) history.shift();
            groupHistories.set(groupHistoryKey, history);
          }

          const mentionDebug = debugMention(msg, mentionConfig);
          replyLogger.debug(
            {
              conversationId,
              wasMentioned: mentionDebug.wasMentioned,
              ...mentionDebug.details,
            },
            "group mention debug",
          );
          const wasMentioned = mentionDebug.wasMentioned;
          msg.wasMentioned = wasMentioned;
          const activation = resolveGroupActivationFor({
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            conversationId,
          });
          const requireMention = activation !== "always";
          if (!shouldBypassMention && requireMention && !wasMentioned) {
            logVerbose(
              `Group message stored for context (no mention detected) in ${conversationId}: ${msg.body}`,
            );
            return;
          }
        }

        return processMessage(msg, route);
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
      provider: "whatsapp",
      accountId: account.accountId,
    });
    enqueueSystemEvent(
      `WhatsApp gateway connected${selfE164 ? ` as ${selfE164}` : ""}.`,
      { sessionKey: connectRoute.sessionKey },
    );

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

        // Warn if no messages in 30+ minutes
        if (minutesSinceLastMessage && minutesSinceLastMessage > 30) {
          heartbeatLogger.warn(
            logData,
            "⚠️ web gateway heartbeat - no messages in 30+ minutes",
          );
        } else {
          heartbeatLogger.info(logData, "web gateway heartbeat");
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
            whatsappHeartbeatLog.warn(
              `No messages received in ${minutesSinceLastMessage}m - restarting connection`,
            );
            void closeListener().catch((err) => {
              logVerbose(`Close listener failed: ${formatError(err)}`);
            }); // Trigger reconnect
            listener.signalClose?.({
              status: 499,
              isLoggedOut: false,
              error: "watchdog-timeout",
            });
          }
        }
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
        reconnectLogger.error(
          { error: formatError(err) },
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

    enqueueSystemEvent(
      `WhatsApp gateway disconnected (status ${statusCode ?? "unknown"})`,
    );

    if (loggedOut) {
      runtime.error(
        "WhatsApp session logged out. Run `clawdbot providers login --provider web` to relink.",
      );
      await closeListener();
      break;
    }

    reconnectAttempts += 1;
    status.reconnectAttempts = reconnectAttempts;
    emitStatus();
    if (
      reconnectPolicy.maxAttempts > 0 &&
      reconnectAttempts >= reconnectPolicy.maxAttempts
    ) {
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

export { DEFAULT_WEB_MEDIA_BYTES };
