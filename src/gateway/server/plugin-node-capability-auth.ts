// Plugin node capability auth lets node-issued route capabilities supplement normal bearer gateway auth.
import type { IncomingMessage } from "node:http";
import { AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET, type AuthRateLimiter } from "../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../auth.js";
import { getBearerToken, resolveHttpBrowserOriginPolicy } from "../http-auth-utils.js";
import {
  prepareGatewayIngressAttribution,
  PROXY_ATTRIBUTION_REQUIRED_REASON,
} from "../ingress-attribution.js";
import {
  hasAuthorizedPluginNodeCapability,
  type PluginNodeCapabilitySurface,
} from "../plugin-node-capability.js";
import { withSerializedCredentialFallbackAttempt } from "../rate-limit-attempt-serialization.js";
import type { GatewayWsClient } from "./ws-types.js";

/**
 * Authorizes plugin HTTP routes that can be reached by node-issued capabilities.
 */
export async function authorizePluginNodeCapabilityRequest(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
  nodeCapability: PluginNodeCapabilitySurface;
  capability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    allowRealIpFallback,
    clients,
    nodeCapability,
    capability,
    malformedScopedPath,
    rateLimiter,
  } = params;
  if (malformedScopedPath) {
    return { ok: false, reason: "unauthorized" };
  }

  const attribution = prepareGatewayIngressAttribution({
    req,
    trustedProxies,
    allowRealIpFallback,
  });
  if (attribution.kind === "unattributable-proxy") {
    return { ok: false, reason: PROXY_ATTRIBUTION_REQUIRED_REASON };
  }
  const token = getBearerToken(req);
  const run = async (): Promise<GatewayAuthResult> => {
    let lastAuthFailure: GatewayAuthResult | null = null;
    if (token) {
      // Bearer gateway auth wins when present; capability auth is only a fallback
      // for nodes that still own the route surface after bearer auth completes.
      const authResult = await authorizeHttpGatewayConnect({
        auth: { ...auth, allowTailscale: false },
        connectAuth: { token, password: token },
        req,
        trustedProxies,
        allowRealIpFallback,
        rateLimiter,
        // The capability is part of this request's terminal credential set. A
        // stale bearer must not poison the shared bucket when the fallback wins.
        deferRateLimitFailure: Boolean(capability),
        browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
      });
      if (authResult.ok) {
        return authResult;
      }
      lastAuthFailure = authResult;
    }

    if (
      capability &&
      hasAuthorizedPluginNodeCapability({ clients, surface: nodeCapability, capability })
    ) {
      return { ok: true };
    }

    if (
      capability &&
      (lastAuthFailure?.reason === "token_mismatch" ||
        lastAuthFailure?.reason === "password_mismatch")
    ) {
      await rateLimiter?.recordFailureAndDelay(
        attribution.rateLimit.subject.key,
        AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
      );
    }

    return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
  };

  return token && capability && rateLimiter
    ? await withSerializedCredentialFallbackAttempt({
        limiter: rateLimiter,
        ip: attribution.rateLimit.subject.key,
        run,
      })
    : await run();
}
