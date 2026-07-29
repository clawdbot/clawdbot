// Control UI HTTP utilities provide tiny plain-text helpers for static routes
// before requests enter the larger Gateway JSON/auth stack.
import type { ServerResponse } from "node:http";

// Small HTTP response helpers used by Control UI routes before they enter the
// larger gateway JSON/auth stack.
/** Returns true for idempotent HTTP methods that can read Control UI assets. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

/** Sends a plain-text response with the standard UTF-8 content type. */
export function respondPlainText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

/** Sends the shared plain-text 404 response for Control UI routes. */
export function respondNotFound(res: ServerResponse): void {
  respondPlainText(res, 404, "Not Found");
}
