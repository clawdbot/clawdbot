// Webhook request guards validate incoming HTTP requests before plugin webhook dispatch.
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
import { resolveWebhookIntegerOption } from "./webhook-numeric-options.js";

/** Body-read profile for webhook payload limits before or after authentication. */
export type WebhookBodyReadProfile = "pre-auth" | "post-auth";

export {
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../infra/http-body.js";

/** Default webhook body size/time limits for pre-auth and post-auth reads. */
export const WEBHOOK_BODY_READ_DEFAULTS = Object.freeze({
  preAuth: {
    maxBytes: 64 * 1024,
    timeoutMs: 5_000,
  },
  postAuth: {
    maxBytes: 1024 * 1024,
    timeoutMs: 30_000,
  },
});

/** Default in-flight concurrency limits for webhook request pipelines. */
export const WEBHOOK_IN_FLIGHT_DEFAULTS = Object.freeze({
  maxInFlightPerKey: 8,
  maxTrackedKeys: 4_096,
});

/** Per-key in-flight limiter used to bound concurrent webhook handlers. */
export type WebhookInFlightLimiter = {
  /** Acquire one in-flight slot for a key, returning false when the key is at capacity. */
  tryAcquire: (key: string) => boolean;
  /** Release one slot for a key after the handler completes. */
  release: (key: string) => void;
  /** Number of keys with retained in-flight state. */
  size: () => number;
  /** Drop all retained in-flight state. */
  clear: () => void;
};

function resolveWebhookBodyReadLimits(params: {
  maxBytes?: number;
  timeoutMs?: number;
  profile?: WebhookBodyReadProfile;
}): { maxBytes: number; timeoutMs: number } {
  const defaults =
    params.profile === "pre-auth"
      ? WEBHOOK_BODY_READ_DEFAULTS.preAuth
      : WEBHOOK_BODY_READ_DEFAULTS.postAuth;
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes) && params.maxBytes > 0
      ? Math.floor(params.maxBytes)
      : defaults.maxBytes;
  const timeoutMs =
    typeof params.timeoutMs === "number" &&
    Number.isFinite(params.timeoutMs) &&
    params.timeoutMs > 0
      ? Math.floor(params.timeoutMs)
      : defaults.timeoutMs;
  return { maxBytes, timeoutMs };
}

