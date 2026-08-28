import type { SessionToolOverrides } from "../config/sessions/types.js";
/** Session MCP runtime manager install path: static get-or-create + requester resolve/install. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { SessionMcpRuntimeManagerLifecycle } from "./agent-bundle-mcp-manager-lifecycle.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import type {
  RequesterMcpConnect,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { allowMcpAppModelContext, revokeMcpAppModelContext } from "./mcp-app-model-context.js";
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
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  requesterConnect?: RequesterMcpConnect;
  configFingerprint?: string;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
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
    oauthRequesterNameSet: ReadonlySet<string>;
    mcpServers: Record<string, BundleMcpServerConfig>;
    resolverRequesterServerNames: readonly string[];
    safeServerNamesByServer: ReadonlyMap<string, string>;
    fullScopedFingerprint: string;
    requesterSenderId: string;
    agentAccountId?: string | null;
    messageChannel?: string | null;
    requesterScope: SessionMcpRequesterScope;
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
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

function requesterRuntimeFingerprint(
  configFingerprint: string,
  requesterConnect?: RequesterMcpConnect,
): string {
  return requesterConnect
    ? `${configFingerprint}:${requesterConnect.configFingerprint}`
    : configFingerprint;
}

export function createSessionMcpRuntimeManagerInstall(
  lifecycle: SessionMcpRuntimeManagerLifecycle,
): SessionMcpRuntimeManagerInstall {
  const { store } = lifecycle;
  const reconcileReusableRetirement = (sessionId: string, runtime: SessionMcpRuntime) => {
    if (store.requiredRetirementSessionIds.has(sessionId)) {
      // Reset/delete retirement deliberately survives late creation and reuse;
      // otherwise a racing run could escape the required session teardown.
      store.deferredRetirementSessionIds.add(sessionId);
      revokeMcpAppModelContext(runtime);
      return;
    }
    store.deferredRetirementSessionIds.delete(sessionId);
    allowMcpAppModelContext(runtime);
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
        toolOverrides: params.toolOverrides,
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
        store.connectionMetaByRuntimeKey.delete(params.runtimeKey);
        await existing.dispose();
      } else {
        reconcileReusableRetirement(params.sessionId, existing);
        existing.markUsed();
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
        requesterConnect: params.requesterConnect,
        configFingerprint: nextFingerprint,
        toolOverrides: params.toolOverrides,
      }),
    ).then((runtime) => {
      reconcileReusableRetirement(params.sessionId, runtime);
      runtime.markUsed();
      store.runtimesBySessionId.set(params.runtimeKey, runtime);
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

  /** Install or reuse one requester runtime. Must run under its runtime-key lock. */
  const installRequesterRuntime = async (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    includeServerNames: ReadonlySet<string>;
    requesterConnect?: RequesterMcpConnect;
    connectionOverrides: Map<string, McpServerConnectionResolved>;
    redactConnectionServerNames: ReadonlySet<string>;
    requesterScope: SessionMcpRequesterScope;
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  }): Promise<SessionMcpRuntime> => {
    const { fingerprint: resolvedFingerprint } = loadSessionMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      logDiagnostics: false,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: params.includeServerNames,
      redactConnectionServerNames: params.redactConnectionServerNames,
      safeServerNamesByServer: params.safeServerNamesByServer,
      toolOverrides: params.toolOverrides,
    });
    const runtimeFingerprint = requesterRuntimeFingerprint(
      resolvedFingerprint,
      params.requesterConnect,
    );
    const connectionHash = hashMcpResolvedConnections(params.connectionOverrides);
    const existing = store.runtimesBySessionId.get(params.runtimeKey);
    const meta = store.connectionMetaByRuntimeKey.get(params.runtimeKey);
    if (
      existing &&
      meta?.connectionHash === connectionHash &&
      matchesStaticReuse({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: runtimeFingerprint,
        candidate: existing,
      })
    ) {
      reconcileReusableRetirement(params.sessionId, existing);
      existing.markUsed();
      store.connectionMetaByRuntimeKey.set(params.runtimeKey, {
        connectionHash,
        resolvedAt: store.now(),
      });
      return existing;
    }
    if (existing) {
      store.runtimesBySessionId.delete(params.runtimeKey);
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
      includeServerNames: params.includeServerNames,
      safeServerNamesByServer: params.safeServerNamesByServer,
      connectionOverrides: params.connectionOverrides,
      redactConnectionServerNames: params.redactConnectionServerNames,
      requesterScope: params.requesterScope,
      requesterConnect: params.requesterConnect,
      configFingerprint: runtimeFingerprint,
      toolOverrides: params.toolOverrides,
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
    oauthRequesterNameSet: ReadonlySet<string>;
    mcpServers: Record<string, BundleMcpServerConfig>;
    resolverRequesterServerNames: readonly string[];
    safeServerNamesByServer: ReadonlyMap<string, string>;
    fullScopedFingerprint: string;
    requesterSenderId: string;
    agentAccountId?: string | null;
    messageChannel?: string | null;
    requesterScope: SessionMcpRequesterScope;
    toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  }): Promise<SessionMcpRuntime | undefined> => {
    const requesterConnect = await createRequesterMcpConnect({
      serverNames: params.oauthRequesterNameSet,
      mcpServers: params.mcpServers,
      safeServerNamesByServer: params.safeServerNamesByServer,
      requesterScope: params.requesterScope,
      cfg: params.cfg,
      configFingerprint: params.fullScopedFingerprint,
    });
    const expectedLiveNameSet = new Set([
      ...(requesterConnect?.authorizedServerNames ?? []),
      ...params.resolverRequesterServerNames,
    ]);
    const { fingerprint: expectedLiveFingerprint } = loadSessionMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      logDiagnostics: false,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: expectedLiveNameSet,
      redactConnectionServerNames: new Set(params.resolverRequesterServerNames),
      safeServerNamesByServer: params.safeServerNamesByServer,
      toolOverrides: params.toolOverrides,
    });
    const scopedFingerprint = requesterRuntimeFingerprint(
      expectedLiveFingerprint,
      requesterConnect,
    );
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
        configFingerprint: scopedFingerprint,
        candidate: existing,
      })
    ) {
      reconcileReusableRetirement(params.sessionId, existing);
      existing.markUsed();
      return existing;
    }

    const connectionOverrides = await resolveRequesterScopedMcpConnections({
      serverNames: params.resolverRequesterServerNames,
      requesterSenderId: params.requesterSenderId,
      agentAccountId: params.agentAccountId,
      messageChannel: params.messageChannel,
    });
    const activeNameSet = new Set([
      ...(requesterConnect?.authorizedServerNames ?? []),
      ...connectionOverrides.keys(),
    ]);
    if (activeNameSet.size === 0 && !requesterConnect) {
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
      safeServerNamesByServer: params.safeServerNamesByServer,
      includeServerNames: activeNameSet,
      requesterConnect,
      connectionOverrides,
      redactConnectionServerNames: new Set(params.resolverRequesterServerNames),
      requesterScope: params.requesterScope,
      toolOverrides: params.toolOverrides,
    });
  };

  return {
    getOrCreateRuntimeEntry,
    resolveAndInstallRequesterRuntime,
  };
}
