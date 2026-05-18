import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { resolveUserPath } from "../utils.js";
import {
  canUseSecretsRuntimeFastPath,
  collectCandidateAgentDirs,
  createEmptyRuntimeWebToolsMetadata,
  mergeSecretsRuntimeEnv,
  resolveRefreshAgentDirs,
} from "./runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  clearSecretsRuntimeSnapshot as clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeEnv as getActiveSecretsRuntimeEnvState,
  getActiveSecretsRuntimeRefreshContext,
  getActiveSecretsRuntimeSnapshot as getActiveSecretsRuntimeSnapshotState,
  getPreparedSecretsRuntimeSnapshotRefreshContext,
  registerSecretsRuntimeStateClearHook,
  setPreparedSecretsRuntimeSnapshotRefreshContext,
  type PreparedSecretsRuntimeSnapshot,
  type SecretsRuntimeRefreshContext,
} from "./runtime-state.js";
import { getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState } from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

export type { SecretResolverWarning } from "./runtime-shared.js";
export type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

registerSecretsRuntimeStateClearHook(clearRuntimeAuthProfileStoreSnapshots);

let runtimeManifestPromise: Promise<typeof import("./runtime-manifest.runtime.js")> | null = null;
let runtimePreparePromise: Promise<typeof import("./runtime-prepare.runtime.js")> | null = null;

function loadRuntimeManifestHelpers() {
  runtimeManifestPromise ??= import("./runtime-manifest.runtime.js");
  return runtimeManifestPromise;
}

function loadRuntimePrepareHelpers() {
  runtimePreparePromise ??= import("./runtime-prepare.runtime.js");
  return runtimePreparePromise;
}

async function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ReadonlyMap<string, PluginOrigin>> {
  const workspaceDir = resolveAgentWorkspaceDir(
    params.config,
    resolveDefaultAgentId(params.config),
  );
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot = loadPluginMetadataSnapshot({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  return listPluginOriginsFromMetadataSnapshot(snapshot);
}

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    !!entries &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    !!channels &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const fastPathLoadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
  const candidateDirs = params.agentDirs?.length
    ? [...new Set(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))]
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
  if (includeAuthStoreRefs) {
    for (const agentDir of candidateDirs) {
      authStores.push({
        agentDir,
        store: structuredClone(fastPathLoadAuthStore(agentDir)),
      });
    }
  }
  if (canUseSecretsRuntimeFastPath({ sourceConfig, authStores })) {
    const snapshot = {
      sourceConfig,
      config: resolvedConfig,
      authStores,
      warnings: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
      env: runtimeEnv,
      explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
      loadAuthStore: fastPathLoadAuthStore,
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
    });
    return snapshot;
  }

  const {
    applyResolvedAssignments,
    collectAuthStoreAssignments,
    collectConfigAssignments,
    createResolverContext,
    resolveRuntimeWebTools,
    resolveSecretRefValues,
  } = await loadRuntimePrepareHelpers();
  const loadablePluginOrigins =
    params.loadablePluginOrigins ??
    (hasConfiguredPluginEntries(sourceConfig) || hasConfiguredChannelEntries(sourceConfig)
      ? await resolveLoadablePluginOrigins({ config: sourceConfig, env: runtimeEnv })
      : new Map<string, PluginOrigin>());
  const context = createResolverContext({
    sourceConfig,
    env: runtimeEnv,
  });

  collectConfigAssignments({
    config: resolvedConfig,
    context,
    loadablePluginOrigins,
  });

  if (includeAuthStoreRefs) {
    const loadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime;
    if (!params.loadAuthStore) {
      authStores = candidateDirs.map((agentDir) => ({
        agentDir,
        store: structuredClone(loadAuthStore(agentDir)),
      }));
    }
    for (const entry of authStores) {
      collectAuthStoreAssignments({
        store: entry.store,
        context,
        agentDir: entry.agentDir,
      });
    }
  }

  if (context.assignments.length > 0) {
    const refs = context.assignments.map((assignment) => assignment.ref);
    const resolved = await resolveSecretRefValues(refs, {
      config: sourceConfig,
      env: context.env,
      cache: context.cache,
    });
    applyResolvedAssignments({
      assignments: context.assignments,
      resolved,
    });
  }

  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    warnings: context.warnings,
    webTools: await resolveRuntimeWebTools({
      sourceConfig,
      resolvedConfig,
      context,
    }),
  };
  setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
    env: runtimeEnv,
    explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
    loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
    loadablePluginOrigins,
  });
  return snapshot;
}

export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  const refreshContext =
    getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot) ??
    getActiveSecretsRuntimeRefreshContext() ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
      loadablePluginOrigins: new Map<string, PluginOrigin>(),
    } satisfies SecretsRuntimeRefreshContext);
  activateSecretsRuntimeSnapshotState({
    snapshot,
    refreshContext,
    refreshHandler: {
      refresh: async ({ sourceConfig }) => {
        const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
        if (!getActiveSecretsRuntimeSnapshotState() || !activeRefreshContext) {
          return false;
        }
        const refreshed = await prepareSecretsRuntimeSnapshot({
          config: sourceConfig,
          env: activeRefreshContext.env,
          agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
          loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
          ...(activeRefreshContext.loadAuthStore
            ? { loadAuthStore: activeRefreshContext.loadAuthStore }
            : {}),
        });
        activateSecretsRuntimeSnapshot(refreshed);
        return true;
      },
    },
  });
}

export async function refreshActiveSecretsRuntimeSnapshot(): Promise<boolean> {
  const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
  const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
  if (!activeSnapshot || !activeRefreshContext) {
    return false;
  }
  const refreshed = await prepareSecretsRuntimeSnapshot({
    config: activeSnapshot.sourceConfig,
    env: activeRefreshContext.env,
    agentDirs: resolveRefreshAgentDirs(activeSnapshot.sourceConfig, activeRefreshContext),
    loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
    ...(activeRefreshContext.loadAuthStore
      ? { loadAuthStore: activeRefreshContext.loadAuthStore }
      : {}),
  });
  activateSecretsRuntimeSnapshot(refreshed);
  return true;
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  return getActiveSecretsRuntimeSnapshotState();
}

export function getActiveSecretsRuntimeEnv(): NodeJS.ProcessEnv {
  return getActiveSecretsRuntimeEnvState();
}

export function getActiveRuntimeWebToolsMetadata(): RuntimeWebToolsMetadata | null {
  return getActiveRuntimeWebToolsMetadataFromState();
}

export function clearSecretsRuntimeSnapshot(): void {
  clearSecretsRuntimeSnapshotState();
}
