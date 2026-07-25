// Gateway client bootstrap resolver.
// Collects URL, auth, and handshake settings before constructing a GatewayClient.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayConnectionAuth } from "./connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { ExplicitGatewayAuth } from "./credentials.js";

/**
 * Maps connection-detail source labels to the override kinds that affect auth fallback.
 */
function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined {
  if (urlSource === "cli --url") {
    return "cli";
  }
  if (urlSource === "env OPENCLAW_GATEWAY_URL") {
    return "env";
  }
  return undefined;
}

/**
 * Resolves the URL, auth material, and handshake tuning needed to start a GatewayClient.
 */
export async function resolveGatewayClientBootstrap(params: {
  config: OpenClawConfig;
  gatewayUrl?: string;
  explicitAuth?: ExplicitGatewayAuth;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  url: string;
  urlSource: string;
  preauthHandshakeTimeoutMs?: number;
  auth: {
    token?: string;
    password?: string;
  };
}> {
  const connection = buildGatewayConnectionDetailsWithResolvers({
    config: params.config,
    url: params.gatewayUrl,
  });
  const urlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
  // Only direct CLI/env URL overrides should constrain token/password fallback. Config-derived
  // remote URLs are canonical config, not a caller override.
  const auth = await resolveGatewayConnectionAuth({
    config: params.config,
    explicitAuth: params.explicitAuth,
    env: params.env ?? process.env,
    urlOverride: urlOverrideSource ? connection.url : undefined,
    urlOverrideSource,
  });
  return {
    url: connection.url,
    urlSource: connection.urlSource,
    auth,
  };
}
