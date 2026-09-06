/** Tracks the current plugin metadata snapshot for control-plane lookups. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  currentPluginMetadataConfigIdentityCache,
  getGatewayPluginMetadataSnapshot,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
  type CurrentPluginMetadataSnapshotRevision,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  adoptProcessPluginCache,
  getPluginMetadataSnapshotCache,
  getProcessPluginCache,
  getScopedPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import {
  resolvePluginControlPlaneFingerprint,
  type ResolvePluginControlPlaneContextParams,
} from "./plugin-control-plane-context.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-env.js";
import { registerPluginMetadataSnapshotReaders } from "./plugin-metadata-snapshot-readers.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
} from "./plugin-metadata-snapshot.types.js";
import { normalizePluginIdScope, serializePluginIdScope } from "./plugin-scope.js";

type CurrentPluginMetadataSnapshotState = ReturnType<
  typeof getCurrentPluginMetadataSnapshotState
> & {
  configIdentities: WeakSet<OpenClawConfig>;
};

type CurrentPluginMetadataSnapshotOptions = {
  config?: OpenClawConfig;
  compatibleConfigs?: readonly OpenClawConfig[];
  env?: NodeJS.ProcessEnv;
  /** Only immutable runtime generations may trust identity across policy drift. */
  trustConfigIdentity?: boolean;
  workspaceDir?: string;
};

type TemporaryPluginMetadataSnapshotLeaseState = {
  parent: TemporaryPluginMetadataSnapshotLeaseState | undefined;
  previousState: CurrentPluginMetadataSnapshotState;
  revision: CurrentPluginMetadataSnapshotRevision;
  released: boolean;
};

type TemporaryPluginMetadataSnapshotLease = {
  release: () => boolean;
};

type CurrentPluginMetadataSnapshotParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  allowScopedSnapshot?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  workspaceDir?: string;
  allowWorkspaceScopedSnapshot?: boolean;
  requireDefaultDiscoveryContext?: boolean;
};

type PluginMetadataSnapshotCandidate = {
  snapshot: PluginMetadataSnapshot | undefined;
  configFingerprint: string | undefined;
  envFingerprint?: string;
  defaultDiscoveryCompatible?: boolean;
  compatiblePolicyHashes?: readonly string[];
  compatibleConfigFingerprints?: readonly string[];
  hasConfigIdentity?: (config: OpenClawConfig) => boolean;
  immutableRuntimeGeneration?: boolean;
};

type ScopedPluginMetadataSnapshot = PluginMetadataSnapshotCandidate & {
  parent?: ScopedPluginMetadataSnapshot;
};

export type PluginMetadataSnapshotScopeRunner = <T>(
  params: {
    config: OpenClawConfig;
    workspaceDir?: string;
  },
  run: () => T,
) => T;

let activeTemporaryPluginMetadataSnapshotLease:
  | TemporaryPluginMetadataSnapshotLeaseState
  | undefined;

const SCOPED_PLUGIN_METADATA_SNAPSHOT_KEY = Symbol.for("openclaw.scopedPluginMetadataSnapshot");
const scopedPluginMetadataSnapshot = resolveGlobalSingleton<
  AsyncLocalStorage<ScopedPluginMetadataSnapshot>
>(SCOPED_PLUGIN_METADATA_SNAPSHOT_KEY, () => new AsyncLocalStorage());

function resolvePluginMetadataControlPlaneFingerprint(
  config?: OpenClawConfig,
  options: Omit<ResolvePluginControlPlaneContextParams, "config"> = {},
): string {
  return resolvePluginControlPlaneFingerprint({
    config,
    ...options,
  });
}

function publishCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions,
  owner: "gateway" | "operation" = "operation",
): CurrentPluginMetadataSnapshotRevision {
  if (getCurrentPluginMetadataSnapshotState().owner === "gateway") {
    throw new Error("Gateway plugin metadata can only be replaced after shutdown");
  }
  currentPluginMetadataConfigIdentityCache.clear();
  const fingerprint = (config: OpenClawConfig | undefined, policyHash: string | undefined) =>
    resolvePluginMetadataControlPlaneFingerprint(config, {
      env: options.env,
      index: snapshot.index,
      policyHash,
      workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
    });
  const compatiblePolicyHashes = options.compatibleConfigs?.map((config) =>
    resolveInstalledPluginIndexPolicyHash(config, options.env),
  );
  const compatibleConfigFingerprints = options.compatibleConfigs?.map((config, index) =>
    fingerprint(config, compatiblePolicyHashes?.[index]),
  );
  const configFingerprint = fingerprint(options.config, snapshot.policyHash);
  const defaultDiscoveryConfigFingerprint = fingerprint({}, snapshot.policyHash);
  const defaultDiscoveryCompatible =
    configFingerprint === defaultDiscoveryConfigFingerprint ||
    snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
    Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint));
  const revision = setCurrentPluginMetadataSnapshotState(
    snapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
    owner === "gateway" || defaultDiscoveryCompatible
      ? snapshot.owners.modelIdNormalizationPolicies
      : undefined,
    owner,
    resolvePluginMetadataEnvFingerprint(options.env),
    defaultDiscoveryCompatible,
  );
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config, options.env);
    if (
      policyHash === snapshot.policyHash ||
      Boolean(compatiblePolicyHashes?.includes(policyHash))
    ) {
      currentPluginMetadataConfigIdentityCache.add(options.config);
    }
  }
  for (const config of options.compatibleConfigs ?? []) {
    currentPluginMetadataConfigIdentityCache.add(config);
  }
  return revision;
}

/** Publishes package facts once; config reload only replaces their runtime bindings. */
export function setGatewayPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: CurrentPluginMetadataSnapshotOptions = {},
): void {
  if (!snapshot) {
    return;
  }
  if (snapshot.pluginIds !== undefined) {
    throw new Error("Gateway plugin metadata must include the complete startup inventory");
  }
  if (getCurrentPluginMetadataSnapshotState().owner === "gateway") {
    throw new Error("Gateway plugin metadata can only be replaced after shutdown");
  }
  adoptProcessPluginCache(getPluginMetadataSnapshotCache(snapshot));
  activeTemporaryPluginMetadataSnapshotLease = undefined;
  publishCurrentPluginMetadataSnapshot(snapshot, options, "gateway");
}

/** Publishes a prepared CLI snapshot without displacing a lifecycle owner. */
export function adoptCurrentPluginMetadataSnapshotIfAbsent(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions = {},
): void {
  if (
    getScopedPluginCache()?.kind === "operation" ||
    getCurrentPluginMetadataSnapshotState().snapshot !== undefined
  ) {
    return;
  }
  activeTemporaryPluginMetadataSnapshotLease = undefined;
  publishCurrentPluginMetadataSnapshot(snapshot, options);
}

function isScopedSnapshotInCurrentCache(scoped: ScopedPluginMetadataSnapshot): boolean {
  const cache = getScopedPluginCache();
  return (
    cache?.kind !== "operation" ||
    !scoped.snapshot ||
    getPluginMetadataSnapshotCache(scoped.snapshot) === cache
  );
}

function captureCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotState {
  return {
    ...getCurrentPluginMetadataSnapshotState(),
    configIdentities: currentPluginMetadataConfigIdentityCache.capture(),
  };
}

function restoreCapturedCurrentPluginMetadataSnapshotState(
  state: CurrentPluginMetadataSnapshotState,
): CurrentPluginMetadataSnapshotRevision {
  currentPluginMetadataConfigIdentityCache.restore(state.configIdentities);
  return setCurrentPluginMetadataSnapshotState(
    state.snapshot,
    state.configFingerprint,
    state.compatiblePolicyHashes,
    state.compatibleConfigFingerprints,
    state.modelIdNormalizationPolicies,
    state.owner,
    state.envFingerprint,
    state.defaultDiscoveryCompatible,
  );
}

function resolveTemporaryPluginMetadataSnapshotLeaseParent():
  | TemporaryPluginMetadataSnapshotLeaseState
  | undefined {
  const active = activeTemporaryPluginMetadataSnapshotLease;
  if (active && getCurrentPluginMetadataSnapshotState().revision !== active.revision) {
    activeTemporaryPluginMetadataSnapshotLease = undefined;
    return undefined;
  }
  return active;
}

