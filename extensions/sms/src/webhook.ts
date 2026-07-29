// Sms plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createFixedWindowRateLimiter,
  resolveRequestClientIp,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  readTwilioWebhookForm,
  respondTwiml,
  resolveTwilioMessageSid,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

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

type SmsWebhookLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type SmsWebhookHandlerParams = {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  ingress: {
    enqueue: (form: Record<string, string>) => Promise<{ duplicate: boolean }>;
  };
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

// Each account route owns one durable ingress adapter.
export function createSmsWebhookHandler(params: SmsWebhookHandlerParams) {
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

    if (invalidRequestRateLimited && params.account.dangerouslyDisableSignatureValidation) {
      return rejectInvalidRequestRateLimit({ key, log: params.log, res });
    }
    if (callbackDispatchRateLimiter.isRateLimited(key)) {
      params.log?.warn?.(`SMS webhook rate limit exceeded for ${key}`);
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }
    const messageSid = resolveTwilioMessageSid(form);
    if (!messageSid) {
      respondTwiml(res, 400, "Missing MessageSid");
      return true;
    }
    // Signature validation owns the parsed-but-otherwise-raw Twilio form.
    // A 200 is impossible until SQLite commits this exact transport envelope.
    const verdict = await params.ingress.enqueue(form);
    if (verdict.duplicate) {
      params.log?.warn?.(`SMS webhook ignored replayed message ${messageSid}`);
    }
    // Durable admission also reserves the monitor pump under this HTTP request's
    // detached work root, so the response can acknowledge immediately after commit.
    respondTwiml(res, 200);
    return true;
  };
}
