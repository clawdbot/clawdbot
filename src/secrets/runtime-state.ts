/** Holds active secrets runtime snapshots, refresh context, and cleanup hooks. */
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  type RuntimeConfigSnapshotRefreshHandler,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { SecretResolverWarning } from "./runtime-shared.js";
import {
  clearActiveRuntimeWebToolsMetadata,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

/** Prepared secrets runtime snapshot activated for fast secret resolution. */
export type PreparedSecretsRuntimeSnapshot = {
  sourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  authStores: Array<{ agentDir: string; store: AuthProfileStore }>;
  warnings: SecretResolverWarning[];
  webTools: RuntimeWebToolsMetadata;
};

/** Context needed to refresh active secrets runtime snapshots without losing plugin origin data. */
export type SecretsRuntimeRefreshContext = {
  env: Record<string, string | undefined>;
  explicitAgentDirs: string[] | null;
  includeAuthStoreRefs: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  loadablePluginOrigins: ReadonlyMap<string, PluginOrigin>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
};

let activeSnapshot: PreparedSecretsRuntimeSnapshot | null = null;
let activeRefreshContext: SecretsRuntimeRefreshContext | null = null;
const clearHooks = new Set<() => void>();
const preparedSnapshotRefreshContext = new WeakMap<
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext
>();

/**
 * Clones refresh context while preserving callback identity and isolating mutable maps/config.
 */
export function cloneSecretsRuntimeRefreshContext(
  context: SecretsRuntimeRefreshContext,
): SecretsRuntimeRefreshContext {
  const cloned: SecretsRuntimeRefreshContext = {
    env: { ...context.env },
    explicitAgentDirs: context.explicitAgentDirs ? [...context.explicitAgentDirs] : null,
    includeAuthStoreRefs: context.includeAuthStoreRefs,
    loadablePluginOrigins: new Map(context.loadablePluginOrigins),
    ...(context.manifestRegistry
      ? { manifestRegistry: structuredClone(context.manifestRegistry) }
      : {}),
  };
  if (context.loadAuthStore) {
    cloned.loadAuthStore = context.loadAuthStore;
  }
  return cloned;
}

function cloneSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): PreparedSecretsRuntimeSnapshot {
  return {
    sourceConfig: structuredClone(snapshot.sourceConfig),
    config: structuredClone(snapshot.config),
    authStores: snapshot.authStores.map((entry) => ({
      agentDir: entry.agentDir,
      store: structuredClone(entry.store),
    })),
    warnings: snapshot.warnings.map((warning) => ({ ...warning })),
    webTools: structuredClone(snapshot.webTools),
  };
}

/**
 * Associates a prepared snapshot with the refresh context needed after activation.
 */
export function setPreparedSecretsRuntimeSnapshotRefreshContext(
  snapshot: PreparedSecretsRuntimeSnapshot,
  context: SecretsRuntimeRefreshContext,
): void {
  preparedSnapshotRefreshContext.set(snapshot, cloneSecretsRuntimeRefreshContext(context));
}

/**
 * Returns the refresh context stored for a prepared snapshot, if any.
 */
export function getPreparedSecretsRuntimeSnapshotRefreshContext(
  snapshot: PreparedSecretsRuntimeSnapshot,
): SecretsRuntimeRefreshContext | null {
  const context = preparedSnapshotRefreshContext.get(snapshot);
  return context ? cloneSecretsRuntimeRefreshContext(context) : null;
}

/**
 * Returns the active refresh context without exposing mutable runtime state.
 */
export function getActiveSecretsRuntimeRefreshContext(): SecretsRuntimeRefreshContext | null {
  return activeRefreshContext ? cloneSecretsRuntimeRefreshContext(activeRefreshContext) : null;
}

/**
 * Returns the env used by the active runtime snapshot, falling back to process env.
 */
export function getActiveSecretsRuntimeEnv(): NodeJS.ProcessEnv {
  return {
    ...(activeRefreshContext?.env ?? process.env),
  } as NodeJS.ProcessEnv;
}

/**
 * Registers cleanup hooks that run whenever the active secrets runtime snapshot is cleared.
 */
export function registerSecretsRuntimeStateClearHook(clearHook: () => void): void {
  clearHooks.add(clearHook);
}

/**
 * Atomically activates a prepared secrets snapshot across config, auth-store, and web-tool state.
 */
export function activateSecretsRuntimeSnapshotState(params: {
  snapshot: PreparedSecretsRuntimeSnapshot;
  refreshContext: SecretsRuntimeRefreshContext | null;
  refreshHandler: RuntimeConfigSnapshotRefreshHandler | null;
}): void {
  const next = cloneSnapshot(params.snapshot);
  const nextRefreshContext = params.refreshContext
    ? cloneSecretsRuntimeRefreshContext(params.refreshContext)
    : null;
  setRuntimeConfigSnapshot(next.config, next.sourceConfig);
  replaceRuntimeAuthProfileStoreSnapshots(next.authStores);
  activeSnapshot = next;
  activeRefreshContext = nextRefreshContext;
  if (nextRefreshContext) {
    preparedSnapshotRefreshContext.set(next, cloneSecretsRuntimeRefreshContext(nextRefreshContext));
  }
  setActiveRuntimeWebToolsMetadata(next.webTools);
  setRuntimeConfigSnapshotRefreshHandler(params.refreshHandler);
}

/**
 * Returns a cloned active secrets runtime snapshot for callers that need mutable data.
 */
export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  if (!activeSnapshot) {
    return null;
  }
  const snapshot = cloneSnapshot(activeSnapshot);
  if (activeRefreshContext) {
    preparedSnapshotRefreshContext.set(
      snapshot,
      cloneSecretsRuntimeRefreshContext(activeRefreshContext),
    );
  }
  return snapshot;
}

// Hot-path readers only need the config pair for availability decisions.
// Return the active references and keep full snapshot clone isolation on
// getActiveSecretsRuntimeSnapshot() for callers that need mutable data.
export function getActiveSecretsRuntimeConfigSnapshot(): Pick<
  PreparedSecretsRuntimeSnapshot,
  "config" | "sourceConfig"
> | null {
  if (!activeSnapshot) {
    return null;
  }
  return {
    config: activeSnapshot.config,
    sourceConfig: activeSnapshot.sourceConfig,
  };
}

/**
 * Returns current auth stores, preferring live auth-store snapshots over activation-time clones.
 */
export function getLiveSecretsRuntimeAuthStores(): PreparedSecretsRuntimeSnapshot["authStores"] {
  if (!activeSnapshot) {
    return [];
  }
  return activeSnapshot.authStores.map((entry) => ({
    agentDir: entry.agentDir,
    store: getRuntimeAuthProfileStoreSnapshot(entry.agentDir) ?? structuredClone(entry.store),
  }));
}

/**
 * Clears active secrets runtime state and all linked config/auth/web-tool snapshots.
 */
export function clearSecretsRuntimeSnapshot(): void {
  activeSnapshot = null;
  activeRefreshContext = null;
  clearActiveRuntimeWebToolsMetadata();
  setRuntimeConfigSnapshotRefreshHandler(null);
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  for (const clearHook of clearHooks) {
    clearHook();
  }
}
