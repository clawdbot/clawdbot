import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { safeParseJsonWithSchema } from "openclaw/plugin-sdk/extension-shared";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "openclaw/plugin-sdk/webhook-ingress";
import { z } from "zod";
import { createAuthRateLimiter } from "./api.js";
import type { NextcloudTalkReplayGuard } from "./replay-guard.js";
import { extractNextcloudTalkHeaders, verifyNextcloudTalkSignature } from "./signature.js";
import type {
  NextcloudTalkInboundMessage,
  NextcloudTalkWebhookHeaders,
  NextcloudTalkWebhookPayload,
  NextcloudTalkWebhookServerOptions,
} from "./types.js";

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const PREAUTH_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const PREAUTH_WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const HEALTH_PATH = "/healthz";
const WEBHOOK_AUTH_RATE_LIMIT_SCOPE = "nextcloud-talk-webhook-auth";
const NextcloudTalkWebhookPayloadSchema: z.ZodType<NextcloudTalkWebhookPayload> = z.object({
  type: z.enum(["Create", "Update", "Delete"]),
  actor: z.object({
    type: z.literal("Person"),
    id: z.string().min(1),
    name: z.string(),
  }),
  object: z.object({
    type: z.literal("Note"),
    id: z.string().min(1),
    name: z.string(),
    content: z.string(),
    mediaType: z.string(),
  }),
  target: z.object({
    type: z.literal("Collection"),
    id: z.string().min(1),
    name: z.string(),
  }),
});
const WEBHOOK_ERRORS = {
  missingSignatureHeaders: "Missing signature headers",
  invalidBackend: "Invalid backend",
  invalidSignature: "Invalid signature",
  invalidPayloadFormat: "Invalid payload format",
  payloadTooLarge: "Payload too large",
  internalServerError: "Internal server error",
} as const;

export class NextcloudTalkRetryableWebhookError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NextcloudTalkRetryableWebhookError";
  }
}

export async function processNextcloudTalkReplayGuardedMessage(params: {
  replayGuard: NextcloudTalkReplayGuard;
  accountId: string;
  message: NextcloudTalkInboundMessage;
  handleMessage: () => Promise<void>;
}): Promise<"processed" | "duplicate"> {
  const claim = await params.replayGuard.claimMessage({
    accountId: params.accountId,
    roomToken: params.message.roomToken,
    messageId: params.message.messageId,
  });
  if (claim !== "claimed") {
    return "duplicate";
  }

  try {
    await params.handleMessage();
    await params.replayGuard.commitMessage({
      accountId: params.accountId,
      roomToken: params.message.roomToken,
      messageId: params.message.messageId,
    });
    return "processed";
  } catch (error) {
    if (error instanceof NextcloudTalkRetryableWebhookError) {
      params.replayGuard.releaseMessage({
        accountId: params.accountId,
        roomToken: params.message.roomToken,
        messageId: params.message.messageId,
        error,
      });
    } else {
      // Generic failures are treated as non-retryable because the handler may already
      // have produced a visible side effect, and replaying the webhook would duplicate it.
      await params.replayGuard.commitMessage({
        accountId: params.accountId,
        roomToken: params.message.roomToken,
        messageId: params.message.messageId,
      });
    }
    throw error;
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return typeof err === "string" ? err : JSON.stringify(err);
}

function parseWebhookPayload(body: string): NextcloudTalkWebhookPayload | null {
  return safeParseJsonWithSchema(NextcloudTalkWebhookPayloadSchema, body);
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

function decodeWebhookCreateMessage(params: {
  body: string;
  res: ServerResponse;
}):
  | { kind: "message"; message: NextcloudTalkInboundMessage }
  | { kind: "ignore" }
  | { kind: "invalid" } {
  const payload = parseWebhookPayload(params.body);
  if (!payload) {
    writeWebhookError(params.res, 400, WEBHOOK_ERRORS.invalidPayloadFormat);
    return { kind: "invalid" };
  }
  if (payload.type !== "Create") {
    return { kind: "ignore" };
  }
  return { kind: "message", message: payloadToInboundMessage(payload) };
}

function payloadToInboundMessage(
  payload: NextcloudTalkWebhookPayload,
): NextcloudTalkInboundMessage {
  // Payload doesn't indicate DM vs room; mark as group and let inbound handler refine.
  const isGroupChat = true;

  return {
    messageId: payload.object.id,
    roomToken: payload.target.id,
    roomName: payload.target.name,
    senderId: payload.actor.id,
    senderName: payload.actor.name ?? "",
    text: payload.object.content || payload.object.name || "",
    mediaType: payload.object.mediaType || "text/plain",
    timestamp: Date.now(),
    isGroupChat,
  };
}

export function readNextcloudTalkWebhookBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
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
  stop: () => void;
} {
  const { port, host, path, secret, onMessage, onError, abortSignal } = opts;
  const maxBodyBytes =
    typeof opts.maxBodyBytes === "number" &&
    Number.isFinite(opts.maxBodyBytes) &&
    opts.maxBodyBytes > 0
      ? Math.floor(opts.maxBodyBytes)
      : DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  const readBody = opts.readBody ?? readNextcloudTalkWebhookBody;
  const isBackendAllowed = opts.isBackendAllowed;
  const shouldProcessMessage = opts.shouldProcessMessage;
  const processMessage = opts.processMessage;
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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

      const decoded = decodeWebhookCreateMessage({
        body,
        res,
      });
      if (decoded.kind === "invalid") {
        return;
      }
      if (decoded.kind === "ignore") {
        writeJsonResponse(res, 200);
        return;
      }

      const message = decoded.message;
      if (processMessage) {
        writeJsonResponse(res, 200);
        try {
          await processMessage(message);
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(formatError(err)));
        }
        return;
      }

      if (shouldProcessMessage) {
        const shouldProcess = await shouldProcessMessage(message);
        if (!shouldProcess) {
          writeJsonResponse(res, 200);
          return;
        }
      }

      writeJsonResponse(res, 200);

      try {
        await onMessage(message);
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(formatError(err)));
      }
    } catch (err) {
      if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
        writeWebhookError(res, 413, WEBHOOK_ERRORS.payloadTooLarge);
        return;
      }
      if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
        writeWebhookError(res, 408, requestBodyErrorToText("REQUEST_BODY_TIMEOUT"));
        return;
      }
      const error = err instanceof Error ? err : new Error(formatError(err));
      onError?.(error);
      writeWebhookError(res, 500, WEBHOOK_ERRORS.internalServerError);
    }
  });

  const start = (): Promise<void> => {
    return new Promise((resolve) => {
      server.listen(port, host, () => resolve());
    });
  };

  let stopped = false;
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      server.close();
    } catch {
      // ignore close races while shutting down
    }
  };

  if (abortSignal) {
    if (abortSignal.aborted) {
      stop();
    } else {
      abortSignal.addEventListener("abort", stop, { once: true });
    }
  }

  return { server, start, stop };
}
