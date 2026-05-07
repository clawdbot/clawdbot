import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshotState,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import {
  resolvePluginControlPlaneFingerprint,
  type ResolvePluginControlPlaneContextParams,
} from "./plugin-control-plane-context.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

export function resolvePluginMetadataControlPlaneFingerprint(
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
    env?: NodeJS.ProcessEnv;
    workspaceDir?: string;
  } = {},
): void {
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
  setCurrentPluginMetadataSnapshotState(
    snapshot,
    snapshot
      ? resolvePluginMetadataControlPlaneFingerprint(options.config, {
          env: options.env,
          index: snapshot.index,
          policyHash: snapshot.policyHash,
          workspaceDir: options.workspaceDir ?? snapshot.workspaceDir,
        })
      : undefined,
    compatiblePolicyHashes,
    compatibleConfigFingerprints,
  );
}

export function clearCurrentPluginMetadataSnapshot(): void {
  clearCurrentPluginMetadataSnapshotState();
}

export function getCurrentPluginMetadataSnapshot(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
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
  const requestedPolicyHash = params.config
    ? resolveInstalledPluginIndexPolicyHash(params.config)
    : undefined;
  if (requestedPolicyHash && snapshot.policyHash !== requestedPolicyHash) {
    const compatiblePolicies = new Set(compatiblePolicyHashes ?? []);
    if (!compatiblePolicies.has(requestedPolicyHash)) {
      return undefined;
    }
  }
  const requestedWorkspaceDir =
    params.workspaceDir ??
    (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : undefined);
  if (params.config) {
    const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
      env: params.env,
      index: snapshot.index,
      policyHash: requestedPolicyHash,
      workspaceDir: requestedWorkspaceDir,
    });
    const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
    const fingerprintMatches =
      configFingerprint === requestedConfigFingerprint ||
      snapshot.configFingerprint === requestedConfigFingerprint ||
      compatibleFingerprints.has(requestedConfigFingerprint);
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
    const compatibleFingerprints = new Set(compatibleConfigFingerprints ?? []);
    const fingerprintMatches =
      configFingerprint === defaultDiscoveryConfigFingerprint ||
      snapshot.configFingerprint === defaultDiscoveryConfigFingerprint ||
      compatibleFingerprints.has(defaultDiscoveryConfigFingerprint);
    if (!fingerprintMatches) {
      return undefined;
    }
  }
  if (snapshot.workspaceDir !== undefined && requestedWorkspaceDir === undefined) {
    return undefined;
  }
  if (
    requestedWorkspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (requestedWorkspaceDir ?? "")
  ) {
    return undefined;
  }
  return snapshot;
}