function releaseTemporaryPluginMetadataSnapshotLease(
  lease: TemporaryPluginMetadataSnapshotLeaseState,
): boolean {
  if (lease.released) {
    return false;
  }
  lease.released = true;
  if (activeTemporaryPluginMetadataSnapshotLease !== lease) {
    return false;
  }

  let restored = false;
  while (activeTemporaryPluginMetadataSnapshotLease?.released) {
    const current: TemporaryPluginMetadataSnapshotLeaseState =
      activeTemporaryPluginMetadataSnapshotLease;
    if (getCurrentPluginMetadataSnapshotState().revision !== current.revision) {
      activeTemporaryPluginMetadataSnapshotLease = undefined;
      return restored;
    }
    const restoredRevision = restoreCapturedCurrentPluginMetadataSnapshotState(
      current.previousState,
    );
    activeTemporaryPluginMetadataSnapshotLease = current.parent;
    if (activeTemporaryPluginMetadataSnapshotLease) {
      activeTemporaryPluginMetadataSnapshotLease.revision = restoredRevision;
    }
    restored = true;
  }
  return restored;
}

/** Temporarily publishes metadata without restoring over lifecycle-owned replacements. */
export function installTemporaryCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot,
  options: CurrentPluginMetadataSnapshotOptions = {},
): TemporaryPluginMetadataSnapshotLease {
  const lease: TemporaryPluginMetadataSnapshotLeaseState = {
    parent: resolveTemporaryPluginMetadataSnapshotLeaseParent(),
    previousState: captureCurrentPluginMetadataSnapshotState(),
    revision: publishCurrentPluginMetadataSnapshot(snapshot, options),
    released: false,
  };
  activeTemporaryPluginMetadataSnapshotLease = lease;
  return {
    release: () => releaseTemporaryPluginMetadataSnapshotLease(lease),
  };
}

/** Carries one owner-prepared metadata generation through nested async plugin lookups. */
export function withPluginMetadataSnapshotScope<T>(
  snapshot: PluginMetadataSnapshot,
  run: () => T,
  options: CurrentPluginMetadataSnapshotOptions = {},
): T {
  const workspaceDir = options.workspaceDir ?? snapshot.workspaceDir;
  const compatiblePolicyHashes = options.compatibleConfigs?.map((config) =>
    resolveInstalledPluginIndexPolicyHash(config, options.env),
  );
  const compatibleConfigFingerprints = options.compatibleConfigs?.map((config, index) =>
    resolvePluginMetadataControlPlaneFingerprint(config, {
      env: options.env,
      index: snapshot.index,
      policyHash: compatiblePolicyHashes?.[index],
      workspaceDir,
    }),
  );
  const configFingerprint = options.config
    ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
        env: options.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir,
      })
    : snapshot.configFingerprint;
  const configIdentities = new WeakSet<OpenClawConfig>();
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config, options.env);
    if (
      options.trustConfigIdentity === true ||
      policyHash === snapshot.policyHash ||
      compatiblePolicyHashes?.includes(policyHash)
    ) {
      configIdentities.add(options.config);
    }
  }
  for (const config of options.compatibleConfigs ?? []) {
    configIdentities.add(config);
  }
  return withPluginCache(getPluginMetadataSnapshotCache(snapshot), () =>
    scopedPluginMetadataSnapshot.run(
      {
        snapshot,
        configFingerprint,
        envFingerprint: resolvePluginMetadataEnvFingerprint(options.env),
        compatiblePolicyHashes,
        compatibleConfigFingerprints,
        hasConfigIdentity: (config) => configIdentities.has(config),
        immutableRuntimeGeneration: options.trustConfigIdentity === true,
        parent: scopedPluginMetadataSnapshot.getStore(),
      },
      run,
    ),
  );
}

