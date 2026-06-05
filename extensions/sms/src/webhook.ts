// Sms plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
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
const replayCache = new Map<string, number>();

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

function rememberWebhookMessage(params: {
  accountId: string;
  messageSid: string;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  for (const [key, expiresAt] of replayCache) {
    if (expiresAt > now && replayCache.size <= REPLAY_CACHE_MAX_KEYS) {
      break;
    }
    replayCache.delete(key);
  }
  const key = `${params.accountId}:${params.messageSid}`;
  if ((replayCache.get(key) ?? 0) > now) {
    return false;
  }
  replayCache.set(key, now + REPLAY_CACHE_TTL_MS);
  return true;
}

export function resetSmsWebhookReplayCacheForTest(): void {
  replayCache.clear();
}

export function createSmsWebhookHandler(params: SmsWebhookHandlerParams) {
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
    if (
      !rememberWebhookMessage({
        accountId: params.account.accountId,
        messageSid: msg.messageSid,
      })
    ) {
      params.log?.warn?.(`SMS webhook ignored replayed message ${msg.messageSid}`);
      respondTwiml(res, 200);
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