function respondWebhookBodyReadError(params: {
  res: ServerResponse;
  code: string;
  invalidMessage?: string;
}): { ok: false } {
  const { res, code, invalidMessage } = params;
  if (code === "PAYLOAD_TOO_LARGE") {
    res.statusCode = 413;
    res.end(requestBodyErrorToText("PAYLOAD_TOO_LARGE"));
    return { ok: false };
  }
  if (code === "REQUEST_BODY_TIMEOUT") {
    res.statusCode = 408;
    res.end(requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
    return { ok: false };
  }
  if (code === "CONNECTION_CLOSED") {
    res.statusCode = 400;
    res.end(requestBodyErrorToText("CONNECTION_CLOSED"));
    return { ok: false };
  }
  res.statusCode = 400;
  res.end(invalidMessage ?? "Bad Request");
  return { ok: false };
}

/** Create an in-memory limiter that caps concurrent webhook handlers per key. */
export function createWebhookInFlightLimiter(options?: {
  /** Maximum concurrent handlers allowed for one key. */
  maxInFlightPerKey?: number;
  /** Maximum number of keys retained before oldest entries are pruned. */
  maxTrackedKeys?: number;
}): WebhookInFlightLimiter {
  const maxInFlightPerKey = resolveWebhookIntegerOption(
    options?.maxInFlightPerKey,
    WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
    { min: 1 },
  );
  const maxTrackedKeys = resolveWebhookIntegerOption(
    options?.maxTrackedKeys,
    WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
    { min: 1 },
  );
  const active = new Map<string, number>();

  return {
    tryAcquire: (key: string) => {
      if (!key) {
        return true;
      }
      const current = active.get(key) ?? 0;
      if (current >= maxInFlightPerKey) {
        return false;
      }
      active.set(key, current + 1);
      // Keep the limiter bounded even under key-spray attacks; pruning oldest keys may allow
      // a stale key to reset, but avoids unbounded memory growth on pre-auth webhook paths.
      pruneMapToMaxSize(active, maxTrackedKeys);
      return true;
    },
    release: (key: string) => {
      if (!key) {
        return;
      }
      const current = active.get(key);
      if (current === undefined) {
        return;
      }
      if (current <= 1) {
        active.delete(key);
        return;
      }
      active.set(key, current - 1);
    },
    size: () => active.size,
    clear: () => active.clear(),
  };
}

/** Detect JSON content types, including structured syntax suffixes like `application/ld+json`. */
export function isJsonContentType(value: string | string[] | undefined): boolean {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) {
    return false;
  }
  const mediaType = normalizeOptionalLowercaseString(first.split(";", 1)[0]);
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

/** Apply method, rate-limit, and content-type guards before a webhook handler reads the body. */
export function applyBasicWebhookRequestGuards(params: {
  /** Incoming request to validate before body reads or handler dispatch. */
  req: IncomingMessage;
  /** Response used for method, rate-limit, or content-type rejections. */
  res: ServerResponse;
  /** Allowed HTTP methods; empty or omitted disables the method guard. */
  allowMethods?: readonly string[];
  /** Optional fixed-window limiter for pre-body request throttling. */
  rateLimiter?: FixedWindowRateLimiter;
  /** Key passed to the rate limiter when throttling is enabled. */
  rateLimitKey?: string;
  /** Clock override for deterministic limiter tests. */
  nowMs?: number;
  /** Require JSON content type for POST requests. */
  requireJsonContentType?: boolean;
}): boolean {
  const allowMethods = params.allowMethods?.length ? params.allowMethods : null;
  if (allowMethods && !allowMethods.includes(params.req.method ?? "")) {
    params.res.statusCode = 405;
    params.res.setHeader("Allow", allowMethods.join(", "));
    params.res.end("Method Not Allowed");
    return false;
  }

  if (
    params.rateLimiter &&
    params.rateLimitKey &&
    params.rateLimiter.isRateLimited(params.rateLimitKey, params.nowMs ?? Date.now())
  ) {
    params.res.statusCode = 429;
    params.res.end("Too Many Requests");
    return false;
  }

  if (
    params.requireJsonContentType &&
    params.req.method === "POST" &&
    !isJsonContentType(params.req.headers["content-type"])
  ) {
    params.res.statusCode = 415;
    params.res.end("Unsupported Media Type");
    return false;
  }

  return true;
}

/** Start the shared webhook request lifecycle and return a release hook for in-flight tracking. */
export function beginWebhookRequestPipelineOrReject(params: {
  /** Incoming request to validate before acquiring in-flight capacity. */
  req: IncomingMessage;
  /** Response used for guard or capacity rejections. */
  res: ServerResponse;
  /** Allowed HTTP methods; empty or omitted disables the method guard. */
  allowMethods?: readonly string[];
  /** Optional fixed-window limiter for pre-body request throttling. */
  rateLimiter?: FixedWindowRateLimiter;
  /** Key passed to the rate limiter when throttling is enabled. */
  rateLimitKey?: string;
  /** Clock override for deterministic limiter tests. */
  nowMs?: number;
  /** Require JSON content type for POST requests. */
  requireJsonContentType?: boolean;
  /** Optional per-key concurrency limiter acquired after basic guards pass. */
  inFlightLimiter?: WebhookInFlightLimiter;
  /** Key used for in-flight concurrency tracking. */
  inFlightKey?: string;
  /** Status code returned when the in-flight guard rejects. */
  inFlightLimitStatusCode?: number;
  /** Response body returned when the in-flight guard rejects. */
  inFlightLimitMessage?: string;
}): { ok: true; release: () => void } | { ok: false } {
  if (
    !applyBasicWebhookRequestGuards({
      req: params.req,
      res: params.res,
      allowMethods: params.allowMethods,
      rateLimiter: params.rateLimiter,
      rateLimitKey: params.rateLimitKey,
      nowMs: params.nowMs,
      requireJsonContentType: params.requireJsonContentType,
    })
  ) {
    return { ok: false };
  }

  const inFlightKey = params.inFlightKey ?? "";
  const inFlightLimiter = params.inFlightLimiter;
  if (inFlightLimiter && inFlightKey && !inFlightLimiter.tryAcquire(inFlightKey)) {
    params.res.statusCode = params.inFlightLimitStatusCode ?? 429;
    params.res.end(params.inFlightLimitMessage ?? "Too Many Requests");
    return { ok: false };
  }

  let released = false;
  // Acquire happens after method/rate/content-type guards so rejected requests do not require
  // cleanup; successful callers must run the returned release hook in a finally block.
  return {
    ok: true,
    release: () => {
      if (released) {
        return;
      }
      // Pipeline cleanup may run from multiple exits; release must stay idempotent.
      released = true;
      if (inFlightLimiter && inFlightKey) {
        inFlightLimiter.release(inFlightKey);
      }
    },
  };
}

/**
 * Run post-ack webhook processing on its own admitted gateway work root.
 *
 * Ack-first handlers respond before processing events, so the continued work
 * outlives the HTTP request admission it inherited; once that admission is
 * released, queue enqueues from the inherited chain are refused as if the
 * gateway were draining. Call this synchronously from the request handler
 * (while the request is still admitted): it reserves an independent root that
 * keeps the detached processing accepted and lets a restart drain wait for it.
 */
export function runDetachedWebhookWork<T>(run: () => Promise<T>): Promise<T> {
  return runWithGatewayIndependentRootWorkContinuation(async () => {
    // Reserve the root now, but let the request handler write its acknowledgement
    // before any synchronous prefix in the detached callback can run.
    await Promise.resolve();
    return await run();
  });
}

/** Read a webhook request body with bounded size/time limits and translate failures into responses. */
export async function readWebhookBodyOrReject(params: {
  /** Incoming request body stream to read. */
  req: IncomingMessage;
  /** Response used for body size, timeout, close, or parse failures. */
  res: ServerResponse;
  /** Optional maximum body size override in bytes. */
  maxBytes?: number;
  /** Optional body read timeout override in milliseconds. */
  timeoutMs?: number;
  /** Default limit profile to use when explicit limits are omitted. */
  profile?: WebhookBodyReadProfile;
  /** Response body for invalid request bodies. */
  invalidBodyMessage?: string;
}): Promise<{ ok: true; value: string } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
  });

  try {
    const raw = await readRequestBodyWithLimit(params.req, limits);
    return { ok: true, value: raw };
  } catch (error) {
    if (isRequestBodyLimitError(error)) {
      return respondWebhookBodyReadError({
        res: params.res,
        code: error.code,
        invalidMessage: params.invalidBodyMessage,
      });
    }
    return respondWebhookBodyReadError({
      res: params.res,
      code: "INVALID_BODY",
      invalidMessage: params.invalidBodyMessage ?? formatErrorMessage(error),
    });
  }
}

