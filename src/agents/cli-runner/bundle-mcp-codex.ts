import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import {
  applyCommonServerConfig,
  decodeHeaderEnvPlaceholder,
  normalizeStringRecord,
} from "./bundle-mcp-adapter-shared.js";
import { serializeTomlInlineValue } from "./toml-inline.js";

function isOpenClawLoopbackMcpServer(name: string, server: BundleMcpServerConfig): boolean {
  return (
    name === "openclaw" &&
    typeof server.url === "string" &&
    /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/mcp(?:[?#].*)?$/.test(server.url)
  );
}

function normalizeCodexServerConfig(
  name: string,
  server: BundleMcpServerConfig,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  applyCommonServerConfig(next, server);
  if (isOpenClawLoopbackMcpServer(name, server)) {
    next.default_tools_approval_mode = "approve";
  }
  const httpHeaders = normalizeStringRecord(server.headers);
  if (httpHeaders) {
    const staticHeaders: Record<string, string> = {};
    const envHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(httpHeaders)) {
      const decoded = decodeHeaderEnvPlaceholder(value);
      if (!decoded) {
        staticHeaders[name] = value;
        continue;
      }
      if (decoded.bearer && normalizeOptionalLowercaseString(name) === "authorization") {
        next.bearer_token_env_var = decoded.envVar;
        continue;
      }
      envHeaders[name] = decoded.envVar;
    }
    if (Object.keys(staticHeaders).length > 0) {
      next.http_headers = staticHeaders;
    }
    if (Object.keys(envHeaders).length > 0) {
      next.env_http_headers = envHeaders;
    }
  }
  return next;
}

export function injectCodexMcpConfigArgs(
  args: string[] | undefined,
  config: BundleMcpConfig,
): string[] {
  const overrides = serializeTomlInlineValue(
    Object.fromEntries(
      Object.entries(config.mcpServers).map(([name, server]) => [
        name,
        normalizeCodexServerConfig(name, server),
      ]),
    ),
  );
  return [...(args ?? []), "-c", `mcp_servers=${overrides}`];
}
