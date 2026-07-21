/** Prepares secrets runtime snapshots from config, auth stores, plugins, and env. */
import { isDeepStrictEqual } from "node:util";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentWorkspaceDirForConfigInspection } from "../agents/agent-scope-config.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "../agents/auth-profiles.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshotMetadata,
  getRuntimeConfigSnapshot,
  type RuntimeConfigSnapshotRefreshParams,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { resolveAuthProfileSecretOwnerId } from "./runtime-auth-profile-owner.js";
import {
  canUseSecretsRuntimeFastPath,
  collectCandidateAgentDirs,
  createEmptyRuntimeWebToolsMetadata,
  mergeSecretsRuntimeEnv,
  resolveRefreshAgentDirs,
} from "./runtime-fast-path.js";
import {
  activateProviderAuthRuntimeSnapshot,
  clearProviderAuthRuntimeSnapshotActivation,
} from "./runtime-provider-auth-activation.js";
import { mergeProviderAuthRuntimeWarnings } from "./runtime-provider-auth-warnings.js";
import {
  activateSecretsRuntimeSnapshotState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
  clearSecretsRuntimeSnapshot as clearSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeEnv as getActiveSecretsRuntimeEnvState,
  getActiveSecretsRuntimeRefreshContext,
  getActiveSecretsRuntimeSnapshot as getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevision as getActiveSecretsRuntimeSnapshotRevisionState,
  getLiveSecretsRuntimeAuthStores,
  getPreparedSecretsRuntimeSnapshotRefreshContext,
  registerSecretsRuntimeStateClearHook,
  restoreSecretsRuntimeSnapshotStateIfCurrent,
  setPreparedSecretsRuntimeSnapshotRefreshContext,
  type PreparedSecretsRuntimeSnapshot,
  type SecretsRuntimeRefreshContext,
} from "./runtime-state.js";
import { getActiveRuntimeWebToolsMetadata as getActiveRuntimeWebToolsMetadataFromState } from "./runtime-web-tools-state.js";
import type { RuntimeWebToolsMetadata } from "./runtime-web-tools.types.js";

export type { SecretResolverWarning } from "./runtime-shared.js";
export type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

registerSecretsRuntimeStateClearHook(clearRuntimeAuthProfileStoreSnapshots);
registerSecretsRuntimeStateClearHook(clearProviderAuthRuntimeSnapshotActivation);

const loadRuntimeManifestHelpers = createLazyRuntimeModule(
  () => import("./runtime-manifest.runtime.js"),
);

const loadRuntimePrepareHelpers = createLazyRuntimeModule(
  () => import("./runtime-prepare.runtime.js"),
);

const loadRuntimeOwnerAssignmentHelpers = createLazyRuntimeModule(
  () => import("./runtime-owner-assignments.js"),
);

async function resolveLoadablePluginOrigins(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins">;
}): Promise<ReadonlyMap<string, PluginOrigin>> {
  const workspaceDir = resolveAgentWorkspaceDirForConfigInspection(params.config, params.env);
  const { listPluginOriginsFromMetadataSnapshot, loadPluginMetadataSnapshot } =
    await loadRuntimeManifestHelpers();
  const snapshot =
    params.pluginMetadataSnapshot ??
    loadPluginMetadataSnapshot({
      config: params.config,
      workspaceDir,
      env: params.env,
    });
  return listPluginOriginsFromMetadataSnapshot(snapshot);
}

function hasConfiguredPluginEntries(config: OpenClawConfig): boolean {
  const entries = config.plugins?.entries;
  return (
    Boolean(entries) &&
    typeof entries === "object" &&
    !Array.isArray(entries) &&
    Object.keys(entries).length > 0
  );
}

function hasConfiguredChannelEntries(config: OpenClawConfig): boolean {
  const channels = config.channels;
  return (
    Boolean(channels) &&
    typeof channels === "object" &&
    !Array.isArray(channels) &&
    Object.keys(channels).some((channelId) => channelId !== "defaults")
  );
}

