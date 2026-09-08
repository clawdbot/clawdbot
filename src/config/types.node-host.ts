// Defines node-host-local capability configuration types.
import type { McpServerConfig } from "./types.mcp.js";
export type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */
  enabled?: boolean;
  /** Optional allowlist of profile names exposed via the proxy; when set, create/delete profile routes are blocked on the proxy surface. */
  allowProfiles?: string[];
};

export type NodeHostConfig = {
  /** Sensitive native agent execution exposed by the headless node host. */
  agentRuns?: {
    claude?: {
      /** Advertise approval-gated Claude CLI turns when the binary is installed. */
      enabled?: boolean;
    };
  };
  /** Full OpenClaw session hosting from Gateway-managed worker bundles. */
  workerRuns?: {
    /** Allow this paired node to host worker sessions (default: false). */
    enabled?: boolean;
    /** Integer worker slots (default: one per available CPU core). */
    capacity?: number;
    /** Worker process boundary: direct host execution or a container (default: none). */
    isolation?: "none" | "container";
    /** Optional Node 24.16+ or 26.1+ container image override for isolated worker sessions. */
    containerImage?: string;
  };
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
