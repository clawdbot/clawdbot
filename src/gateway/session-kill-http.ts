// Gateway HTTP session kill handler.
// Stops subagent runs through the admin-scoped HTTP control surface.
import type { IncomingMessage, ServerResponse } from "node:http";
import { killSubagentRunAdmin } from "../agents/subagent-control.js";
import { getRuntimeConfig } from "../config/io.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  sendMissingScopeForbidden,
} from "./http-common.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "./method-scopes.js";
import { loadSessionEntry } from "./session-utils.js";

type SessionKeyPathResolution =
  | { matched: false }
  | { matched: true; sessionKey: string }
  | { error: "invalid-session-key"; matched: true };

function resolveSessionKeyFromPath(pathname: string): SessionKeyPathResolution {
  const match = pathname.match(/^\/sessions\/([^/]+)\/kill$/);
  if (!match) {
    return { matched: false };
  }
  try {
    const decoded = decodeURIComponent(match[1] ?? "").trim();
    if (!decoded) {
      return { error: "invalid-session-key", matched: true };
    }
    return { matched: true, sessionKey: decoded };
  } catch {
    return { error: "invalid-session-key", matched: true };
  }
}

export async function handleSessionKillHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const cfg = getRuntimeConfig();
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKeyResolution = resolveSessionKeyFromPath(url.pathname);
  if (!sessionKeyResolution.matched) {
    return false;
  }
  if ("error" in sessionKeyResolution) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  const { sessionKey } = sessionKeyResolution;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  const requestedScopes = resolveTrustedHttpOperatorScopes(req, requestAuth);
  // Run kills stay admin-only: sessions.delete is dynamic (write may delete
  // archived sessions via RPC), but this endpoint terminates live runs.
  const scopeAuth = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, requestedScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }

  const { entry, canonicalKey } = loadSessionEntry(sessionKey);
  if (!entry) {
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `Session not found: ${sessionKey}`,
      },
    });
    return true;
  }

  const result = await killSubagentRunAdmin({
    cfg,
    sessionKey: canonicalKey,
  });

  sendJson(res, 200, {
    ok: true,
    killed: result.killed,
  });
  return true;
}