function hasConfiguredPluginIntegrationSecretProviders(config: OpenClawConfig): boolean {
  const providers = config.secrets?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return false;
  }
  return Object.values(providers).some(
    (provider) =>
      provider?.source === "exec" &&
      "pluginIntegration" in provider &&
      provider.pluginIntegration !== undefined,
  );
}

function shouldLoadPluginMetadataForSecrets(config: OpenClawConfig): boolean {
  return (
    hasConfiguredPluginEntries(config) ||
    hasConfiguredChannelEntries(config) ||
    hasConfiguredPluginIntegrationSecretProviders(config)
  );
}

/** Prepares a secrets runtime snapshot and records refresh context for later activation. */
export async function prepareSecretsRuntimeSnapshot(params: {
  config: OpenClawConfig;
  /** Optional assignment projection; resolver/plugin policy still uses the full config. */
  assignmentConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: string[];
  /** Skip config and web-tool refs when only auth-profile stores need materialization. */
  includeConfigRefs?: boolean;
  includeAuthStoreRefs?: boolean;
  loadAuthStore?: (agentDir?: string) => AuthProfileStore;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "plugins" | "manifestRegistry">;
  /** Isolate known non-Gateway owners and retain unchanged last-known-good values when possible. */
  allowUnavailableSecretOwners?: boolean;
  /** Test override for discovered loadable plugins and their origins. */
  loadablePluginOrigins?: ReadonlyMap<string, PluginOrigin>;
}): Promise<PreparedSecretsRuntimeSnapshot> {
  const runtimeEnv = mergeSecretsRuntimeEnv(params.env);
  const authStoreCredentialsRevision = getRuntimeAuthProfileStoreCredentialsRevision();
  const sourceConfig = structuredClone(params.config);
  const assignmentSourceConfig = structuredClone(params.assignmentConfig ?? params.config);
  const resolvedConfig = structuredClone(assignmentSourceConfig);
  const includeConfigRefs = params.includeConfigRefs ?? true;
  const includeAuthStoreRefs = params.includeAuthStoreRefs ?? true;
  let authStores: Array<{ agentDir: string; store: AuthProfileStore }> = [];
  const fastPathLoadAuthStore = params.loadAuthStore ?? loadAuthProfileStoreWithoutExternalProfiles;
  const candidateDirs = params.agentDirs?.length
    ? uniqueStrings(params.agentDirs.map((entry) => resolveUserPath(entry, runtimeEnv)))
    : collectCandidateAgentDirs(resolvedConfig, runtimeEnv);
  if (includeAuthStoreRefs) {
    for (const agentDir of candidateDirs) {
      authStores.push({
        agentDir,
        store: structuredClone(fastPathLoadAuthStore(agentDir)),
      });
    }
  }
  if (
    canUseSecretsRuntimeFastPath({
      sourceConfig: includeConfigRefs ? assignmentSourceConfig : {},
      authStores,
    })
  ) {
    const manifestRegistry =
      params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
    const snapshot = {
      sourceConfig,
      config: resolvedConfig,
      authStores,
      authStoreCredentialsRevision,
      warnings: [],
      degradedOwners: [],
      secretOwners: [],
      webTools: createEmptyRuntimeWebToolsMetadata(),
    };
    setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
      env: runtimeEnv,
      explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
      includeConfigRefs,
      includeAuthStoreRefs,
      loadAuthStore: fastPathLoadAuthStore,
      loadablePluginOrigins: params.loadablePluginOrigins ?? new Map<string, PluginOrigin>(),
      ...(manifestRegistry ? { manifestRegistry } : {}),
    });
    return snapshot;
  }

  const {
    collectAuthStoreAssignments,
    collectConfigAssignments,
    createResolverContext,
    resolveRuntimeWebTools,
  } = await loadRuntimePrepareHelpers();
  const { listSecretAssignmentOwners, resolveAndApplySecretAssignments } =
    await loadRuntimeOwnerAssignmentHelpers();
  const manifestRegistry =
    params.manifestRegistry ?? params.pluginMetadataSnapshot?.manifestRegistry;
  const loadablePluginOrigins =
    params.loadablePluginOrigins ??
    (shouldLoadPluginMetadataForSecrets(sourceConfig)
      ? await resolveLoadablePluginOrigins({
          config: sourceConfig,
          env: runtimeEnv,
          pluginMetadataSnapshot:
            params.pluginMetadataSnapshot ??
            (manifestRegistry ? { plugins: manifestRegistry.plugins } : undefined),
        })
      : new Map<string, PluginOrigin>());
  const context = createResolverContext({
    sourceConfig,
    env: runtimeEnv,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });

  if (includeConfigRefs) {
    collectConfigAssignments({
      config: resolvedConfig,
      context,
      loadablePluginOrigins,
    });
  }

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

  const assignmentResolution =
    context.assignments.length > 0
      ? await resolveAndApplySecretAssignments({
          assignments: context.assignments,
          context,
          allowOwnerIsolation: params.allowUnavailableSecretOwners,
          options: {
            config: sourceConfig,
            env: context.env,
            cache: context.cache,
            manifestRegistry: context.manifestRegistry,
          },
        })
      : { degradedOwners: [], resolvedValues: new Map<string, unknown>() };
  const assignmentSecretOwners = listSecretAssignmentOwners(
    context.assignments,
    assignmentResolution.resolvedValues,
  );

  const webTools = includeConfigRefs
    ? await resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
        allowUnavailableSecretOwners: params.allowUnavailableSecretOwners,
      })
    : {
        metadata: createEmptyRuntimeWebToolsMetadata(),
        degradedOwners: [],
        secretOwners: [],
      };
  const snapshot = {
    sourceConfig,
    config: resolvedConfig,
    authStores,
    authStoreCredentialsRevision,
    warnings: context.warnings,
    degradedOwners: [...assignmentResolution.degradedOwners, ...webTools.degradedOwners],
    secretOwners: [...assignmentSecretOwners, ...webTools.secretOwners],
    webTools: webTools.metadata,
  };
  setPreparedSecretsRuntimeSnapshotRefreshContext(snapshot, {
    env: runtimeEnv,
    explicitAgentDirs: params.agentDirs?.length ? [...candidateDirs] : null,
    includeConfigRefs,
    includeAuthStoreRefs,
    loadAuthStore: params.loadAuthStore ?? loadAuthProfileStoreForSecretsRuntime,
    loadablePluginOrigins,
    ...(manifestRegistry ? { manifestRegistry } : {}),
  });
  return snapshot;
}

