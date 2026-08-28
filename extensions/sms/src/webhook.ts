// Sms plugin module implements webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createFixedWindowRateLimiter,
  isRequestBodyLimitError,
  resolveRequestClientIp,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  createSmsDeliveryRecorder,
  isTwilioDeliveryStatusForm,
  type SmsDeliveryRecorder,
} from "./delivery-observations.js";
import {
  readTwilioWebhookForm,
  respondTwiml,
  resolveTwilioInboundSender,
  resolveTwilioMessageSid,
  resolveTwilioWebhookSignatureUrl,
  verifyTwilioSignature,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const INVALID_REQUEST_MAX_REQUESTS = 300;
const INBOUND_DISPATCH_MAX_REQUESTS = 30;
const DELIVERY_CALLBACK_MAX_REQUESTS = 3_000;
const DELIVERY_CALLBACK_WINDOW_MS = 60_000;
const SMS_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const SMS_WEBHOOK_ACCEPTED_VALUE = "durable";

// Count failed-auth traffic separately from the stricter dispatchable inbound quota.
// The over-budget decision is applied only after validation fails, so a same-key
// invalid burst cannot block a later valid Twilio callback before authentication.
const invalidRequestRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INVALID_REQUEST_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const inboundDispatchRateLimiter = createFixedWindowRateLimiter({
  maxRequests: INBOUND_DISPATCH_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 5_000,
});
const VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS = 300;
const validatedInboundAggregateRateLimiter = createFixedWindowRateLimiter({
  maxRequests: VALIDATED_INBOUND_AGGREGATE_MAX_REQUESTS,
  windowMs: 60_000,
  maxTrackedKeys: 1_000,
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
  delivery?: SmsDeliveryRecorder;
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

function rateLimitKey(params: { account: ResolvedSmsAccount; subject: string }): string {
  return `${params.account.accountId}:${params.account.webhookPath}:${params.subject}`;
}

function accountRouteRateLimitKey(account: ResolvedSmsAccount): string {
  return `${account.accountId}:${account.webhookPath}`;
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
  let deliveryRecorder = params.delivery;
  // Status persistence gets a separate route-level safety fuse. It stays much
  // looser than inbound quotas; overflow gets a visible 5xx instead of a false ack.
  const deliveryCallbackRateLimiter = createFixedWindowRateLimiter({
    maxRequests: DELIVERY_CALLBACK_MAX_REQUESTS,
    windowMs: DELIVERY_CALLBACK_WINDOW_MS,
    maxTrackedKeys: 1,
  });
  const deliveryCallbackKey = accountRouteRateLimitKey(params.account);
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondTwiml(res, 405, "Method not allowed");
      return true;
    }

    const clientAddress = resolvedClientAddress({ cfg: params.cfg, req });
    const clientAddressKey = rateLimitKey({ account: params.account, subject: clientAddress });
    const invalidRequestRateLimited = invalidRequestRateLimiter.isRateLimited(clientAddressKey);

    let form: Record<string, string>;
    try {
      form = await readTwilioWebhookForm(req, res);
    } catch (error) {
      if (isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")) {
        respondTwiml(res, 413, "Payload too large");
        return true;
      }
      throw error;
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
          return rejectInvalidRequestRateLimit({ key: clientAddressKey, log: params.log, res });
        }
        params.log?.warn?.("SMS webhook rejected invalid Twilio signature");
        respondTwiml(res, 403, "Invalid signature");
        return true;
      }
    }

    if (invalidRequestRateLimited && params.account.dangerouslyDisableSignatureValidation) {
      return rejectInvalidRequestRateLimit({ key: clientAddressKey, log: params.log, res });
    }

    // Provider delivery transitions use a separate route quota from inbound messages.
    // The generated StatusCallback opts into 5xx retries for commit or fuse failures.
    if (isTwilioDeliveryStatusForm(form)) {
      if (
        params.account.dangerouslyDisableSignatureValidation &&
        inboundDispatchRateLimiter.isRateLimited(clientAddressKey)
      ) {
        params.log?.warn?.("SMS webhook callback rate limit exceeded");
        respondTwiml(res, 429, "Rate limit exceeded");
        return true;
      }
      const messageSid = resolveTwilioMessageSid(form);
      if (!messageSid) {
        respondTwiml(res, 400, "Missing MessageSid");
        return true;
      }
      const callbackAccountSid = form.AccountSid;
      if (!callbackAccountSid || callbackAccountSid !== params.account.accountSid) {
        params.log?.warn?.(
          `SMS delivery callback ignored missing or mismatched account for message ${messageSid}`,
        );
        respondTwiml(res, 200);
        return true;
      }
      if (deliveryCallbackRateLimiter.isRateLimited(deliveryCallbackKey)) {
        params.log?.warn?.("SMS delivery callback rate limit exceeded");
        respondTwiml(res, 503, "Service unavailable");
        return true;
      }
      deliveryRecorder ??= createSmsDeliveryRecorder();
      const verdict = await deliveryRecorder.record({ account: params.account, form });
      if (verdict.duplicate) {
        params.log?.info?.(`SMS delivery callback ignored duplicate for message ${messageSid}`);
      } else {
        params.log?.info?.(
          `SMS delivery observation ${verdict.record.status} recorded for message ${messageSid}`,
        );
      }
      res.setHeader(SMS_WEBHOOK_ACCEPTED_HEADER, SMS_WEBHOOK_ACCEPTED_VALUE);
      respondTwiml(res, 200);
      return true;
    }

    // Twilio egress IPs are shared across unrelated senders: an address-keyed quota
    // would let one flooding sender 429 every sender behind that IP, so validated
    // callbacks meter on the canonical signature-covered From value (invalid or absent
    // From values share one bucket).
    // With validation disabled nothing authenticates From and rotating it would bypass
    // the cap, so unauthenticated traffic stays on the fail-closed client address key.
    const dispatchKey = params.account.dangerouslyDisableSignatureValidation
      ? clientAddressKey
      : rateLimitKey({ account: params.account, subject: resolveTwilioInboundSender(form) });
    if (inboundDispatchRateLimiter.isRateLimited(dispatchKey)) {
      params.log?.warn?.("SMS webhook callback rate limit exceeded");
      respondTwiml(res, 429, "Rate limit exceeded");
      return true;
    }
    // Sender fairness must not remove bounded admission for a signed fan-out.
    // Keep the aggregate route ceiling separate from the sender limiter so one
    // sender cannot monopolize the route, while many distinct valid senders also
    // cannot create unbounded durable-ingress pressure.
    if (!params.account.dangerouslyDisableSignatureValidation) {
      const aggregateKey = accountRouteRateLimitKey(params.account);
      if (validatedInboundAggregateRateLimiter.isRateLimited(aggregateKey)) {
        params.log?.warn?.(`SMS webhook aggregate rate limit exceeded for ${aggregateKey}`);
        respondTwiml(res, 429, "Rate limit exceeded");
        return true;
      }
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
    // Duplicates map to the committed row, so replays still ack durable (#104407).
    res.setHeader(SMS_WEBHOOK_ACCEPTED_HEADER, SMS_WEBHOOK_ACCEPTED_VALUE);
    respondTwiml(res, 200);
    return true;
  };
}
