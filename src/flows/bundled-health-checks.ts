// Bundled health checks define built-in doctor checks for runtime readiness.
import { asOptionalObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { registerHealthCheck } from "./health-check-registry.js";

// Bridges bundled plugin doctor checks into the core health registry.
type BundledHealthApi = {
  registerCuaDriverDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
  registerPolicyDoctorChecks?: (host: { registerHealthCheck: typeof registerHealthCheck }) => void;
};

/** Registers bundled health checks that are explicitly enabled by config and owner policy. */
export function registerBundledHealthChecks(params: { cfg: OpenClawConfig; cwd?: string }): void {
  if (shouldRegisterPolicyHealth(params)) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "policy",
      artifactBasename: "api.js",
    }).registerPolicyDoctorChecks?.({ registerHealthCheck });
  }
  if (shouldRegisterPluginHealth(params.cfg, "cua-computer")) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "cua-computer",
      artifactBasename: "api.js",
    }).registerCuaDriverDoctorChecks?.({ registerHealthCheck });
  }
}

function shouldRegisterPluginHealth(cfg: OpenClawConfig, pluginId: string): boolean {
  const entry = cfg.plugins?.entries?.[pluginId];
  if (entry?.enabled !== true) {
    return false;
  }
  return passesManifestOwnerBasePolicy({
    plugin: { id: pluginId },
    normalizedConfig: normalizePluginsConfig(cfg.plugins),
  });
}

function shouldRegisterPolicyHealth(params: { cfg: OpenClawConfig; cwd?: string }): boolean {
  const entry = params.cfg.plugins?.entries?.policy;
  const config = readRecord(entry?.config) ?? {};
  if (entry === undefined || entry.enabled === false || config.enabled === false) {
    return false;
  }
  // Policy doctor checks are bundled, but still respect the same manifest owner gate as runtime.
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: "policy" },
      normalizedConfig: normalizePluginsConfig(params.cfg.plugins),
    })
  ) {
    return false;
  }
  return entry.enabled === true || config.enabled === true;
}