/** Activates a prepared secrets runtime snapshot for fast runtime lookup. */
export function activateSecretsRuntimeSnapshot(snapshot: PreparedSecretsRuntimeSnapshot): void {
  activateSecretsRuntimeSnapshotState(createSecretsRuntimeSnapshotActivation(snapshot));
}

/** Activates resolved runtime bytes while retaining the distinct raw config source. */
export function activateSecretsRuntimeSnapshotWithSource(
  snapshot: PreparedSecretsRuntimeSnapshot,
  runtimeSourceConfig: OpenClawConfig,
): void {
  activateSecretsRuntimeSnapshotState({
    ...createSecretsRuntimeSnapshotActivation(snapshot),
    runtimeSourceConfig,
  });
}

/** Compare-and-activate boundary for snapshots prepared from process-wide runtime state. */
export function activateSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  options?: { preserveActivationLineage?: boolean; runtimeSourceConfig?: OpenClawConfig },
): boolean {
  return activateSecretsRuntimeSnapshotStateIfCurrent({
    ...createSecretsRuntimeSnapshotActivation(snapshot),
    expectedRevision,
    preserveActivationLineage: options?.preserveActivationLineage,
    runtimeSourceConfig: options?.runtimeSourceConfig,
  });
}

/** Restores an owned predecessor while retaining changes after candidate preparation. */
export function restoreSecretsRuntimeSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  options?: { runtimeSourceConfig?: OpenClawConfig },
): boolean {
  return restoreSecretsRuntimeSnapshotStateIfCurrent({
    ...createSecretsRuntimeSnapshotActivation(snapshot),
    expectedRevision,
    ownedSnapshot,
    runtimeSourceConfig: options?.runtimeSourceConfig,
  });
}

