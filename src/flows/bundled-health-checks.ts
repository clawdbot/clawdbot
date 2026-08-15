// Bundled health checks define built-in doctor checks for runtime readiness.
import { asOptionalObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginId, normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import type { InspectEmbeddingProviderSetup } from "../plugins/provider-policy-surface.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { registerHealthCheck } from "./health-check-registry.js";

// Bridges bundled plugin doctor checks into the core health registry.
type BundledHealthApi = {
  registerCuaDriverDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
  registerMemoryCoreDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
    resolveEmbeddingProviderSetupInspector: (
      provider: string,
    ) => InspectEmbeddingProviderSetup | undefined;
    memoryCoreActive: boolean;
  }) => void;
  registerPolicyDoctorChecks?: (host: { registerHealthCheck: typeof registerHealthCheck }) => void;
};

/** Registers bundled health checks that are explicitly enabled by config and owner policy. */
export function registerBundledHealthChecks(params: {
  cfg: OpenClawConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = params.env ?? process.env;
  let manifestRegistry: PluginManifestRegistry | undefined;
  loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
    dirName: "memory-core",
    artifactBasename: "api.js",
  }).registerMemoryCoreDoctorChecks?.({
    registerHealthCheck,
    resolveEmbeddingProviderSetupInspector(provider) {
      manifestRegistry ??= loadPluginManifestRegistryForPluginRegistry({
        config: params.cfg,
        workspaceDir: params.cwd,
        env,
      });
      return resolveProviderPolicySurface(provider, { manifestRegistry })
        ?.inspectEmbeddingProviderSetup;
    },
    memoryCoreActive: isMemoryCoreActive(params.cfg),
  });
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

function isMemoryCoreActive(cfg: OpenClawConfig): boolean {
  const plugins = normalizePluginsConfig(cfg.plugins);
  const selectedMemoryPluginId =
    typeof plugins.slots.memory === "string"
      ? normalizePluginId(plugins.slots.memory)
      : plugins.slots.memory;
  const configuredMemorySlot = cfg.plugins?.slots?.memory;
  const explicitlySelected =
    typeof configuredMemorySlot === "string" &&
    normalizePluginId(configuredMemorySlot) === "memory-core";
  return (
    selectedMemoryPluginId === "memory-core" &&
    passesManifestOwnerBasePolicy({
      plugin: { id: "memory-core" },
      normalizedConfig: plugins,
      allowRestrictiveAllowlistBypass: explicitlySelected,
    })
  );
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
