// Shared Gateway HTTP helpers handle small JSON/text responses, SSE headers,
// body-size errors, and client disconnect aborts.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { buildMissingScopeErrorDetails } from "../../packages/gateway-protocol/src/index.js";
import {
  clearHttpResponseRepresentationHeaders,
  sendHttpRequestRejection,
} from "../infra/http-request-lifecycle.js";
import {
  logRejectedLargePayload,
  parseContentLengthHeader,
} from "../logging/diagnostic-payload.js";
import type { GatewayAuthResult } from "./auth.js";
import { respondPlainText } from "./control-ui-http-utils.js";
import { readJsonBody } from "./hooks.js";
import { PROXY_ATTRIBUTION_REQUIRED_REASON } from "./ingress-attribution.js";

/**
 * Apply baseline security headers that are safe for all response types (API JSON,
 * HTML pages, static assets, SSE streams). Headers that restrict framing or set a
 * Content-Security-Policy are intentionally omitted here because some handlers
 * (canvas host, A2UI) serve content that may be loaded inside frames.
 */
export function setDefaultSecurityHeaders(
  res: ServerResponse,
  opts?: { strictTransportSecurity?: string | false },
) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");
  const strictTransportSecurity =
    typeof opts?.strictTransportSecurity === "string"
      ? opts.strictTransportSecurity.trim()
      : undefined;
  if (typeof strictTransportSecurity === "string" && strictTransportSecurity.length > 0) {
    res.setHeader("Strict-Transport-Security", strictTransportSecurity);
  }
}

/** Finish a failed request without rewriting committed headers or orphaning its transport. */
export function finishFailedGatewayHttpResponse(res: ServerResponse): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  if (!res.headersSent) {
    clearHttpResponseRepresentationHeaders(res);
    res.setHeader("Cache-Control", "no-store");
    res.statusMessage = "Internal Server Error";
    respondPlainText(res, 500, res.statusMessage);
    return;
  }

  // Ending would frame a partial chunked body as a complete successful response.
  res.destroy();
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function sendMethodNotAllowed(res: ServerResponse, allow = "POST") {
  res.setHeader("Allow", allow);
  respondPlainText(res, 405, "Method Not Allowed");
}

export function sendUnauthorized(res: ServerResponse) {
  sendJson(res, 401, {
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

export function sendRateLimited(res: ServerResponse, retryAfterMs?: number) {
  if (retryAfterMs && retryAfterMs > 0) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  }
  sendJson(res, 429, {
    error: {
      message: "Too many failed authentication attempts. Please try again later.",
      type: "rate_limited",
    },
  });
}

export function sendGatewayAuthFailure(res: ServerResponse, authResult: GatewayAuthResult) {
  if (authResult.rateLimited) {
    sendRateLimited(res, authResult.retryAfterMs);
    return;
  }
  if (authResult.reason === PROXY_ATTRIBUTION_REQUIRED_REASON) {
    sendJson(res, 403, {
      error: {
        message:
          "Proxy client attribution is required. Configure gateway.trustedProxies narrowly and make the proxy overwrite or safely rebuild forwarded client headers.",
        type: PROXY_ATTRIBUTION_REQUIRED_REASON,
      },
    });
    return;
  }
  sendUnauthorized(res);
}

export function sendInvalidRequest(res: ServerResponse, message: string) {
  sendJson(res, 400, {
    error: { message, type: "invalid_request_error" },
  });
}

export function parseGatewayJsonRequest<T extends z.ZodType>(
  res: ServerResponse,
  body: unknown,
  schema: T,
): z.output<T> | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  sendInvalidRequest(
    res,
    issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body",
  );
  return undefined;
}

function buildMissingScopeForbiddenBody(
  missingScope: string | undefined,
  requiredScopes?: readonly string[],
) {
  const details =
    typeof missingScope === "string" && missingScope.length > 0
      ? buildMissingScopeErrorDetails({
          missingScope,
          requiredScopes: requiredScopes ?? [missingScope],
        })
      : undefined;
  return {
    ok: false,
    error: {
      type: "forbidden",
      message: `missing scope: ${missingScope}`,
      ...(details ? { details } : {}),
    },
  };
}

export function sendMissingScopeForbidden(
  res: ServerResponse,
  missingScope: string | undefined,
  requiredScopes?: readonly string[],
) {
  sendJson(res, 403, buildMissingScopeForbiddenBody(missingScope, requiredScopes));
}

export async function readJsonBodyOrError(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<unknown> {
  const body = await readJsonBody(req, maxBytes);
  if (!body.ok) {
    if (body.error === "payload too large") {
      const contentLength = parseContentLengthHeader(req.headers?.["content-length"]);
      logRejectedLargePayload({
        surface: "gateway.http.json",
        limitBytes: maxBytes,
        reason: "json_body_limit",
        ...(contentLength !== undefined ? { bytes: contentLength } : {}),
      });
    }
    if (body.error === "payload too large" || body.error === "request body timeout") {
      const tooLarge = body.error === "payload too large";
      await sendHttpRequestRejection(
        req,
        res,
        tooLarge ? 413 : 408,
        JSON.stringify({
          error: {
            message: tooLarge ? "Payload too large" : "Request body timeout",
            type: "invalid_request_error",
          },
        }),
        "application/json; charset=utf-8",
      );
      return undefined;
    }
    sendInvalidRequest(res, body.error);
    return undefined;
  }
  return body.value;
}

export function writeDone(res: ServerResponse) {
  res.write("data: [DONE]\n\n");
}

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

export function setSseHeaders(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", SSE_CONTENT_TYPE);
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

/** Abort reason used when the HTTP client disconnects before delivery. */
class ClientDisconnectError extends Error {
  constructor(message = "HTTP client disconnected") {
    super(message);
    this.name = "ClientDisconnectError";
  }
}

export function watchClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
  abortController: AbortController,
  onDisconnect?: () => void,
) {
  const sockets = Array.from(
    new Set(
      [req.socket, res.socket].filter(
        (socket): socket is NonNullable<typeof socket> => socket !== null,
      ),
    ),
  );
  if (sockets.length === 0) {
    return () => {};
  }
  const handleClose = () => {
    onDisconnect?.();
    if (!abortController.signal.aborted) {
      abortController.abort(new ClientDisconnectError());
    }
  };
  const stopWatchingResponseErrors = () => {
    res.off("error", handleClose);
    res.off("close", stopWatchingResponseErrors);
  };
  // Finalizers release socket watchers before res.end(); keep its error
  // listener until close so a failed flush cannot become process-fatal.
  res.on("error", handleClose);
  res.once("close", stopWatchingResponseErrors);
  if (res.destroyed || sockets.some((socket) => socket.destroyed)) {
    handleClose();
    return () => {};
  }
  for (const socket of sockets) {
    socket.on("close", handleClose);
  }
  return () => {
    for (const socket of sockets) {
      socket.off("close", handleClose);
    }
  };
}