type PreparedSecretsRuntimeRefresh = {
  snapshot: PreparedSecretsRuntimeSnapshot;
  expectedRevision: number;
};

function coercePreflightRefresh(
  value: unknown,
  sourceConfig: OpenClawConfig,
): PreparedSecretsRuntimeRefresh | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<PreparedSecretsRuntimeRefresh>;
  return candidate.snapshot &&
    typeof candidate.expectedRevision === "number" &&
    isDeepStrictEqual(candidate.snapshot.sourceConfig, sourceConfig)
    ? (candidate as PreparedSecretsRuntimeRefresh)
    : null;
}

async function prepareActiveSecretsRuntimeRefresh(
  sourceConfig: OpenClawConfig,
  includeAuthStoreRefs?: boolean,
  snapshotConfig: OpenClawConfig = sourceConfig,
): Promise<PreparedSecretsRuntimeRefresh | null> {
  const expectedRevision = getActiveSecretsRuntimeSnapshotRevisionState();
  const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
  const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
  if (!activeSnapshot || !activeRefreshContext) {
    return null;
  }
  return {
    snapshot: await prepareSecretsRuntimeSnapshot({
      config: sourceConfig,
      assignmentConfig: snapshotConfig,
      env: activeRefreshContext.env,
      agentDirs: resolveRefreshAgentDirs(sourceConfig, activeRefreshContext),
      includeConfigRefs: activeRefreshContext.includeConfigRefs ?? true,
      includeAuthStoreRefs: includeAuthStoreRefs ?? activeRefreshContext.includeAuthStoreRefs,
      loadablePluginOrigins: activeRefreshContext.loadablePluginOrigins,
      ...(activeRefreshContext.manifestRegistry
        ? { manifestRegistry: activeRefreshContext.manifestRegistry }
        : {}),
      ...(activeRefreshContext.loadAuthStore
        ? { loadAuthStore: activeRefreshContext.loadAuthStore }
        : {}),
      allowUnavailableSecretOwners: true,
    }),
    expectedRevision,
  };
}

/** Prepares a config-write refresh candidate tied to the current runtime revision. */
export async function preflightActiveSecretsRuntimeSnapshotRefresh(
  params: RuntimeConfigSnapshotRefreshParams,
): Promise<unknown> {
  return await prepareActiveSecretsRuntimeRefresh(params.sourceConfig, params.includeAuthStoreRefs);
}

/** Publishes a config-write refresh after retrying any candidate invalidated while preparing. */
export async function refreshActiveSecretsRuntimeSnapshotForConfig(
  params: RuntimeConfigSnapshotRefreshParams,
): Promise<boolean> {
  let candidate = coercePreflightRefresh(params.preflightResult, params.sourceConfig);
  for (;;) {
    candidate ??= await prepareActiveSecretsRuntimeRefresh(
      params.sourceConfig,
      params.includeAuthStoreRefs,
    );
    if (!candidate) {
      return false;
    }
    const activeRefreshContext = getActiveSecretsRuntimeRefreshContext();
    if (!activeRefreshContext) {
      return false;
    }
    const oneShotSkipAuthStoreRefs =
      params.includeAuthStoreRefs === false && activeRefreshContext.includeAuthStoreRefs;
    if (oneShotSkipAuthStoreRefs) {
      candidate.snapshot.authStores = getLiveSecretsRuntimeAuthStores();
      candidate.snapshot.authStoreCredentialsRevision =
        getRuntimeAuthProfileStoreCredentialsRevision();
      setPreparedSecretsRuntimeSnapshotRefreshContext(candidate.snapshot, activeRefreshContext);
    }
    if (activateSecretsRuntimeSnapshotIfCurrent(candidate.snapshot, candidate.expectedRevision)) {
      return true;
    }
    candidate = null;
  }
}

type ResolvedSecretRefPatch =
  | { changed: false; value: unknown }
  | { changed: true; value: unknown };

