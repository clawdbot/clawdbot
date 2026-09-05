/** Session MCP runtime manager install path: static get-or-create + requester resolve/install. */
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import type {
  SessionMcpConfigPublication,
  SessionMcpRuntimeManagerLifecycle,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { createRequesterMcpConnect } from "./agent-bundle-mcp-requester-connect.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
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

type RuntimeEntryParams = Parameters<CreateSessionMcpRuntime>[0] & {
  configReloadAtAdmission?: SessionMcpConfigPublication;
  runtimeKey: string;
};

type RequesterRuntimeParams = RuntimeEntryParams & {
  oauthRequesterNameSet: ReadonlySet<string>;
  mcpServers: Record<string, BundleMcpServerConfig>;
  resolverRequesterServerNames: readonly string[];
  safeServerNamesByServer: ReadonlyMap<string, string>;
  fullScopedFingerprint: string;
  requesterSenderId: string;
  agentAccountId?: string | null;
  messageChannel?: string | null;
  requesterScope: SessionMcpRequesterScope;
};

const matchesRuntime = (
  runtime: SessionMcpRuntime,
  params: Pick<RuntimeEntryParams, "workspaceDir" | "agentDir">,
  fingerprint: string,
): boolean =>
  sessionMcpRuntimeOwners.get(runtime)?.isCurrent() !== false &&
  runtime.workspaceDir === params.workspaceDir &&
  runtime.agentDir === params.agentDir &&
  runtime.configFingerprint === fingerprint;

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
) {
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

  /** Install under the runtime-key queue shared by acquisition and disposal. */
  const getOrCreateRuntimeEntry = async (
    params: RuntimeEntryParams,
  ): Promise<SessionMcpRuntime> => {
    const nextFingerprint =
      params.configFingerprint ??
      loadSessionMcpConfig({ ...params, logDiagnostics: false }).fingerprint;
    const { runtimeKey, configReloadAtAdmission, ...runtimeParams } = params;
    const existing = store.runtimesBySessionId.get(runtimeKey);
    const connectionMatches =
      !params.connectionOverrides ||
      store.connectionMetaByRuntimeKey.get(runtimeKey)?.connectionHash ===
        hashMcpResolvedConnections(params.connectionOverrides);
    if (existing && connectionMatches && matchesRuntime(existing, params, nextFingerprint)) {
      reconcileReusableRetirement(params.sessionId, existing);
      existing.markUsed();
      return existing;
    }
    store.connectionMetaByRuntimeKey.delete(runtimeKey);
    let runtime =
      existing &&
      sessionMcpRuntimeOwners.get(existing)?.replace({
        ...runtimeParams,
        configFingerprint: nextFingerprint,
      });
    try {
      // Transfer ownership before cleanup yields so publication can immediately
      // revoke changed servers, including calls still using the previous facade.
      store.runtimesBySessionId.delete(runtimeKey);
      if (runtime) {
        store.runtimesBySessionId.set(runtimeKey, runtime);
      }
      await existing?.dispose();
      runtime ??= await store.createRuntime({
        ...runtimeParams,
        configFingerprint: nextFingerprint,
      });
      store.runtimesBySessionId.set(runtimeKey, runtime);
      let publication = configReloadAtAdmission;
      // Keep explicit run snapshots, but fence any publish crossed by acquisition.
      // Plugin epochs survive subsequent ordinary config publishes.
      while (store.configReload && store.configReload !== publication) {
        const next = store.configReload;
        await sessionMcpRuntimeOwners.get(runtime)?.reload({
          ...next,
          reloadPlugins: next.pluginGeneration !== (publication?.pluginGeneration ?? 0),
        });
        publication = next;
      }
      reconcileReusableRetirement(params.sessionId, runtime);
      runtime.markUsed();
      return runtime;
    } catch (error) {
      store.runtimesBySessionId.delete(runtimeKey);
      await runtime?.dispose();
      throw error;
    }
  };

  /** Install or reuse one requester runtime. Must run under its runtime-key lock. */
  const installRequesterRuntime = async (
    params: RuntimeEntryParams & {
      connectionOverrides: Map<string, McpServerConnectionResolved>;
    },
  ): Promise<SessionMcpRuntime> => {
    const { fingerprint: resolvedFingerprint } = loadSessionMcpConfig({
      ...params,
      logDiagnostics: false,
    });
    const runtimeFingerprint = requesterRuntimeFingerprint(
      resolvedFingerprint,
      params.requesterConnect,
    );
    const connectionHash = hashMcpResolvedConnections(params.connectionOverrides);
    const runtime = await getOrCreateRuntimeEntry({
      ...params,
      configFingerprint: runtimeFingerprint,
    });
    store.connectionMetaByRuntimeKey.set(params.runtimeKey, {
      connectionHash,
      resolvedAt: store.now(),
    });
    return runtime;
  };

  /**
   * Full requester section for one runtimeKey: reuse / resolve / install / revoke.
   * Always invoked under runExclusiveOnRuntimeKey.
   */
  const resolveAndInstallRequesterRuntime = async (
    params: RequesterRuntimeParams,
  ): Promise<SessionMcpRuntime | undefined> => {
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
      ...params,
      logDiagnostics: false,
      includeServerNames: expectedLiveNameSet,
      redactConnectionServerNames: new Set(params.resolverRequesterServerNames),
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
    if (withinRevalidateWindow && existing && matchesRuntime(existing, params, scopedFingerprint)) {
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
      if (store.runtimesBySessionId.has(params.runtimeKey)) {
        await lifecycle.disposeRuntimeKeyNow(params.runtimeKey);
      }
      return undefined;
    }
    return await installRequesterRuntime({
      runtimeKey: params.runtimeKey,
      configReloadAtAdmission: params.configReloadAtAdmission,
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
