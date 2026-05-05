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
  options: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv; workspaceDir?: string } = {},
): void {
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
  } = {},
): PluginMetadataSnapshot | undefined {
  const { snapshot: rawSnapshot, configFingerprint } = getCurrentPluginMetadataSnapshotState();
  const snapshot = rawSnapshot as PluginMetadataSnapshot | undefined;
  if (!snapshot) {
    return undefined;
  }
  if (
    params.config &&
    snapshot.policyHash !== resolveInstalledPluginIndexPolicyHash(params.config)
  ) {
    return undefined;
  }
  const requestedWorkspaceDir =
    params.workspaceDir ??
    (params.allowWorkspaceScopedSnapshot === true ? snapshot.workspaceDir : undefined);
  if (params.config) {
    const requestedConfigFingerprint = resolvePluginMetadataControlPlaneFingerprint(params.config, {
      env: params.env,
      index: snapshot.index,
      policyHash: snapshot.policyHash,
      workspaceDir: requestedWorkspaceDir,
    });
    if (configFingerprint && configFingerprint !== requestedConfigFingerprint) {
      return undefined;
    }
    if (snapshot.configFingerprint && snapshot.configFingerprint !== requestedConfigFingerprint) {
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
