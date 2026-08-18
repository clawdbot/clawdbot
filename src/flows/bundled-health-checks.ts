// Bundled health checks define built-in doctor checks for runtime readiness.
import { asOptionalObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginId, normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import {
  loadBundledPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import type { InspectEmbeddingProviderSetup } from "../plugins/provider-policy-surface.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import {
  loadBundledPluginPublicArtifactModuleFromCandidatesSync,
  loadBundledPluginPublicArtifactModuleSync,
} from "../plugins/public-surface-loader.js";
import { collectConfiguredWorkerProviderIds } from "../plugins/worker-provider-config.js";
import { listBundledWorkerProviderOwners } from "../plugins/worker-provider-manifest.js";
import { getHealthCheck, registerHealthCheck } from "./health-check-registry.js";

type EmbeddingProviderSetupInspectionResult =
  | Awaited<ReturnType<InspectEmbeddingProviderSetup>>
  | undefined;

// Bridges bundled plugin doctor checks into the core health registry.
type BundledHealthApi = {
  registerCodexManagedAppServerDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
  pluginStateIsolatedDoctorCheckIds?: readonly string[];
  registerCuaDriverDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
  registerMemoryCoreDoctorChecks?: (host: {
    getHealthCheck: typeof getHealthCheck;
    registerHealthCheck: typeof registerHealthCheck;
    inspectEmbeddingProviderSetup: (
      params: Parameters<InspectEmbeddingProviderSetup>[0],
    ) => EmbeddingProviderSetupInspectionResult | Promise<EmbeddingProviderSetupInspectionResult>;
    memoryCoreActive: boolean;
  }) => void;
  registerPolicyDoctorChecks?: (host: { registerHealthCheck: typeof registerHealthCheck }) => void;
};

type WorkerProviderHealthApi = {
  registerWorkerProviderDoctorChecks?: (host: {
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
};

type BundledHealthCheckSelection = {
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly includeAllChecks?: boolean;
};

type BundledHealthCheckPluginStateMode = "direct" | "deferred" | "isolated";

function loadMemoryCoreHealthApi(): BundledHealthApi {
  return loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
    dirName: "memory-core",
    artifactBasename: "api.js",
  });
}

export function resolveBundledHealthCheckPluginStateMode(
  selection: BundledHealthCheckSelection,
): BundledHealthCheckPluginStateMode {
  if (
    selection.includeAllChecks !== true &&
    (selection.onlyIds === undefined || selection.onlyIds.length === 0)
  ) {
    return "direct";
  }
  const isolatedIds = new Set(loadMemoryCoreHealthApi().pluginStateIsolatedDoctorCheckIds ?? []);
  const skippedIds = new Set(selection.skipIds ?? []);
  const selectedOnlyIds = [...new Set(selection.onlyIds ?? [])].filter((id) => !skippedIds.has(id));
  const selectedIsolatedIds =
    selectedOnlyIds.length > 0
      ? selectedOnlyIds.filter((id) => isolatedIds.has(id))
      : [...isolatedIds].filter((id) => !skippedIds.has(id));
  if (selectedIsolatedIds.length === 0) {
    return "direct";
  }
  if (selectedOnlyIds.length > 0 && selectedOnlyIds.every((id) => isolatedIds.has(id))) {
    return "deferred";
  }
  return "isolated";
}

/** Registers bundled health checks that are explicitly enabled by config and owner policy. */
export function registerBundledHealthChecks(params: {
  cfg: OpenClawConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runWithPluginStateSnapshot?: <T>(
    run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
  ) => Promise<T>;
}): void {
  const env = params.env ?? process.env;
  loadMemoryCoreHealthApi().registerMemoryCoreDoctorChecks?.({
    getHealthCheck,
    registerHealthCheck,
    async inspectEmbeddingProviderSetup(providerParams) {
      const inspect = async (pluginMetadataEnv: NodeJS.ProcessEnv) => {
        const manifestRegistry: PluginManifestRegistry =
          loadPluginManifestRegistryForPluginRegistry({
            config: params.cfg,
            workspaceDir: params.cwd,
            env: pluginMetadataEnv,
          });
        const inspector = resolveProviderPolicySurface(providerParams.provider, {
          manifestRegistry,
        })?.inspectEmbeddingProviderSetup;
        return inspector
          ? await inspector({ ...providerParams, env: pluginMetadataEnv })
          : undefined;
      };
      return params.runWithPluginStateSnapshot
        ? await params.runWithPluginStateSnapshot(inspect)
        : await inspect(env);
    },
    memoryCoreActive: isMemoryCoreActive(params.cfg),
  });
  if (shouldRegisterCodexManagedHealth(params.cfg)) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "codex",
      artifactBasename: "api.js",
    }).registerCodexManagedAppServerDoctorChecks?.({ registerHealthCheck });
  }
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
  registerBundledWorkerProviderHealthChecks(params, env);
}

function registerBundledWorkerProviderHealthChecks(
  params: { cfg: OpenClawConfig; cwd?: string },
  env: NodeJS.ProcessEnv,
): void {
  const providerIds = collectConfiguredWorkerProviderIds(params.cfg);
  if (providerIds.length === 0) {
    return;
  }
  const manifestRegistry = loadBundledPluginManifestRegistry({ env });
  const pluginIds = new Set(
    listBundledWorkerProviderOwners(manifestRegistry, providerIds).map((owner) => owner.pluginId),
  );
  for (const pluginId of pluginIds) {
    loadBundledPluginPublicArtifactModuleFromCandidatesSync<WorkerProviderHealthApi>({
      dirName: pluginId,
      artifactCandidates: ["doctor-health-api.js"],
    })?.registerWorkerProviderDoctorChecks?.({ registerHealthCheck });
  }
}

function shouldRegisterCodexManagedHealth(cfg: OpenClawConfig): boolean {
  if (!collectConfiguredAgentHarnessRuntimes(cfg).includes("codex")) {
    return false;
  }
  if (cfg.plugins?.entries?.codex?.enabled === false) {
    return false;
  }
  return passesManifestOwnerBasePolicy({
    plugin: { id: "codex" },
    normalizedConfig: normalizePluginsConfig(cfg.plugins),
  });
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
