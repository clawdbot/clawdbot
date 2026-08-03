/** Tracks the current plugin metadata snapshot for control-plane lookups. */
import { setCurrentManifestModelIdNormalizationRecords } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  currentPluginMetadataConfigIdentityCache,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
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

function resolvePluginMetadataControlPlaneFingerprint(
  config?: OpenClawConfig,
  options: Omit<ResolvePluginControlPlaneContextParams, "config"> = {},
): string {
  return resolvePluginControlPlaneFingerprint({
    config,
    ...options,
  });
}

// Single-slot Gateway-owned handoff. Replace or clear it at lifecycle boundaries;
// never accumulate historical metadata snapshots here.
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: {
    config?: OpenClawConfig;
    compatibleConfigs?: readonly OpenClawConfig[];
    compatibleWorkspaceDirs?: readonly string[];
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  } = {},
): void {
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
  const compatibleWorkspaceDirs = snapshot ? options.compatibleWorkspaceDirs : undefined;
  const configFingerprint = snapshot
    ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
        env: options.env,
        index: snapshot.index,
        policyHash: snapshot.policyHash,
        workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
      })
    : undefined;
  // A full (unscoped) published snapshot IS the process's default discovery
  // context. The old baseline compared against a literal {} config, which can
  // never match once the operator sets plugins.load.paths — permanently
  // disabling manifest model-id normalization and forcing every config-less
  // lookup into a ~50ms full manifest rescan that returns a snapshot MISSING
  // the load-path plugins (strictly worse than the one it rejected).
  const defaultDiscoveryCompatible =
    Boolean(snapshot) && normalizePluginIdScope(snapshot?.pluginIds) === undefined;
  setCurrentManifestModelIdNormalizationRecords(
    snapshot && defaultDiscoveryCompatible ? snapshot.plugins : undefined,
  );
  setCurrentPluginMetadataSnapshotState(
    snapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
    compatibleWorkspaceDirs,
    defaultDiscoveryCompatible,
  );
  if (!snapshot) {
    return;
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
}

export function captureCurrentPluginMetadataSnapshotState(): CurrentPluginMetadataSnapshotState {
  return {
    ...getCurrentPluginMetadataSnapshotState(),
    configIdentities: currentPluginMetadataConfigIdentityCache.capture(),
  };
}

export function restoreCurrentPluginMetadataSnapshotState(
  state: CurrentPluginMetadataSnapshotState,
): void {
  currentPluginMetadataConfigIdentityCache.restore(state.configIdentities);
  const snapshot = state.snapshot as PluginMetadataSnapshot | undefined;
  const defaultDiscoveryCompatible = state.defaultDiscoveryCompatible;
  setCurrentManifestModelIdNormalizationRecords(
    snapshot && defaultDiscoveryCompatible ? snapshot.plugins : undefined,
  );
  setCurrentPluginMetadataSnapshotState(
    state.snapshot,
    state.configFingerprint,
    state.compatiblePolicyHashes,
    state.compatibleConfigFingerprints,
    state.compatibleWorkspaceDirs,
    defaultDiscoveryCompatible,
  );
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
    /**
     * Discovery EQUIVALENCE: reject unless a config with default load paths
     * would discover exactly this snapshot. For foreign-config consumers
     * (plugin auto-enable, activation context, project settings) that apply
     * their own config's policy to the registry.
     */
    requireDefaultDiscoveryContext?: boolean;
    /**
     * Process IDENTITY: accept the process's published full (unscoped)
     * snapshot, including operator plugins.load.paths. For process-global
     * consumers (model-id normalization, provider env vars/aliases) that ask
     * "what is this gateway's real plugin set?".
     */
    requireProcessFullContext?: boolean;
  } = {},
): PluginMetadataSnapshot | undefined {
  const {
    snapshot: rawSnapshot,
    configFingerprint,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
    compatibleWorkspaceDirs,
    defaultDiscoveryCompatible,
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
    (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "") &&
    !compatibleWorkspaceDirs?.includes(requestedWorkspaceDir)
  ) {
    return undefined;
  }
  const canReuseCachedConfig = Boolean(
    params.config && currentPluginMetadataConfigIdentityCache.has(params.config),
  );
  if (
    canReuseCachedConfig &&
    params.requireDefaultDiscoveryContext !== true &&
    params.requireProcessFullContext !== true
  ) {
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
  if (params.requireProcessFullContext === true && !defaultDiscoveryCompatible) {
    // The stored publish-time flag marks whether this is the process's
    // canonical full-context snapshot (see setCurrentPluginMetadataSnapshot).
    return undefined;
  }
  if (params.requireDefaultDiscoveryContext === true) {
    // Discovery equivalence must stay a fingerprint comparison against a
    // default-load-path config: foreign-config consumers write policy from
    // this registry (plugin auto-enable mutates plugins.allow), and the
    // policy hash cannot see load.paths. See plugin-auto-enable.core.test.
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