function resolveCompatiblePluginMetadataSnapshot(
  candidate: PluginMetadataSnapshotCandidate,
  params: CurrentPluginMetadataSnapshotParams,
  options: { scopedOwnerContext?: boolean } = {},
): PluginMetadataSnapshot | undefined {
  const snapshot = candidate.snapshot;
  if (!snapshot) {
    return undefined;
  }
  // Runtime selection projects the boot inventory in memory. Policy, run workspaces,
  // and narrower scopes must never send a runtime reader back into discovery.
  if (candidate.immutableRuntimeGeneration) {
    return snapshot;
  }
  const env = params.env ?? process.env;
  if (candidate.envFingerprint !== resolvePluginMetadataEnvFingerprint(env)) {
    return undefined;
  }
  const requestedPluginIds = normalizePluginIdScope(
    params.pluginIds ?? params.pluginIdScope?.resolve({ index: snapshot.index }),
  );
  const snapshotPluginIds = normalizePluginIdScope(snapshot.pluginIds);
  if (
    requestedPluginIds !== undefined &&
    serializePluginIdScope(snapshotPluginIds) !== serializePluginIdScope(requestedPluginIds)
  ) {
    return undefined;
  }
  if (
    snapshotPluginIds !== undefined &&
    requestedPluginIds === undefined &&
    params.allowScopedSnapshot !== true
  ) {
    return undefined;
  }
  const requestedWorkspaceDir =
    params.workspaceDir ??
    (params.allowWorkspaceScopedSnapshot === true || options.scopedOwnerContext === true
      ? snapshot.workspaceDir
      : undefined);
  if (snapshot.workspaceDir !== undefined && requestedWorkspaceDir === undefined) {
    return undefined;
  }
  if (
    requestedWorkspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")
  ) {
    return undefined;
  }
  const canReuseCachedConfig = Boolean(
    params.config && candidate.hasConfigIdentity?.(params.config),
  );
  if (canReuseCachedConfig && params.requireDefaultDiscoveryContext !== true) {
    return snapshot;
  }
  const requestedPolicyHash =
    params.config && !canReuseCachedConfig
      ? resolveInstalledPluginIndexPolicyHash(params.config, params.env)
      : undefined;
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    if (!candidate.compatiblePolicyHashes?.includes(requestedPolicyHash)) {
      return undefined;
    }
  }
  if (params.config && !canReuseCachedConfig) {
    const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
      env,
      index: snapshot.index,
      policyHash: requestedPolicyHash,
      workspaceDir: requestedWorkspaceDir,
    });
    const fingerprintMatches =
      candidate.configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      Boolean(candidate.compatibleConfigFingerprints?.includes(requestedConfigFingerprint));
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (
    params.requireDefaultDiscoveryContext === true &&
    options.scopedOwnerContext !== true &&
    candidate.defaultDiscoveryCompatible !== true
  ) {
    return undefined;
  }
  return snapshot;
}

export function isCurrentPluginMetadataSnapshotRuntimeGeneration(
  snapshot: Pick<PluginMetadataSnapshot, "index">,
): boolean {
  const gatewaySnapshot = getGatewayPluginMetadataSnapshot();
  if (gatewaySnapshot && gatewaySnapshot.index === snapshot.index) {
    return true;
  }
  for (let scoped = scopedPluginMetadataSnapshot.getStore(); scoped; scoped = scoped.parent) {
    if (!isScopedSnapshotInCurrentCache(scoped)) {
      continue;
    }
    if (scoped.snapshot?.index === snapshot.index && scoped.immutableRuntimeGeneration === true) {
      return true;
    }
  }
  return false;
}

export function getCurrentPluginMetadataSnapshot(
  params: CurrentPluginMetadataSnapshotParams = {},
): PluginMetadataSnapshot | undefined {
  for (let scoped = scopedPluginMetadataSnapshot.getStore(); scoped; scoped = scoped.parent) {
    if (!isScopedSnapshotInCurrentCache(scoped)) {
      continue;
    }
    // An explicit async owner scope is the discovery context for nested configless readers.
    // Global snapshots still require proof that they match the default discovery context.
    const compatibleScoped = resolveCompatiblePluginMetadataSnapshot(scoped, params, {
      scopedOwnerContext: true,
    });
    if (compatibleScoped) {
      return compatibleScoped;
    }
  }

  const scopedCache = getScopedPluginCache();
  if (scopedCache && scopedCache !== getProcessPluginCache()) {
    return undefined;
  }

  const {
    snapshot,
    owner,
    configFingerprint,
    envFingerprint,
    defaultDiscoveryCompatible,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  } = getCurrentPluginMetadataSnapshotState();
  return resolveCompatiblePluginMetadataSnapshot(
    {
      snapshot: snapshot as PluginMetadataSnapshot | undefined,
      configFingerprint,
      envFingerprint,
      defaultDiscoveryCompatible,
      compatiblePolicyHashes,
      compatibleConfigFingerprints,
      hasConfigIdentity: (config) => currentPluginMetadataConfigIdentityCache.has(config),
      immutableRuntimeGeneration: owner === "gateway",
    },
    params,
  );
}

// Light bridges (plugin-metadata-snapshot.runtime.ts) serve reads through this
// instance whenever the metadata system is loaded; the require fallback only
// covers cold processes.
registerPluginMetadataSnapshotReaders({
  adoptCurrentPluginMetadataSnapshotIfAbsent,
  getCurrentPluginMetadataSnapshot,
});