function patchResolvedSecretRefLeaves(params: {
  current: unknown;
  source: unknown;
  resolved: unknown;
  defaults: NonNullable<OpenClawConfig["secrets"]>["defaults"];
}): ResolvedSecretRefPatch {
  if (coerceSecretRef(params.source, params.defaults)) {
    return isDeepStrictEqual(params.source, params.resolved)
      ? { changed: false, value: params.current }
      : { changed: true, value: params.resolved };
  }
  if (Array.isArray(params.source) && Array.isArray(params.resolved)) {
    const next = Array.isArray(params.current)
      ? [...params.current]
      : structuredClone(params.resolved);
    let changed = false;
    for (const [index, source] of params.source.entries()) {
      const patch = patchResolvedSecretRefLeaves({
        current: next[index],
        source,
        resolved: params.resolved[index],
        defaults: params.defaults,
      });
      if (patch.changed) {
        next[index] = patch.value;
        changed = true;
      }
    }
    return { changed, value: changed ? next : params.current };
  }
  if (isRecord(params.source) && isRecord(params.resolved)) {
    const next = isRecord(params.current)
      ? { ...params.current }
      : structuredClone(params.resolved);
    let changed = false;
    for (const [key, source] of Object.entries(params.source)) {
      const patch = patchResolvedSecretRefLeaves({
        current: next[key],
        source,
        resolved: params.resolved[key],
        defaults: params.defaults,
      });
      if (patch.changed) {
        next[key] = patch.value;
        changed = true;
      }
    }
    return { changed, value: changed ? next : params.current };
  }
  return { changed: false, value: params.current };
}

function selectProviderAuthConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...(config.secrets === undefined ? {} : { secrets: config.secrets }),
    ...(config.models === undefined ? {} : { models: config.models }),
  };
}

function listAuthProfileSecretOwnerIds(
  authStores: PreparedSecretsRuntimeSnapshot["authStores"],
): Set<string> {
  return new Set(
    authStores.flatMap(({ agentDir, store }) =>
      Object.keys(store.profiles).map((profileId) =>
        resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
      ),
    ),
  );
}

function mergeProviderAuthSecretOwners(
  active: PreparedSecretsRuntimeSnapshot,
  candidate: PreparedSecretsRuntimeSnapshot,
): PreparedSecretsRuntimeSnapshot["secretOwners"] {
  const activeAuthProfileOwnerIds = listAuthProfileSecretOwnerIds(active.authStores);
  const candidateAuthProfileOwnerIds = listAuthProfileSecretOwnerIds(candidate.authStores);
  const isActiveProviderAuthOwner = (owner: NonNullable<typeof active.secretOwners>[number]) =>
    owner.ownerKind === "provider" ||
    (owner.ownerKind === "account" && activeAuthProfileOwnerIds.has(owner.ownerId));
  const isCandidateProviderAuthOwner = (
    owner: NonNullable<typeof candidate.secretOwners>[number],
  ) =>
    owner.ownerKind === "provider" ||
    (owner.ownerKind === "account" && candidateAuthProfileOwnerIds.has(owner.ownerId));
  // This refresh publishes provider and account state only. Keep transport-owned refs pinned
  // to their active snapshot so later failures compare against the values actually in use.
  return [
    ...(active.secretOwners ?? []).filter((owner) => !isActiveProviderAuthOwner(owner)),
    ...(candidate.secretOwners ?? []).filter(isCandidateProviderAuthOwner),
  ];
}

function mergeProviderAuthDegradedOwners(
  active: PreparedSecretsRuntimeSnapshot,
  candidate: PreparedSecretsRuntimeSnapshot,
): PreparedSecretsRuntimeSnapshot["degradedOwners"] {
  const activeAuthProfileOwnerIds = listAuthProfileSecretOwnerIds(active.authStores);
  const candidateAuthProfileOwnerIds = listAuthProfileSecretOwnerIds(candidate.authStores);
  const isProviderAuthOwner = (owner: NonNullable<typeof active.degradedOwners>[number]) =>
    owner.ownerKind === "provider" ||
    (owner.ownerKind === "account" && activeAuthProfileOwnerIds.has(owner.ownerId));
  return [
    ...(active.degradedOwners ?? []).filter((owner) => !isProviderAuthOwner(owner)),
    ...(candidate.degradedOwners ?? []).filter(
      (owner) =>
        owner.ownerKind === "provider" ||
        (owner.ownerKind === "account" && candidateAuthProfileOwnerIds.has(owner.ownerId)),
    ),
  ];
}

