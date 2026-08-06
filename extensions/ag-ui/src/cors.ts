import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Apply the route's CORS headers and answer a preflight.
 *
 * Returns true when the request was a preflight and has been answered, so the
 * caller should stop.
 *
 * `Allow-Headers` must list every custom header the routes document —
 * `X-OpenClaw-Agent-Id` and `X-OpenClaw-Session-Key` — or a cross-origin browser
 * client silently cannot send them. Bearer auth plus a JSON body already forces a
 * preflight, so the OPTIONS answer is required regardless.
 *
 * A wildcard origin is safe here because neither route uses cookies: every
 * request carries its own bearer token, so another origin can send a request but
 * cannot borrow an existing session.
 */
export function applyCorsAndHandlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-openclaw-agent-id, x-openclaw-session-key",
  );
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}
