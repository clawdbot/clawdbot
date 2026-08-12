import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateMcpOAuthCancelParams,
  validateMcpOAuthDisconnectParams,
  validateMcpOAuthStartParams,
  validateMcpOAuthStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { operatorMcpOAuthIdentity } from "../../agents/mcp-oauth-identity.js";
import {
  cancelMcpOAuthAuthorization,
  clearMcpOAuthCredentials,
  readMcpOAuthControlStatus,
  settleExpiredMcpOAuthAuthorization,
  startMcpOAuthAuthorization,
} from "../../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../../agents/mcp-transport-config.js";
import { resolveGatewayPublicOrigin } from "../../config/gateway-public-origin.js";
import { normalizeConfiguredMcpServers } from "../../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const MCP_OAUTH_LAUNCH_PATH_PREFIX = "/oauth/mcp/authorize/";

type SharedOAuthServer = {
  identity: ReturnType<typeof operatorMcpOAuthIdentity>;
  resolved: Extract<NonNullable<ReturnType<typeof resolveMcpTransportConfig>>, { kind: "http" }>;
};

function unavailable(respond: RespondFn): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      "MCP OAuth authorization is unavailable for this server.",
    ),
  );
}

function resolveSharedOAuthServer(
  config: OpenClawConfig,
  serverName: string,
): SharedOAuthServer | null {
  const rawServer = normalizeConfiguredMcpServers(config.mcp?.servers)[serverName];
  if (!rawServer || rawServer.enabled === false || rawServer.auth !== "oauth") {
    return null;
  }
  const oauth = isRecord(rawServer.oauth) ? rawServer.oauth : undefined;
  if (oauth?.identity === "per-requester") {
    return null;
  }
  const resolved = resolveMcpTransportConfig(serverName, rawServer, { logWarnings: false });
  if (resolved?.kind !== "http" || resolved.auth !== "oauth") {
    return null;
  }
  return {
    identity: operatorMcpOAuthIdentity(serverName, resolved.url),
    resolved,
  };
}

function resolveCallbackUrl(config: OpenClawConfig, client: GatewayClient | null): string | null {
  const origin = resolveGatewayPublicOrigin(config) ?? client?.internal?.gatewayHttpOrigin;
  if (!origin) {
    return null;
  }
  try {
    return new URL(MCP_OAUTH_CALLBACK_PATH, origin).toString();
  } catch {
    return null;
  }
}

export const mcpOAuthHandlers: GatewayRequestHandlers = {
  "mcp.oauth.status": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateMcpOAuthStatusParams, "mcp.oauth.status", respond)) {
      return;
    }
    const config = context.getRuntimeConfig();
    const server = resolveSharedOAuthServer(config, params.serverName);
    if (!server || !resolveCallbackUrl(config, client)) {
      unavailable(respond);
      return;
    }
    const status = readMcpOAuthControlStatus(server.identity);
    if (status.state === "error" && status.category === "timed-out") {
      await settleExpiredMcpOAuthAuthorization(server.identity);
    }
    respond(true, { status: readMcpOAuthControlStatus(server.identity) });
  },
  "mcp.oauth.start": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateMcpOAuthStartParams, "mcp.oauth.start", respond)) {
      return;
    }
    const config = context.getRuntimeConfig();
    const server = resolveSharedOAuthServer(config, params.serverName);
    const redirectUrl = resolveCallbackUrl(config, client);
    if (!server || !redirectUrl) {
      unavailable(respond);
      return;
    }
    try {
      const result = await startMcpOAuthAuthorization(server.identity, server.resolved, {
        redirectUrl,
        forceAuthorization: params.reauthorize === true,
      });
      respond(true, {
        status: readMcpOAuthControlStatus(server.identity),
        ...(result.status === "redirect"
          ? {
              authorizationPath: `${MCP_OAUTH_LAUNCH_PATH_PREFIX}${encodeURIComponent(result.authorizationId)}`,
            }
          : {}),
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "MCP OAuth authorization could not be started."),
      );
    }
  },
  "mcp.oauth.cancel": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMcpOAuthCancelParams, "mcp.oauth.cancel", respond)) {
      return;
    }
    const server = resolveSharedOAuthServer(context.getRuntimeConfig(), params.serverName);
    if (!server) {
      unavailable(respond);
      return;
    }
    const cancelled = await cancelMcpOAuthAuthorization(server.identity, params.authorizationId);
    respond(true, {
      cancelled,
      status: readMcpOAuthControlStatus(server.identity),
    });
  },
  "mcp.oauth.disconnect": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateMcpOAuthDisconnectParams, "mcp.oauth.disconnect", respond)
    ) {
      return;
    }
    const server = resolveSharedOAuthServer(context.getRuntimeConfig(), params.serverName);
    if (!server) {
      unavailable(respond);
      return;
    }
    await clearMcpOAuthCredentials(server.identity);
    respond(true, { status: readMcpOAuthControlStatus(server.identity) });
  },
};
