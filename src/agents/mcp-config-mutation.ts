/** Canonical configured-MCP mutations with OAuth credential lifecycle cleanup. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { mcpConfigInternal } from "../config/mcp-config.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { clearMcpOAuthRequesters, clearMcpOAuthServer } from "./mcp-oauth.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

function hasOAuthAuth(server: unknown): boolean {
  return asNullableRecord(server)?.auth === "oauth";
}

function hasRequesterIdentity(server: unknown): boolean {
  return (
    hasOAuthAuth(server) &&
    asNullableRecord(asNullableRecord(server)?.oauth)?.identity === "per-requester"
  );
}

async function clearReplacedMcpOAuth(mutation: {
  name: string;
  previous?: Record<string, unknown>;
  next?: Record<string, unknown>;
}): Promise<void> {
  if (!hasOAuthAuth(mutation.previous)) {
    return;
  }
  const previous = resolveMcpTransportConfig(mutation.name, mutation.previous);
  if (previous?.kind !== "http") {
    return;
  }
  const next = hasOAuthAuth(mutation.next)
    ? resolveMcpTransportConfig(mutation.name, mutation.next)
    : undefined;
  if (next?.kind === "http" && next.url === previous.url) {
    const wasRequester = hasRequesterIdentity(mutation.previous);
    const isRequester = hasRequesterIdentity(mutation.next);
    if (wasRequester === isRequester) {
      return;
    }
    if (wasRequester) {
      // The operator row becomes the shared destination; only requester rows are stale.
      await clearMcpOAuthRequesters(operatorMcpOAuthIdentity(mutation.name, previous.url));
      return;
    }
  }
  await clearMcpOAuthServer(operatorMcpOAuthIdentity(mutation.name, previous.url));
}

export function setConfiguredMcpServer(
  params: Parameters<typeof mcpConfigInternal.set>[0],
): ReturnType<typeof mcpConfigInternal.set> {
  return mcpConfigInternal.set(params, clearReplacedMcpOAuth);
}

export function unsetConfiguredMcpServer(
  params: Parameters<typeof mcpConfigInternal.unset>[0],
): ReturnType<typeof mcpConfigInternal.unset> {
  return mcpConfigInternal.unset(params, clearReplacedMcpOAuth);
}

export function updateConfiguredMcpServer(
  params: Parameters<typeof mcpConfigInternal.update>[0],
): ReturnType<typeof mcpConfigInternal.update> {
  return mcpConfigInternal.update(params, clearReplacedMcpOAuth);
}

export function updateConfiguredMcpServerTools(
  params: Parameters<typeof mcpConfigInternal.updateTools>[0],
): ReturnType<typeof mcpConfigInternal.updateTools> {
  return mcpConfigInternal.updateTools(params, clearReplacedMcpOAuth);
}
