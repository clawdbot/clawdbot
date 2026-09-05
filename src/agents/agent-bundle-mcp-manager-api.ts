/** Module-level session MCP runtime manager entry APIs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  RequesterScopedMcpRuntimeHandle,
  SessionMcpConfigReload,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";

function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

function peekSessionMcpRuntimeManager(): SessionMcpRuntimeManager | undefined {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  return Object.hasOwn(globalStore, SESSION_MCP_RUNTIME_MANAGER_KEY)
    ? (globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] as SessionMcpRuntimeManager)
    : undefined;
}

export async function acquireSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): Promise<SessionMcpRuntimeLease> {
  return await getSessionMcpRuntimeManager().acquire(params);
}

/**
 * Requester-scoped MCP runtime only (no static partition).
 * Shared-thread harnesses use this so static MCP stays harness-native.
 */
export async function acquireRequesterScopedMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): Promise<RequesterScopedMcpRuntimeHandle | undefined> {
  return await getSessionMcpRuntimeManager().acquireRequesterScoped(params);
}

export function rememberAdvertisedScopedMcpCatalog(
  handle: RequesterScopedMcpRuntimeHandle,
  catalog: McpToolCatalog,
): void {
  getSessionMcpRuntimeManager().rememberAdvertisedScopedCatalog(handle, catalog);
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
  return peekSessionMcpRuntimeManager()?.peekSession({
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

/** Releases an acquisition after its consumer has taken ownership, or after failure. */
export async function releaseSessionMcpRuntime(lease: {
  runtime: SessionMcpRuntime;
  releaseLease?: () => void;
}): Promise<void> {
  lease.releaseLease?.();
  await completeDeferredSessionMcpRuntimeRetirement(lease.runtime).catch((error: unknown) => {
    logWarn(`bundle-mcp: deferred runtime cleanup failed: ${String(error)}`);
  });
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

export async function reloadSessionMcpRuntimes(params: SessionMcpConfigReload): Promise<void> {
  await peekSessionMcpRuntimeManager()?.reloadConfig(params);
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export function getSessionMcpRuntimeManagerForTesting(): SessionMcpRuntimeManager {
  return getSessionMcpRuntimeManager();
}
