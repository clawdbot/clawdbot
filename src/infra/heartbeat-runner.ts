import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging.js";
import { getQueueSize } from "../process/command-queue.js";
import { webAuthExists } from "../providers/web/index.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { getActiveWebListener } from "../web/active-listener.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";
import {
  type HeartbeatRunResult,
  requestHeartbeatNow,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import type { OutboundSendDeps } from "./outbound/deliver.js";
import { deliverOutboundPayloads } from "./outbound/deliver.js";
import { resolveHeartbeatDeliveryTarget } from "./outbound/targets.js";

type HeartbeatDeps = OutboundSendDeps & {
  runtime?: RuntimeEnv;
  getQueueSize?: (lane?: string) => number;
  nowMs?: () => number;
  webAuthExists?: () => Promise<boolean>;
  hasActiveWebListener?: () => boolean;
};

const log = createSubsystemLogger("gateway/heartbeat");
let heartbeatsEnabled = true;

export function setHeartbeatsEnabled(enabled: boolean) {
  heartbeatsEnabled = enabled;
}

export function resolveHeartbeatIntervalMs(
  cfg: ClawdbotConfig,
  overrideEvery?: string,
) {
  const raw =
    overrideEvery ??
    cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  let ms: number;
  try {
    ms = parseDurationMs(trimmed, { defaultUnit: "m" });
  } catch {
    return null;
  }
  if (ms <= 0) return null;
  return ms;
}

export function resolveHeartbeatPrompt(cfg: ClawdbotConfig) {
  return resolveHeartbeatPromptText(cfg.agents?.defaults?.heartbeat?.prompt);
}

function resolveHeartbeatAckMaxChars(cfg: ClawdbotConfig) {
  return Math.max(
    0,
    cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
      DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );
}

function resolveHeartbeatSession(cfg: ClawdbotConfig) {
  const sessionCfg = cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const sessionKey = scope === "global" ? "global" : resolveMainSessionKey(cfg);
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  return { sessionKey, storePath, store, entry };
}

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

function resolveHeartbeatSender(params: {
  allowFrom: Array<string | number>;
  lastTo?: string;
  lastProvider?: SessionEntry["lastProvider"];
}) {
  const { allowFrom, lastTo, lastProvider } = params;
  const candidates = [
    lastTo?.trim(),
    lastProvider === "telegram" && lastTo ? `telegram:${lastTo}` : undefined,
    lastProvider === "whatsapp" && lastTo ? `whatsapp:${lastTo}` : undefined,
  ].filter((val): val is string => Boolean(val?.trim()));

  const allowList = allowFrom
    .map((entry) => String(entry))
    .filter((entry) => entry && entry !== "*");
  if (allowFrom.includes("*")) {
    return candidates[0] ?? "heartbeat";
  }
  if (candidates.length > 0 && allowList.length > 0) {
    const matched = candidates.find((candidate) =>
      allowList.includes(candidate),
    );
    if (matched) return matched;
  }
  if (candidates.length > 0 && allowList.length === 0) {
    return candidates[0];
  }
  if (allowList.length > 0) return allowList[0];
  return candidates[0] ?? "heartbeat";
}

async function resolveWhatsAppReadiness(
  cfg: ClawdbotConfig,
  deps?: HeartbeatDeps,
): Promise<{ ok: boolean; reason: string }> {
  if (cfg.web?.enabled === false) {
    return { ok: false, reason: "whatsapp-disabled" };
  }
  const authExists = await (deps?.webAuthExists ?? webAuthExists)();
  if (!authExists) {
    return { ok: false, reason: "whatsapp-not-linked" };
  }
  const listenerActive = deps?.hasActiveWebListener
    ? deps.hasActiveWebListener()
    : Boolean(getActiveWebListener());
  if (!listenerActive) {
    return { ok: false, reason: "whatsapp-not-running" };
  }
  return { ok: true, reason: "ok" };
}

async function restoreHeartbeatUpdatedAt(params: {
  storePath: string;
  sessionKey: string;
  updatedAt?: number;
}) {
  const { storePath, sessionKey, updatedAt } = params;
  if (typeof updatedAt !== "number") return;
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) return;
  if (entry.updatedAt === updatedAt) return;
  store[sessionKey] = { ...entry, updatedAt };
  await saveSessionStore(storePath, store);
}

function normalizeHeartbeatReply(
  payload: ReplyPayload,
  responsePrefix: string | undefined,
  ackMaxChars: number,
) {
  const stripped = stripHeartbeatToken(payload.text, {
    mode: "heartbeat",
    maxAckChars: ackMaxChars,
  });
  const hasMedia = Boolean(
    payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0,
  );
  if (stripped.shouldSkip && !hasMedia) {
    return {
      shouldSkip: true,
      text: "",
      hasMedia,
    };
  }
  let finalText = stripped.text;
  if (responsePrefix && finalText && !finalText.startsWith(responsePrefix)) {
    finalText = `${responsePrefix} ${finalText}`;
  }
  return { shouldSkip: false, text: finalText, hasMedia };
}

