// Defines node-host-local capability configuration types.
import type { McpServerConfig } from "./types.mcp.js";
export type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */
  enabled?: boolean;
  /** Optional allowlist of profile names exposed via the proxy; when set, create/delete profile routes are blocked on the proxy surface. */
  allowProfiles?: string[];
};

export type NodeHostConfig = {
  /** Browser proxy settings for node hosts. */
  browserProxy?: NodeHostBrowserProxyConfig;
  /** MCP servers started and exposed by the headless node host. */
  mcp?: {
    servers?: Record<string, McpServerConfig>;
  };
  /** Skills published by the headless node host. */
  skills?: {
    /** Scan and publish ~/.openclaw/skills (default: true). */
    enabled?: boolean;
  };
};
