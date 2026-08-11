import { createHash } from "node:crypto";
import { sanitizeServerName } from "./agent-bundle-mcp-names.js";

/** Identity of one principal's OAuth state for one MCP server. */
export type McpOAuthIdentity = {
  storeKey: string;
  principal: "operator";
  serverName: string;
  serverUrl: string;
};

export function operatorMcpOAuthIdentity(serverName: string, serverUrl: string): McpOAuthIdentity {
  const safeServerName = sanitizeServerName(serverName, new Set<string>());
  const hash = createHash("sha256").update(serverName).update("\0").update(serverUrl).digest("hex");
  return {
    storeKey: `${safeServerName}-${hash.slice(0, 16)}`,
    principal: "operator",
    serverName,
    serverUrl,
  };
}

export function mcpOAuthStoreKeyFromLegacyFileName(fileName: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_-]{0,29}-[0-9a-f]{16}\.json$/u.test(fileName)
    ? fileName.slice(0, -".json".length)
    : null;
}
