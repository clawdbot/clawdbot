// Sms plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createFixedWindowRateLimiter,
  resolveRequestClientIp,
} from "openclaw/plugin-sdk/webhook-ingress";
import { dispatchSmsInboundEvent, type SmsChannelRuntime } from "./inbound.js";
import {
  buildTwilioInboundMessage,
  readTwilioWebhookForm,
  respondTwiml,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookReplayGuard, type SmsWebhookReplayGuard } from "./webhook-replay-guard.js";

const INVALID_REQUEST_MAX_REQUESTS = 300;
const CALLBACK_DISPATCH_MAX_REQUESTS = 30;

// Count failed-auth traffic separately from the stricter dispatchable callback quota.
// The over-budget decision is applied only after validation fails, so a same-key
// invalid burst cannot block a later valid Twilio callback before authentication.
const invalidRequestRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INVALID_REQUEST_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const callbackDispatchRateLimiter = createFixedWindowRateLimiter({
  maxRequests: CALLBACK_DISPATCH_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const replayGuardsByAccount = new Map<string, SmsWebhookReplayGuard>();

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

function resolvedClientAddress(params: { cfg: OpenClawConfig; req: IncomingMessage }): string {
  return (
    resolveRequestClientIp(
      params.req,
      params.cfg.gateway?.trustedProxies,
      params.cfg.gateway?.allowRealIpFallback === true,
    ) ??
    params.req.socket?.remoteAddress ??
    "unknown"
  );
}

function rateLimitKey(params: { account: ResolvedSmsAccount; clientAddress: string }): string {
  return `${params.account.accountId}:${params.account.webhookPath}:${params.clientAddress}`;
}

function rejectInvalidRequestRateLimit(params: {
  key: string;
  log?: SmsWebhookLog;
  res: ServerResponse;
}): true {
  params.log?.warn?.(`SMS webhook invalid-request rate limit exceeded for ${params.key}`);
  respondTwiml(params.res, 429, "Rate limit exceeded");
  return true;
}

// Each account route owns its guard so one saturated account cannot block sibling accounts.
export function createSmsWebhookHandler(params: SmsWebhookHandlerParams) {
  const webhookReplayGuard = resolveSmsWebhookReplayGuard(params.account);
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const clientAddress = resolvedClientAddress({ cfg: params.cfg, req });
    const key = rateLimitKey({ account: params.account, clientAddress });
    const invalidRequestRateLimited = invalidRequestRateLimiter.isRateLimited(key);

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req);
    } catch {
      if (invalidRequestRateLimited) {
        return rejectInvalidRequestRateLimit({ key, log: params.log, res });
      }
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
        if (invalidRequestRateLimited) {
          return rejectInvalidRequestRateLimit({ key, log: params.log, res });
        }
        params.log?.warn?.("SMS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    const msg = buildTwilioInboundMessage(form);
    if (!msg) {
      if (invalidRequestRateLimited) {
        return rejectInvalidRequestRateLimit({ key, log: params.log, res });
      }
      respondTwiml(res, 400, "Missing SMS payload");
      return true;
    }
    if (msg.accountSid && msg.accountSid !== params.account.accountSid) {
      if (invalidRequestRateLimited) {
        return rejectInvalidRequestRateLimit({ key, log: params.log, res });
      }
      params.log?.warn?.("SMS webhook rejected mismatched Twilio AccountSid");
      respondTwiml(res, 403, "Invalid account");
      return true;
    }
    if (invalidRequestRateLimited && params.account.dangerouslyDisableSignatureValidation) {
      return rejectInvalidRequestRateLimit({ key, log: params.log, res });
    }
    if (callbackDispatchRateLimiter.isRateLimited(key)) {
      params.log?.warn?.(`SMS webhook rate limit exceeded for ${key}`);
      respondTwiml(res, 429, "Rate limit exceeded");
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
