import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayConnectionAuth } from "./connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
import type { ExplicitGatewayAuth } from "./credentials.js";

export function resolveGatewayUrlOverrideSource(urlSource: string): "cli" | "env" | undefined {
  if (urlSource === "cli --url") {
    return "cli";
  }
  if (urlSource === "env OPENCLAW_GATEWAY_URL") {
    return "env";
  }
  return undefined;
}

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
    preauthHandshakeTimeoutMs: params.config.gateway?.handshakeTimeoutMs,
    auth,
  };
}