function createSecretsRuntimeSnapshotActivation(snapshot: PreparedSecretsRuntimeSnapshot) {
  const refreshContext =
    getPreparedSecretsRuntimeSnapshotRefreshContext(snapshot) ??
    getActiveSecretsRuntimeRefreshContext() ??
    ({
      env: { ...process.env } as Record<string, string | undefined>,
      explicitAgentDirs: null,
      includeAuthStoreRefs: snapshot.authStores.length > 0,
      loadAuthStore: loadAuthProfileStoreForSecretsRuntime,
      loadablePluginOrigins: new Map<string, PluginOrigin>(),
    } satisfies SecretsRuntimeRefreshContext);

  return {
    snapshot,
    refreshContext,
    refreshHandler: {
      preflight: preflightActiveSecretsRuntimeSnapshotRefresh,
      refresh: refreshActiveSecretsRuntimeSnapshotForConfig,
    },
  };
}

/** Refresh provider credentials without republishing transport-owned config. */
export async function refreshActiveProviderAuthRuntimeSnapshot(): Promise<boolean> {
  for (;;) {
    const activeSnapshot = getActiveSecretsRuntimeSnapshotState();
    if (!activeSnapshot) {
      return false;
    }
    const providerAuthConfig = selectProviderAuthConfig(activeSnapshot.sourceConfig);
    const candidate = await prepareActiveSecretsRuntimeRefresh(
      activeSnapshot.sourceConfig,
      undefined,
      providerAuthConfig,
    );
    if (!candidate) {
      return false;
    }
    const runtimeConfig = getRuntimeConfigSnapshot();
    const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
    const runtimeMetadata = getRuntimeConfigSnapshotMetadata();
    if (!runtimeConfig || !runtimeSourceConfig || !runtimeMetadata) {
      return false;
    }
    const config = { ...runtimeConfig };
    const modelsPatch = patchResolvedSecretRefLeaves({
      current: runtimeConfig.models,
      source: providerAuthConfig.models,
      resolved: candidate.snapshot.config.models,
      defaults: activeSnapshot.sourceConfig.secrets?.defaults,
    });
    if (modelsPatch.changed) {
      config.models = modelsPatch.value as OpenClawConfig["models"];
    }
    const refreshedSnapshot: PreparedSecretsRuntimeSnapshot = {
      ...activeSnapshot,
      config,
      authStores: candidate.snapshot.authStores,
      authStoreCredentialsRevision: candidate.snapshot.authStoreCredentialsRevision,
      warnings: mergeProviderAuthRuntimeWarnings(
        activeSnapshot.warnings,
        candidate.snapshot.warnings,
      ),
      degradedOwners: mergeProviderAuthDegradedOwners(activeSnapshot, candidate.snapshot),
      secretOwners: mergeProviderAuthSecretOwners(activeSnapshot, candidate.snapshot),
    };
    // The revision check and activation are synchronous. A queued auth refresh must retry
    // against gateway runtime mutations that landed after its pinned config read.
    const activateSnapshotIfCurrent = () => {
      if (getRuntimeConfigSnapshotMetadata()?.revision !== runtimeMetadata.revision) {
        return false;
      }
      return activateSecretsRuntimeSnapshotIfCurrent(
        refreshedSnapshot,
        candidate.expectedRevision,
        {
          preserveActivationLineage: true,
          runtimeSourceConfig,
        },
      );
    };
    const activated = await activateProviderAuthRuntimeSnapshot({
      snapshot: refreshedSnapshot,
      expectedRevision: candidate.expectedRevision,
      activateSnapshotIfCurrent,
    });
    if (activated) {
      return true;
    }
  }
}

export function getActiveSecretsRuntimeSnapshot(): PreparedSecretsRuntimeSnapshot | null {
  return getActiveSecretsRuntimeSnapshotState();
}

export function getActiveSecretsRuntimeSnapshotRevision(): number {
  return getActiveSecretsRuntimeSnapshotRevisionState();
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
