// Control UI HTTP utilities provide tiny plain-text helpers for static routes
// before requests enter the larger Gateway JSON/auth stack.
import type { ServerResponse } from "node:http";
import { acceptsMediaType, hasExplicitAcceptableMediaRange } from "./http-media-range.js";

// Small HTTP response helpers used by Control UI routes before they enter the
// larger gateway JSON/auth stack.
/** Returns true for idempotent HTTP methods that can read Control UI assets. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** Returns whether an Accept header permits an HTML document response. */
export function acceptsControlUiHtmlResponse(accept: string | undefined): boolean {
  const normalized = accept?.trim();
  if (!normalized) {
    return true;
  }
  // XHTML is an explicit browser signal; wildcards must negotiate the actual HTML type.
  return (
    acceptsMediaType(normalized, "text/html; charset=utf-8") ||
    hasExplicitAcceptableMediaRange(normalized, "application/xhtml+xml")
  );
}

/** Sends a plain-text response with the standard UTF-8 content type. */
export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  if (statusCode !== 204) {
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
  }
  res.end(body);
}

/** Sends the shared plain-text 404 response for Control UI routes. */
export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}
