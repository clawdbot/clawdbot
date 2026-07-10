// Sms plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import {
  buildTwilioInboundMessage,
  readTwilioWebhookForm,
  respondTwiml,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const rateLimiter = createFixedWindowRateLimiter({
  maxRequests: 30,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const REPLAY_CACHE_TTL_MS = 10 * 60_000;
const REPLAY_CACHE_MAX_KEYS = 10_000;

type ReplayCacheDecision =
  | { kind: "accepted" }
  | { kind: "replayed" }
  | { kind: "saturated"; retryAfterMs: number };

type SmsWebhookReplayGuard = {
  remember: (messageSid: string) => ReplayCacheDecision;
};

const replayGuardsByAccount = new Map<string, SmsWebhookReplayGuard>();

export function createSmsWebhookReplayGuard(
  options: {
    ttlMs?: number;
    maxKeys?: number;
    now?: () => number;
  } = {},
): SmsWebhookReplayGuard {
  const ttlMs = options.ttlMs ?? REPLAY_CACHE_TTL_MS;
  const maxKeys = options.maxKeys ?? REPLAY_CACHE_MAX_KEYS;
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, number>();

  const pruneExpired = (nowMs: number) => {
    // Fixed TTLs on a monotonic clock expire in insertion order, so only inspect
    // the expired prefix. Full live caches stay O(1) instead of rescanning 10k keys.
    for (const [key, expiresAt] of entries) {
      if (expiresAt > nowMs) {
        break;
      }
      entries.delete(key);
    }
  };

  return {
    remember: (messageSid) => {
      const nowMs = now();
      pruneExpired(nowMs);
      if (entries.has(messageSid)) {
        return { kind: "replayed" };
      }
      if (entries.size >= maxKeys) {
        const oldestExpiresAt = entries.values().next().value ?? nowMs;
        return {
          kind: "saturated",
          retryAfterMs: Math.max(0, oldestExpiresAt - nowMs),
        };
      }
      entries.set(messageSid, nowMs + ttlMs);
      return { kind: "accepted" };
    },
  };
}

function resolveSmsWebhookReplayGuard(account: ResolvedSmsAccount): SmsWebhookReplayGuard {
  // Config reloads replace route handlers. Keep the guard with the Twilio account
  // identity so retries cannot cross that lifecycle boundary or block sibling accounts.
  const key = `${account.accountId}\0${account.accountSid}`;
  const existing = replayGuardsByAccount.get(key);
  if (existing) {
    return existing;
  }
  const created = createSmsWebhookReplayGuard();
  replayGuardsByAccount.set(key, created);
  return created;
}

export function resetSmsWebhookReplayGuardsForTest(): void {
  replayGuardsByAccount.clear();
}

type SmsWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type SmsWebhookHandlerParams = {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  log?: SmsWebhookLog;
};

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function rateLimitKey(req: IncomingMessage): string {
  return req.socket?.remoteAddress ?? "unknown";
}

// Each account route owns its guard so one saturated account cannot block sibling accounts.
export function createSmsWebhookHandler(
  params: SmsWebhookHandlerParams,
  webhookReplayGuard: SmsWebhookReplayGuard = resolveSmsWebhookReplayGuard(params.account),
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const key = rateLimitKey(req);
    if (rateLimiter.isRateLimited(key)) {
      params.log?.warn?.(`SMS webhook rate limit exceeded for ${key}`);
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      respondTwiml(res, 400, "Invalid request body");
      return true;
    }

    if (!params.account.dangerouslyDisableSignatureValidation) {
      const ok = verifyTwilioSignature({
        signature: headerValue(req.headers["x-twilio-signature"]),
        url: resolveTwilioWebhookSignatureUrl({
          req,
          publicWebhookUrl: params.account.publicWebhookUrl,
        }),
        authToken: params.account.authToken,
        form,
      });
      if (!ok) {
        params.log?.warn?.("SMS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    const msg = buildTwilioInboundMessage(form);
    if (!msg) {
      respondTwiml(res, 400, "Missing SMS payload");
      return true;
    }
    if (msg.accountSid && msg.accountSid !== params.account.accountSid) {
      params.log?.warn?.("SMS webhook rejected mismatched Twilio AccountSid");
      respondTwiml(res, 403, "Invalid account");
      return true;
    }
    const replayDecision = webhookReplayGuard.remember(msg.messageSid);
    if (replayDecision.kind === "replayed") {
      params.log?.warn?.(`SMS webhook ignored replayed message ${msg.messageSid}`);
      respondTwiml(res, 200);
      return true;
    }
    if (replayDecision.kind === "saturated") {
      const retryAfterSeconds = Math.max(1, Math.ceil(replayDecision.retryAfterMs / 1000));
      params.log?.warn?.("SMS webhook replay cache is full of unexpired message SIDs");
      res.setHeader("Retry-After", String(retryAfterSeconds));
      respondTwiml(res, 429, "Replay cache saturated");
      return true;
    }

    void dispatchSmsInboundEvent({
      cfg: params.cfg,
      account: params.account,
      msg,
      channelRuntime: params.channelRuntime,
      log: params.log,
    }).catch((err: unknown) => {
      params.log?.error?.(
        `SMS webhook dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    respondTwiml(res, 200);
    return true;
  };
}
