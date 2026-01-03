/**
 * ACP-GW Types
 *
 * Local session state and configuration for the Gateway-backed ACP server.
 */

/**
 * Local session state tracked by acp.
 * The actual conversation state lives in the Gateway.
 */
export type AcpGwSession = {
  /** ACP session ID (UUID) */
  sessionId: string;
  /** Gateway session key ("acp:<uuid>") */
  sessionKey: string;
  /** Working directory from newSession */
  cwd: string;
  /** Creation timestamp */
  createdAt: number;
  /** Abort controller for in-flight prompts */
  abortController: AbortController | null;
  /** Current run ID if a prompt is in progress */
  activeRunId: string | null;
};

/**
 * CLI options for acp server.
 */
export type AcpGwOptions = {
  /** Gateway WebSocket URL (default: ws://127.0.0.1:18789) */
  gatewayUrl?: string;
  /** Gateway auth token */
  gatewayToken?: string;
  /** Gateway auth password */
  gatewayPassword?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
  /** Path to persist sessions (default: none, in-memory only) */
  sessionStorePath?: string;
};

/**
 * Serializable session data for persistence.
 */
export type PersistedSession = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  createdAt: number;
};

/**
 * Agent info for ACP initialization response.
 */
export const ACP_GW_AGENT_INFO = {
  name: "clawd-gw",
  title: "Clawd (Gateway-backed)",
  version: "1.0.0",
};
