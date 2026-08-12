import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthStoreKeyPrefix,
  type McpOAuthIdentity,
} from "../agents/mcp-oauth-identity.js";
import {
  MCP_OAUTH_PENDING_STATE_TTL_MS,
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
} from "../agents/mcp-oauth-store.js";
import { completeOAuthCallback, settleMcpOAuthCallback } from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const MCP_OAUTH_LAUNCH_PATH_PREFIX = "/oauth/mcp/authorize/";
const MCP_OAUTH_CALLBACK_MAX_URL_BYTES = 8 * 1024;
const MCP_OAUTH_AUTHORIZATION_ID_MAX_BYTES = 128;
const CONNECTED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Account connected</title><body><main><h1>You\'re connected.</h1><p>Return to OpenClaw.</p></main></body></html>';
const RETRY_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in incomplete</title><body><main><h1>Sign-in wasn\'t completed.</h1><p>Retry authorization in OpenClaw.</p></main></body></html>';
const EXPIRED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in link expired</title><body><main><h1>This sign-in link expired or was already used.</h1><p>Retry authorization in OpenClaw.</p></main></body></html>';

type CallbackLog = Pick<Console, "warn">;

function respondHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function respondAuthorizationRedirect(res: ServerResponse, authorizationUrl: string): void {
  res.statusCode = 302;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Location", authorizationUrl);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end();
}

function readAuthorizationId(pathname: string): string | undefined {
  if (!pathname.startsWith(MCP_OAUTH_LAUNCH_PATH_PREFIX)) {
    return undefined;
  }
  const encoded = pathname.slice(MCP_OAUTH_LAUNCH_PATH_PREFIX.length);
  if (!encoded || encoded.includes("/") || Buffer.byteLength(encoded, "utf8") > 256) {
    return undefined;
  }
  try {
    const authorizationId = decodeURIComponent(encoded);
    return authorizationId.length > 0 &&
      Buffer.byteLength(authorizationId, "utf8") <= MCP_OAUTH_AUTHORIZATION_ID_MAX_BYTES
      ? authorizationId
      : undefined;
  } catch {
    return undefined;
  }
}

function readPendingState(lastAuthorizationUrl: string): string | undefined {
  try {
    return new URL(lastAuthorizationUrl).searchParams.get("state")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isOAuthServer(server: Record<string, unknown>): boolean {
  return server.enabled !== false && server.auth === "oauth";
}

function isPerRequesterServer(server: Record<string, unknown>): boolean {
  const oauth = isRecord(server.oauth) ? server.oauth : undefined;
  return oauth?.identity === "per-requester";
}

/** Completes one MCP OAuth redirect using durable state correlation. */
export async function handleMcpOAuthCallback(
  req: IncomingMessage,
  res: ServerResponse,
  params: { config: OpenClawConfig; log: CallbackLog },
): Promise<boolean> {
  if (req.method !== "GET") {
    return false;
  }
  const rawUrl = req.url ?? "/";
  const url = new URL(rawUrl, "http://localhost");
  const isCallback = url.pathname === MCP_OAUTH_CALLBACK_PATH;
  const isAuthorizationLaunch = url.pathname.startsWith(MCP_OAUTH_LAUNCH_PATH_PREFIX);
  if (!isCallback && !isAuthorizationLaunch) {
    return false;
  }
  const configuredServers = Object.entries(
    normalizeConfiguredMcpServers(params.config.mcp?.servers),
  )
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, rawServer]) => {
      if (!isOAuthServer(rawServer)) {
        return [];
      }
      const resolved = resolveMcpTransportConfig(serverName, rawServer, { logWarnings: false });
      return resolved?.kind === "http" && resolved.auth === "oauth"
        ? [{ serverName, resolved, perRequester: isPerRequesterServer(rawServer) }]
        : [];
    });
  if (configuredServers.length === 0) {
    return false;
  }
  if (isAuthorizationLaunch) {
    const authorizationId = url.search === "" ? readAuthorizationId(url.pathname) : undefined;
    const launch = authorizationId
      ? configuredServers
          .filter(({ perRequester }) => !perRequester)
          .map(({ serverName, resolved }) => {
            const identity = operatorMcpOAuthIdentity(serverName, resolved.url);
            return { identity, store: readMcpOAuthStore(identity.storeKey) };
          })
          .find(({ store }) => {
            const attempt = store.authorizationAttempt;
            return (
              attempt?.status === "pending" &&
              attempt.id === authorizationId &&
              attempt.startedAt > Date.now() - MCP_OAUTH_PENDING_STATE_TTL_MS &&
              typeof store.lastAuthorizationUrl === "string" &&
              URL.canParse(store.lastAuthorizationUrl)
            );
          })
      : undefined;
    if (!launch?.store.lastAuthorizationUrl) {
      respondHtml(res, 404, EXPIRED_HTML);
      return true;
    }
    respondAuthorizationRedirect(res, launch.store.lastAuthorizationUrl);
    return true;
  }
  if (Buffer.byteLength(rawUrl, "utf8") > MCP_OAUTH_CALLBACK_MAX_URL_BYTES) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }

  const state = url.searchParams.get("state")?.trim();
  const storeKey = state ? readMcpOAuthPendingAuthorization(state) : undefined;
  const pending = storeKey ? readMcpOAuthStore(storeKey) : undefined;
  if (!storeKey || !state || readPendingState(pending?.lastAuthorizationUrl ?? "") !== state) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }

  const configuredServer = configuredServers.find(({ serverName, resolved, perRequester }) =>
    perRequester
      ? storeKey.startsWith(requesterMcpOAuthStoreKeyPrefix(serverName, resolved.url))
      : storeKey === operatorMcpOAuthIdentity(serverName, resolved.url).storeKey,
  );
  if (!configuredServer) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }
  const identity: McpOAuthIdentity = configuredServer.perRequester
    ? {
        storeKey,
        principal: "requester",
        serverName: configuredServer.serverName,
        serverUrl: configuredServer.resolved.url,
      }
    : operatorMcpOAuthIdentity(configuredServer.serverName, configuredServer.resolved.url);
  if (url.searchParams.has("error")) {
    await settleMcpOAuthCallback(identity, { state, category: "authorization-denied" });
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    await settleMcpOAuthCallback(identity, { state, category: "callback-invalid" });
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }

  try {
    const result = await completeOAuthCallback(identity, configuredServer.resolved, {
      code,
      state,
    });
    if (result === "expired") {
      respondHtml(res, 404, EXPIRED_HTML);
      return true;
    }
    respondHtml(res, 200, CONNECTED_HTML);
  } catch {
    await settleMcpOAuthCallback(identity, {
      state,
      category: "exchange-failed",
      stateAlreadyClaimed: true,
    });
    params.log.warn(`MCP OAuth callback failed for server "${configuredServer.serverName}".`);
    respondHtml(res, 400, RETRY_HTML);
  }
  return true;
}
