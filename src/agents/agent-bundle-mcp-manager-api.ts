/** Module-level session MCP runtime manager entry APIs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";

function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

/**
 * Requester-scoped MCP runtime only (no static partition).
 * Shared-thread harnesses use this so static MCP stays harness-native.
 */
export async function getOrCreateRequesterScopedMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
}): Promise<SessionMcpRuntime | undefined> {
  return await getSessionMcpRuntimeManager().getOrCreateRequesterScoped(params);
}

export function rememberAdvertisedScopedMcpCatalog(
  sessionId: string,
  catalog: McpToolCatalog,
): void {
  getSessionMcpRuntimeManager().rememberAdvertisedScopedCatalog(sessionId, catalog);
}

export function getAdvertisedScopedMcpCatalog(sessionId: string): McpToolCatalog | null {
  return getSessionMcpRuntimeManager().getAdvertisedScopedCatalog(sessionId);
}

/** Looks up an existing session MCP runtime without creating it or connecting transports. */
export function peekSessionMcpRuntime(params: {
  sessionId?: string | null;
  sessionKey?: string | null;
}): SessionMcpRuntime | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  return getSessionMcpRuntimeManager().peekSession({
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  });
}

async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  retainAcrossReuse?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const manager = getSessionMcpRuntimeManager();
  const retainAcrossReuse =
    params.preserveActiveLeases === true && params.retainAcrossReuse === true;
  // Aggregate leases across static + all requester-scoped parts so preserveActiveLeases
  // does not miss a leased scoped runtime while peeking only the bare session key.
  if (params.preserveActiveLeases === true) {
    manager.deferRetirement(sessionId, {
      retainAcrossReuse,
    });
    if (manager.totalActiveLeasesForSession(sessionId) > 0) {
      return true;
    }
  }
  try {
    if (retainAcrossReuse) {
      await manager.completeDeferredRetirement(sessionId);
      return true;
    }
    await disposeSessionMcpRuntime(sessionId);
    return true;
  } catch (error) {
    params.onError?.(error, sessionId, params.reason);
    return false;
  }
}

/** Completes a one-shot retirement after its final run, view, or request lease releases. */
export async function completeDeferredSessionMcpRuntimeRetirement(
  runtime: SessionMcpRuntime,
): Promise<boolean> {
  return await getSessionMcpRuntimeManager().completeDeferredRetirement(runtime.sessionId, runtime);
}

export async function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
  return await retireSessionMcpRuntime({
    sessionId,
    reason: params.reason,
    preserveActiveLeases: params.preserveActiveLeases,
    onError: params.onError,
  });
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export function getSessionMcpRuntimeManagerForTesting(): SessionMcpRuntimeManager {
  return getSessionMcpRuntimeManager();
}
