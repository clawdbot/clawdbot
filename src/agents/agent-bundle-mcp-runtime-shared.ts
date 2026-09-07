import type { SessionToolOverrides } from "../config/sessions/types.js";
/** Shared session MCP runtime constants and create-runtime factory type. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type {
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import type { McpServerConnectionResolved } from "./mcp-connection-resolver.js";

export const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
export const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
// Includes runtimes being created or drained; existing sessions never evict for capacity.
export const SESSION_MCP_MAX_LIVE_RUNTIMES = 256;

/** Idle eviction is opt-in; zero retains the session lifetime. */
export function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.mcp?.sessionIdleTtlMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** Checks whether harness-scoped MCP can affect a turn without loading its runtime graph. */
export function shouldLoadRequesterScopedMcpHarnessRuntime(params: {
  sessionId: string;
  requesterSenderId?: string | null;
}): boolean {
  if (params.requesterSenderId?.trim()) {
    return true;
  }
  const manager = (globalThis as Record<PropertyKey, unknown>)[SESSION_MCP_RUNTIME_MANAGER_KEY] as
    | SessionMcpRuntimeManager
    | undefined;
  return (manager?.getAdvertisedScopedCatalog(params.sessionId)?.tools.length ?? 0) > 0;
}

export type CreateSessionMcpRuntime = (params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  requesterConnect?: RequesterMcpConnect;
  configFingerprint?: string;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}) => SessionMcpRuntime | Promise<SessionMcpRuntime>;
