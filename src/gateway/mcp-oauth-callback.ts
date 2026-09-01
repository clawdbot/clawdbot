import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requesterMcpOAuthStoreKeyPrefix } from "../agents/mcp-oauth-identity.js";
import { readMcpOAuthPendingAuthorization, readMcpOAuthStore } from "../agents/mcp-oauth-store.js";
import { completeOAuthCallback } from "../agents/mcp-oauth.js";
import { resolveMcpTransportConfig } from "../agents/mcp-transport-config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";

const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
const MCP_OAUTH_CALLBACK_MAX_URL_BYTES = 8 * 1024;
const CONNECTED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Account connected</title><body><main><h1>You\'re connected.</h1><p>Return to the chat.</p></main></body></html>';
const RETRY_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in incomplete</title><body><main><h1>Sign-in wasn\'t completed.</h1><p>Ask the bot to connect again.</p></main></body></html>';
const EXPIRED_HTML =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in link expired</title><body><main><h1>This sign-in link expired or was already used.</h1><p>Ask the bot to connect again.</p></main></body></html>';

type CallbackLog = Pick<Console, "warn">;

function respondHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(body);
}

function readPendingState(lastAuthorizationUrl: string): string | undefined {
  try {
    return new URL(lastAuthorizationUrl).searchParams.get("state")?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function isPerRequesterServer(server: Record<string, unknown>): boolean {
  const oauth = isRecord(server.oauth) ? server.oauth : undefined;
  return server.enabled !== false && server.auth === "oauth" && oauth?.identity === "per-requester";
}

/** Completes one requester MCP OAuth redirect using durable state correlation. */
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
  if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
    return false;
  }
  const configuredServers = Object.entries(
    normalizeConfiguredMcpServers(params.config.mcp?.servers),
  )
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, rawServer]) => {
      if (!isPerRequesterServer(rawServer)) {
        return [];
      }
      const resolved = resolveMcpTransportConfig(serverName, rawServer, { logWarnings: false });
      return resolved?.kind === "http" && resolved.auth === "oauth"
        ? [{ serverName, resolved }]
        : [];
    });
  if (configuredServers.length === 0) {
    return false;
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

  const configuredServer = configuredServers.find(({ serverName, resolved }) =>
    storeKey.startsWith(requesterMcpOAuthStoreKeyPrefix(serverName, resolved.url)),
  );
  if (!configuredServer) {
    respondHtml(res, 404, EXPIRED_HTML);
    return true;
  }
  if (url.searchParams.has("error")) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }
  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    respondHtml(res, 400, RETRY_HTML);
    return true;
  }

  try {
    const result = await completeOAuthCallback(
      {
        storeKey,
        principal: "requester",
        serverName: configuredServer.serverName,
        serverUrl: configuredServer.resolved.url,
      },
      configuredServer.resolved,
      { code, state },
    );
    if (result === "expired") {
      respondHtml(res, 404, EXPIRED_HTML);
      return true;
    }
    respondHtml(res, 200, CONNECTED_HTML);
  } catch (error) {
    params.log.warn(
      `MCP OAuth callback failed for server "${configuredServer.serverName}": ${formatErrorMessage(error)}`,
    );
    respondHtml(res, 400, RETRY_HTML);
  }
  return true;
}