/** Read and parse a JSON webhook body, rejecting malformed or oversized payloads consistently. */
export async function readJsonWebhookBodyOrReject(params: {
  /** Incoming request body stream to read and parse as JSON. */
  req: IncomingMessage;
  /** Response used for JSON parse, body size, timeout, or close failures. */
  res: ServerResponse;
  /** Optional maximum body size override in bytes. */
  maxBytes?: number;
  /** Optional body read timeout override in milliseconds. */
  timeoutMs?: number;
  /** Default limit profile to use when explicit limits are omitted. */
  profile?: WebhookBodyReadProfile;
  /** Treat an empty body as `{}` instead of rejecting it as invalid JSON. */
  emptyObjectOnEmpty?: boolean;
  /** Response body for malformed JSON. */
  invalidJsonMessage?: string;
}): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const limits = resolveWebhookBodyReadLimits({
    maxBytes: params.maxBytes,
    timeoutMs: params.timeoutMs,
    profile: params.profile,
  });
  const body = await readJsonBodyWithLimit(params.req, {
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
    emptyObjectOnEmpty: params.emptyObjectOnEmpty,
  });
  if (body.ok) {
    return { ok: true, value: body.value };
  }
  return respondWebhookBodyReadError({
    res: params.res,
    code: body.code,
    invalidMessage: params.invalidJsonMessage,
  });
}
