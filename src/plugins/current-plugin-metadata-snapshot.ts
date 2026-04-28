import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshotState,
  getCurrentPluginMetadataSnapshotState,
  setCurrentPluginMetadataSnapshotState,
} from "./current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";

function normalizeLoadPaths(config: OpenClawConfig | undefined): readonly string[] {
  const paths = config?.plugins?.load?.paths;
  if (!Array.isArray(paths)) {
    return [];
  }
  return paths.filter((entry) => typeof entry === "string");
}

export function resolvePluginMetadataSnapshotConfigFingerprint(
  config: OpenClawConfig | undefined,
  options: { policyHash?: string } = {},
): string {
  return JSON.stringify({
    policyHash: options.policyHash ?? resolveInstalledPluginIndexPolicyHash(config),
    pluginLoadPaths: normalizeLoadPaths(config),
  });
}

// Single-slot Gateway-owned handoff. Replace or clear it at lifecycle boundaries;
// never accumulate historical metadata snapshots here.
export function setCurrentPluginMetadataSnapshot(
  snapshot: PluginMetadataSnapshot | undefined,
  options: { config?: OpenClawConfig } = {},
): void {
  setCurrentPluginMetadataSnapshotState(
    snapshot,
    snapshot
      ? resolvePluginMetadataSnapshotConfigFingerprint(options.config, {
          policyHash: snapshot.policyHash,
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
    workspaceDir?: string;
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
  if (
    params.config &&
    configFingerprint &&
    configFingerprint !== resolvePluginMetadataSnapshotConfigFingerprint(params.config)
  ) {
    return undefined;
  }
  if (snapshot.workspaceDir !== undefined && params.workspaceDir === undefined) {
    return undefined;
  }
  if (
    params.workspaceDir !== undefined &&
    (snapshot.workspaceDir ?? "") !== (params.workspaceDir ?? "")
  ) {
    return undefined;
  }
  return snapshot;
}
