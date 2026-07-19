// Nextcloud Talk plugin module implements monitor behavior.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createAuthRateLimiter,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkWebhookHeaders, NextcloudTalkWebhookServerOptions } from "./types.js";
import { NextcloudTalkWebhookPayloadError } from "./webhook-spool-state.js";

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const HEALTH_PATH = "/healthz";
const WEBHOOK_AUTH_RATE_LIMIT_SCOPE = "nextcloud-talk-webhook-auth";
const WEBHOOK_ERRORS = {
  missingSignatureHeaders: "Missing signature headers",
  invalidBackend: "Invalid backend",
  invalidSignature: "Invalid signature",
  invalidPayloadFormat: "Invalid payload format",
  payloadTooLarge: "Payload too large",
  internalServerError: "Internal server error",
} as const;

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function writeJsonResponse(
  res: ServerResponse,
  status: number,
  body?: Record<string, unknown>,
): void {
  if (body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  res.writeHead(status);
  res.end();
}

function writeWebhookError(res: ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  writeJsonResponse(res, status, { error });
}

function validateWebhookHeaders(params: {
  req: IncomingMessage;
  res: ServerResponse;
  isBackendAllowed?: (backend: string) => boolean;
}): NextcloudTalkWebhookHeaders | null {
  const headers = extractNextcloudTalkHeaders(
    params.req.headers as Record<string, string | string[] | undefined>,
  );
  if (!headers) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.missingSignatureHeaders);
    return null;
  }
  if (params.isBackendAllowed && !params.isBackendAllowed(headers.backend)) {
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidBackend);
    return null;
  }
  return headers;
}

function verifyWebhookSignature(params: {
  headers: NextcloudTalkWebhookHeaders;
  body: string;
  secret: string;
  res: ServerResponse;
  clientIp: string;
  authRateLimiter: ReturnType<typeof createAuthRateLimiter>;
}): boolean {
  const isValid = verifyNextcloudTalkSignature({
    signature: params.headers.signature,
    random: params.headers.random,
    body: params.body,
    secret: params.secret,
  });
  if (!isValid) {
    params.authRateLimiter.recordFailure(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
    writeWebhookError(params.res, 401, WEBHOOK_ERRORS.invalidSignature);
    return false;
  }
  params.authRateLimiter.reset(params.clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE);
  return true;
}

function readNextcloudTalkWebhookBody(req: IncomingMessage, maxBodyBytes: number): Promise<string> {
  return readRequestBodyWithLimit(req, {
    // This read happens before signature verification, so keep the unauthenticated
    // body budget bounded even if the operator-configured post-parse limit is larger.
    maxBytes: Math.min(maxBodyBytes, PREAUTH_WEBHOOK_MAX_BODY_BYTES),
    timeoutMs: PREAUTH_WEBHOOK_BODY_TIMEOUT_MS,
  });
}

export function createNextcloudTalkWebhookServer(opts: NextcloudTalkWebhookServerOptions): {
  server: Server;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const { port, host, path, secret, onWebhook, onError, abortSignal } = opts;
  const maxBodyBytes =
    typeof opts.maxBodyBytes === "number" &&
    Number.isFinite(opts.maxBodyBytes) &&
    opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
  const isBackendAllowed = opts.isBackendAllowed;
  const authRateLimitMaxRequests =
    typeof opts.authRateLimit?.maxRequests === "number"
      ? opts.authRateLimit.maxRequests
      : WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests;
  const authRateLimitWindowMs =
    typeof opts.authRateLimit?.windowMs === "number"
      ? opts.authRateLimit.windowMs
      : WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs;
  const webhookAuthRateLimiter = createAuthRateLimiter({
    maxAttempts: authRateLimitMaxRequests,
    windowMs: authRateLimitWindowMs,
    lockoutMs: authRateLimitWindowMs,
    exemptLoopback: false,
    pruneIntervalMs: authRateLimitWindowMs,
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === HEALTH_PATH) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (req.url !== path || req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }

      const clientIp = req.socket.remoteAddress ?? "unknown";
      if (!webhookAuthRateLimiter.check(clientIp, WEBHOOK_AUTH_RATE_LIMIT_SCOPE).allowed) {
        res.writeHead(429);
        res.end("Too Many Requests");
        return;
      }

      try {
        const headers = validateWebhookHeaders({
          req,
          res,
          isBackendAllowed,
        });
        if (!headers) {
          return;
        }

        const body = await readBody(req, maxBodyBytes);

        const hasValidSignature = verifyWebhookSignature({
          headers,
          body,
          secret,
          res,
          clientIp,
          authRateLimiter: webhookAuthRateLimiter,
        });
        if (!hasValidSignature) {
          return;
        }

        // Nextcloud retries only a few times. Acknowledge only after the raw
        // envelope is durably admitted; append failure must remain retryable.
        await onWebhook(body);
        writeJsonResponse(res, 200);
      } catch (err) {
        if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
          writeWebhookError(res, 413, WEBHOOK_ERRORS.payloadTooLarge);
          return;
        }
        if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
          writeWebhookError(res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
          return;
        }
        if (err instanceof NextcloudTalkWebhookPayloadError) {
          writeWebhookError(res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
          return;
        }
        const error = err instanceof Error ? err : new Error(formatError(err));
        onError?.(error);
        writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
      }
    })();
  });

  let stopRequested = false;
  let closePromise: Promise<void> | undefined;
  const closeIfListening = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }
    if (!server.listening) {
      return Promise.resolve();
    }
    closePromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).finally(() => {
      closePromise = undefined;
    });
    return closePromise;
  };
  const stop = async () => {
    stopRequested = true;
    await closeIfListening();
  };

  const start = (): Promise<void> => {
    if (stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onListenError = (error: Error) => reject(error);
      server.once("error", onListenError);
      server.listen(port, host, () => {
        server.off("error", onListenError);
        void (async () => {
          // Abort can land between listen() and its callback. Close after the
          // listener becomes visible so a stopped monitor never retains the port.
          if (stopRequested) {
            await closeIfListening();
          }
          resolve();
        })().catch(reject);
      });
    });
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      void stop();
    } else {
      abortSignal.addEventListener("abort", () => void stop(), { once: true });
    }
  }

  return { server, start, stop };
}
