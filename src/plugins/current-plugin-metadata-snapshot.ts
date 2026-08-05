/** Tracks the current plugin metadata snapshot for control-plane lookups. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  currentPluginMetadataConfigIdentityCache,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
  type CurrentPluginMetadataSnapshotRevision,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  resolvePluginControlPlaneFingerprint,
  type ResolvePluginControlPlaneContextParams,
} from "./plugin-control-plane-context.js";
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

let activeTemporaryPluginMetadataSnapshotLease:
  | TemporaryPluginMetadataSnapshotLeaseState
  | undefined;

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
  snapshot: PluginMetadataSnapshot | undefined,
  options: CurrentPluginMetadataSnapshotOptions,
): CurrentPluginMetadataSnapshotRevision {
  currentPluginMetadataConfigIdentityCache.clear();
  const compatiblePolicyHashes = snapshot
    ? options.compatibleConfigs?.map((config) => resolveInstalledPluginIndexPolicyHash(config))
    : undefined;
  const compatibleConfigFingerprints = snapshot
    ? options.compatibleConfigs?.map((config, index) =>
        resolvePluginMetadataControlPlaneFingerprint(config, {
          env: options.env,
          index: snapshot.index,
          policyHash: compatiblePolicyHashes?.[index],
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        }),
      )
    : undefined;
  const configFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
        env: options.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
      })
    : undefined;
  const defaultDiscoveryConfigFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(
        {},
        {
          env: options.env,
          index: snapshot.index,
          policyHash: snapshot.policyHash,
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        },
      )
    : undefined;
  const defaultDiscoveryCompatible =
    snapshot &&
    defaultDiscoveryConfigFingerprint &&
    (configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint)));
  const revision = setCurrentPluginMetadataSnapshotState(
    snapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
    defaultDiscoveryCompatible ? snapshot.plugins : undefined,
  );
  if (!snapshot) {
    return revision;
  }
  if (options.config) {
    const policyHash = resolveInstalledPluginIndexPolicyHash(options.config);
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

// Single-slot Gateway-owned handoff. Replace or clear it at lifecycle boundaries;
// never accumulate historical metadata snapshots here.
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: CurrentPluginMetadataSnapshotOptions = {},
): void {
  activeTemporaryPluginMetadataSnapshotLease = undefined;
  publishCurrentPluginMetadataSnapshot(snapshot, options);
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
    state.manifestModelIdNormalizationRecords,
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

export function getCurrentPluginMetadataSnapshot(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    allowScopedSnapshot?: boolean;
    pluginIds?: readonly string[];
    pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
    workspaceDir?: string;
    allowWorkspaceScopedSnapshot?: boolean;
    requireDefaultDiscoveryContext?: boolean;
  } = {},
): PluginMetadataSnapshot | undefined {
  const {
    snapshot: rawSnapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  } = getCurrentPluginMetadataSnapshotState();
  const snapshot = rawSnapshot as PluginMetadataSnapshot | undefined;
  if (!snapshot) {
    return undefined;
  }
  const env = params.env ?? process.env;
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
    (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : undefined);
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
    params.config && currentPluginMetadataConfigIdentityCache.has(params.config),
  );
  if (canReuseCachedConfig && params.requireDefaultDiscoveryContext !== true) {
    return snapshot;
  }
  const requestedPolicyHash =
    params.config && !canReuseCachedConfig
      ? resolveInstalledPluginIndexPolicyHash(params.config)
      : undefined;
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    if (!compatiblePolicyHashes?.includes(requestedPolicyHash)) {
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
      configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(requestedConfigFingerprint));
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (params.requireDefaultDiscoveryContext === true) {
    const defaultDiscoveryConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: params.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir: requestedWorkspaceDir,
      },
    );
    const fingerprintMatches =
      configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      Boolean(compatibleConfigFingerprints?.includes(defaultDiscoveryConfigFingerprint));
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  return snapshot;
}