export async function runHeartbeatOnce(opts: {
  cfg?: ClawdbotConfig;
  reason?: string;
  deps?: HeartbeatDeps;
}): Promise<HeartbeatRunResult> {
  const cfg = opts.cfg ?? loadConfig();
  if (!heartbeatsEnabled) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!resolveHeartbeatIntervalMs(cfg)) {
    return { status: "skipped", reason: "disabled" };
  }

  const queueSize = (opts.deps?.getQueueSize ?? getQueueSize)("main");
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }

  const startedAt = opts.deps?.nowMs?.() ?? Date.now();
  const { entry, sessionKey, storePath } = resolveHeartbeatSession(cfg);
  const previousUpdatedAt = entry?.updatedAt;
  const allowFrom = cfg.whatsapp?.allowFrom ?? [];
  const sender = resolveHeartbeatSender({
    allowFrom,
    lastTo: entry?.lastTo,
    lastProvider: entry?.lastProvider,
  });
  const prompt = resolveHeartbeatPrompt(cfg);
  const ctx = {
    Body: prompt,
    From: sender,
    To: sender,
    Provider: "heartbeat",
  };

  try {
    const replyResult = await getReplyFromConfig(
      ctx,
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
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-empty",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const ackMaxChars = resolveHeartbeatAckMaxChars(cfg);
    const normalized = normalizeHeartbeatReply(
      replyPayload,
      resolveEffectiveMessagesConfig(
        cfg,
        resolveAgentIdFromSessionKey(sessionKey),
      ).responsePrefix,
      ackMaxChars,
    );
    if (normalized.shouldSkip && !normalized.hasMedia) {
      await restoreHeartbeatUpdatedAt({
        storePath,
        sessionKey,
        updatedAt: previousUpdatedAt,
      });
      emitHeartbeatEvent({
        status: "ok-token",
        reason: opts.reason,
        durationMs: Date.now() - startedAt,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    const delivery = resolveHeartbeatDeliveryTarget({ cfg, entry });
    const mediaUrls =
      replyPayload.mediaUrls ??
      (replyPayload.mediaUrl ? [replyPayload.mediaUrl] : []);

    if (delivery.provider === "none" || !delivery.to) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: delivery.reason ?? "no-target",
        preview: normalized.text?.slice(0, 200),
        durationMs: Date.now() - startedAt,
        hasMedia: mediaUrls.length > 0,
      });
      return { status: "ran", durationMs: Date.now() - startedAt };
    }

    if (delivery.provider === "whatsapp") {
      const readiness = await resolveWhatsAppReadiness(cfg, opts.deps);
      if (!readiness.ok) {
        emitHeartbeatEvent({
          status: "skipped",
          reason: readiness.reason,
          preview: normalized.text?.slice(0, 200),
          durationMs: Date.now() - startedAt,
          hasMedia: mediaUrls.length > 0,
        });
        log.info("heartbeat: whatsapp not ready", {
          reason: readiness.reason,
        });
        return { status: "skipped", reason: readiness.reason };
      }
    }

    await deliverOutboundPayloads({
      cfg,
      provider: delivery.provider,
      to: delivery.to,
      payloads: [
        {
          text: normalized.text,
          mediaUrls,
        },
      ],
      deps: opts.deps,
    });

    emitHeartbeatEvent({
      status: "sent",
      to: delivery.to,
      preview: normalized.text?.slice(0, 200),
      durationMs: Date.now() - startedAt,
      hasMedia: mediaUrls.length > 0,
    });
    return { status: "ran", durationMs: Date.now() - startedAt };
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  }
}

export function startHeartbeatRunner(opts: {
  cfg?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const cfg = opts.cfg ?? loadConfig();
  const intervalMs = resolveHeartbeatIntervalMs(cfg);
  if (!intervalMs) {
    log.info("heartbeat: disabled", { enabled: false });
  }

  const runtime = opts.runtime ?? defaultRuntime;
  const run = async (params?: { reason?: string }) => {
    const res = await runHeartbeatOnce({
      cfg,
      reason: params?.reason,
      deps: { runtime },
    });
    return res;
  };

  setHeartbeatWakeHandler(async (params) => run({ reason: params.reason }));

  let timer: NodeJS.Timeout | null = null;
  if (intervalMs) {
    timer = setInterval(() => {
      requestHeartbeatNow({ reason: "interval", coalesceMs: 0 });
    }, intervalMs);
    timer.unref?.();
    log.info("heartbeat: started", { intervalMs });
  }

  const cleanup = () => {
    setHeartbeatWakeHandler(null);
    if (timer) clearInterval(timer);
    timer = null;
  };

  opts.abortSignal?.addEventListener("abort", cleanup, { once: true });

  return { stop: cleanup };
}
