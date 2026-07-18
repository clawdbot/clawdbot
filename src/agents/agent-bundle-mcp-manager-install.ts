/** Session MCP runtime manager install path: static get-or-create + requester resolve/install. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { SessionMcpRuntimeManagerLifecycle } from "./agent-bundle-mcp-manager-lifecycle.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import type { SessionMcpRequesterScope, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  hashMcpResolvedConnections,
  resolveMcpConnectionRevalidateMs,
  resolveRequesterScopedMcpConnections,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";

type RuntimeEntryParams = {
  runtimeKey: string;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  idleTtlMs: number;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  configFingerprint?: string;
};

type SessionMcpRuntimeManagerInstall = {
  getOrCreateRuntimeEntry: (params: RuntimeEntryParams) => Promise<SessionMcpRuntime>;
  resolveAndInstallRequesterRuntime: (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    requesterScopedServerNames: readonly string[];
    scopedNameSet: ReadonlySet<string>;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    fullScopedFingerprint: string;
    requesterSenderId: string;
    agentAccountId?: string | null;
    messageChannel?: string | null;
    requesterScope: SessionMcpRequesterScope;
  }) => Promise<SessionMcpRuntime | undefined>;
};

const matchesStaticReuse = (params: {
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
  candidate: { workspaceDir: string; agentDir?: string; configFingerprint: string };
}): boolean =>
  params.candidate.workspaceDir === params.workspaceDir &&
  params.candidate.agentDir === params.agentDir &&
  params.candidate.configFingerprint === params.configFingerprint;

export function createSessionMcpRuntimeManagerInstall(
  lifecycle: SessionMcpRuntimeManagerLifecycle,
): SessionMcpRuntimeManagerInstall {
  const { store } = lifecycle;
  const cancelReusableRetirement = (sessionId: string) => {
    if (store.requiredRetirementSessionIds.has(sessionId)) {
      store.deferredRetirementSessionIds.add(sessionId);
      return;
    }
    store.deferredRetirementSessionIds.delete(sessionId);
  };

  /** Static/session runtime get-or-create (createInFlight dedup for bare keys only). */
  const getOrCreateRuntimeEntry = async (
    params: RuntimeEntryParams,
  ): Promise<SessionMcpRuntime> => {
    const nextFingerprint =
      params.configFingerprint ??
      loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: params.includeServerNames,
        excludeServerNames: params.excludeServerNames,
        redactConnectionServerNames: params.redactConnectionServerNames,
        safeServerNamesByServer: params.safeServerNamesByServer,
      }).fingerprint;
    const existing = store.runtimesBySessionId.get(params.runtimeKey);
    if (existing) {
      if (
        !matchesStaticReuse({
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          configFingerprint: nextFingerprint,
          candidate: existing,
        })
      ) {
        store.runtimesBySessionId.delete(params.runtimeKey);
        store.idleTtlMsBySessionId.delete(params.runtimeKey);
        store.connectionMetaByRuntimeKey.delete(params.runtimeKey);
        await existing.dispose();
      } else {
        cancelReusableRetirement(params.sessionId);
        existing.markUsed();
        store.idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
        return existing;
      }
    }
    const inFlight = store.createInFlight.get(params.runtimeKey);
    if (inFlight) {
      if (
        matchesStaticReuse({
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          configFingerprint: nextFingerprint,
          candidate: inFlight,
        })
      ) {
        return inFlight.promise;
      }
      store.createInFlight.delete(params.runtimeKey);
      const staleRuntime = await inFlight.promise.catch(() => undefined);
      store.runtimesBySessionId.delete(params.runtimeKey);
      store.idleTtlMsBySessionId.delete(params.runtimeKey);
      store.connectionMetaByRuntimeKey.delete(params.runtimeKey);
      await staleRuntime?.dispose();
    }
    const created = Promise.resolve(
      store.createRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        cfg: params.cfg,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: params.includeServerNames,
        excludeServerNames: params.excludeServerNames,
        safeServerNamesByServer: params.safeServerNamesByServer,
        connectionOverrides: params.connectionOverrides,
        redactConnectionServerNames: params.redactConnectionServerNames,
        requesterScope: params.requesterScope,
        configFingerprint: nextFingerprint,
      }),
    ).then((runtime) => {
      cancelReusableRetirement(params.sessionId);
      runtime.markUsed();
      store.runtimesBySessionId.set(params.runtimeKey, runtime);
      store.idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      return runtime;
    });
    store.createInFlight.set(params.runtimeKey, {
      promise: created,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      configFingerprint: nextFingerprint,
    });
    try {
      return await created;
    } finally {
      store.createInFlight.delete(params.runtimeKey);
    }
  };

  /**
   * Install or reuse a requester runtime for already-resolved connections.
   * Must run inside runExclusiveOnRuntimeKey for this runtimeKey.
   */
  const installRequesterRuntime = async (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    connectionOverrides: Map<string, McpServerConnectionResolved>;
    redactConnectionServerNames: ReadonlySet<string>;
    requesterScope: SessionMcpRequesterScope;
  }): Promise<SessionMcpRuntime> => {
    const resolvedNameSet = new Set(params.connectionOverrides.keys());
    const { fingerprint: resolvedFingerprint } = loadSessionMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      logDiagnostics: false,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: resolvedNameSet,
      redactConnectionServerNames: params.redactConnectionServerNames,
      safeServerNamesByServer: params.safeServerNamesByServer,
    });
    const connectionHash = hashMcpResolvedConnections(params.connectionOverrides);
    const existing = store.runtimesBySessionId.get(params.runtimeKey);
    const meta = store.connectionMetaByRuntimeKey.get(params.runtimeKey);
    if (
      existing &&
      meta?.connectionHash === connectionHash &&
      matchesStaticReuse({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: resolvedFingerprint,
        candidate: existing,
      })
    ) {
      cancelReusableRetirement(params.sessionId);
      existing.markUsed();
      store.idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      store.connectionMetaByRuntimeKey.set(params.runtimeKey, {
        connectionHash,
        resolvedAt: store.now(),
      });
      return existing;
    }
    if (existing) {
      store.runtimesBySessionId.delete(params.runtimeKey);
      store.idleTtlMsBySessionId.delete(params.runtimeKey);
      store.connectionMetaByRuntimeKey.delete(params.runtimeKey);
      await existing.dispose();
    }
    const runtime = await getOrCreateRuntimeEntry({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      idleTtlMs: params.idleTtlMs,
      includeServerNames: resolvedNameSet,
      safeServerNamesByServer: params.safeServerNamesByServer,
      connectionOverrides: params.connectionOverrides,
      redactConnectionServerNames: params.redactConnectionServerNames,
      requesterScope: params.requesterScope,
      configFingerprint: resolvedFingerprint,
    });
    store.connectionMetaByRuntimeKey.set(params.runtimeKey, {
      connectionHash,
      resolvedAt: store.now(),
    });
    return runtime;
  };

  /** Revoke cached scoped runtime (empty re-resolution). Auth boundary: leases do not block. */
  const revokeRequesterRuntime = async (runtimeKey: string): Promise<void> => {
    await lifecycle.disposeRuntimeKeyNow(runtimeKey);
  };

  /**
   * Full requester section for one runtimeKey: reuse / resolve / install / revoke.
   * Always invoked under runExclusiveOnRuntimeKey.
   */
  const resolveAndInstallRequesterRuntime = async (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    requesterScopedServerNames: readonly string[];
    scopedNameSet: ReadonlySet<string>;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    fullScopedFingerprint: string;
    requesterSenderId: string;
    agentAccountId?: string | null;
    messageChannel?: string | null;
    requesterScope: SessionMcpRequesterScope;
  }): Promise<SessionMcpRuntime | undefined> => {
    const existing = store.runtimesBySessionId.get(params.runtimeKey);
    const meta = store.connectionMetaByRuntimeKey.get(params.runtimeKey);
    const revalidateMs = resolveMcpConnectionRevalidateMs();
    // Full-set + within revalidation window: skip resolver I/O.
    // Revocation/rotation takes effect within MCP_CONNECTION_REVALIDATE_MS even for
    // continuously active requesters (markUsed does not extend this clock alone).
    const withinRevalidateWindow =
      meta !== undefined && store.now() - meta.resolvedAt < revalidateMs;
    if (
      withinRevalidateWindow &&
      existing &&
      matchesStaticReuse({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: params.fullScopedFingerprint,
        candidate: existing,
      })
    ) {
      cancelReusableRetirement(params.sessionId);
      existing.markUsed();
      store.idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      return existing;
    }

    const connectionOverrides = await resolveRequesterScopedMcpConnections({
      serverNames: params.requesterScopedServerNames,
      requesterSenderId: params.requesterSenderId,
      agentAccountId: params.agentAccountId,
      messageChannel: params.messageChannel,
    });
    if (connectionOverrides.size === 0) {
      // Empty re-resolution revokes cached scoped credentials.
      // Leases do not block: this is an authorization boundary.
      if (
        store.runtimesBySessionId.has(params.runtimeKey) ||
        store.createInFlight.has(params.runtimeKey)
      ) {
        await revokeRequesterRuntime(params.runtimeKey);
      }
      return undefined;
    }
    return await installRequesterRuntime({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      idleTtlMs: params.idleTtlMs,
      safeServerNamesByServer: params.safeServerNamesByServer,
      connectionOverrides,
      redactConnectionServerNames: params.scopedNameSet,
      requesterScope: params.requesterScope,
    });
  };

  return {
    getOrCreateRuntimeEntry,
    resolveAndInstallRequesterRuntime,
  };
}
