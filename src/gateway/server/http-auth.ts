import type { IncomingMessage } from "node:http";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "../../canvas-host/a2ui.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { CANVAS_CAPABILITY_TTL_MS } from "../canvas-capability.js";
import { getBearerToken, resolveHttpBrowserOriginPolicy } from "../http-auth-utils.js";
import type { GatewayWsClient } from "./ws-types.js";

export function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function hasAuthorizedWsClientForCanvasCapability(
  clients: Set<GatewayWsClient>,
  capability: string,
): boolean {
  const nowMs = Date.now();
  for (const client of clients) {
    if (!client.canvasCapability || !client.canvasCapabilityExpiresAtMs) {
      continue;
    }
    if (client.canvasCapabilityExpiresAtMs <= nowMs) {
      continue;
    }
    if (safeEqualSecret(client.canvasCapability, capability)) {
      // Sliding expiration while the connected node keeps using canvas.
      client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
      return true;
    }
  }
  return false;
}

export async function authorizeCanvasRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
  canvasCapability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    allowRealIpFallback,
    clients,
    canvasCapability,
    malformedScopedPath,
    rateLimiter,
  } = params;
  if (malformedScopedPath) {
    return { ok: false, reason: "unauthorized" };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeHttpGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  if (canvasCapability && hasAuthorizedWsClientForCanvasCapability(clients, canvasCapability)) {
    return { ok: true };
  }
  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}
