// Bundled health checks define built-in doctor checks for runtime readiness.
import { asOptionalObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MissingPublicSurfaceError } from "../plugin-sdk/facade-loader.js";
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
  loadPluginPublicArtifactModuleSync,
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
    getHealthCheck: typeof getHealthCheck;
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
    getHealthCheck: typeof getHealthCheck;
    registerHealthCheck: typeof registerHealthCheck;
  }) => void;
};

type BundledHealthCheckSelection = {
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly includeAllChecks?: boolean;
  readonly updateReadiness?: "post-plugin";
};

type BundledHealthCheckPluginStateMode = "direct" | "deferred" | "isolated";

type BundledHealthCheckParams = {
  cfg: OpenClawConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  runWithPluginStateSnapshot?: <T>(
    run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
  ) => Promise<T>;
};

function defineHealthCheckRegistration(
  register: (params: BundledHealthCheckParams, registerCheck: typeof registerHealthCheck) => void,
  updateReadiness?: "post-plugin",
) {
  // Owners retain callback and check identities when refreshing their registration state.
  // Declare phase ownership before loading their implementation, then carry it onto each check.
  const registerCheck = updateReadiness
    ? (check: Parameters<typeof registerHealthCheck>[0]) =>
        registerHealthCheck(Object.assign(check, { updateReadiness }))
    : registerHealthCheck;
  return {
    updateReadiness,
    register: (params: BundledHealthCheckParams) => register(params, registerCheck),
  };
}

const HEALTH_CHECK_REGISTRATIONS = [
  defineHealthCheckRegistration(registerMemoryCoreHealthChecks, "post-plugin"),
  defineHealthCheckRegistration(registerCodexHealthChecks),
  defineHealthCheckRegistration(registerPolicyHealthChecks),
  defineHealthCheckRegistration(registerCuaHealthChecks),
  defineHealthCheckRegistration(registerBundledWorkerProviderHealthChecks),
];

function loadMemoryCoreHealthApi(): BundledHealthApi {
  return loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
    dirName: "memory-core",
    artifactBasename: "doctor-health-api.js",
  });
}

export function resolveBundledHealthCheckPluginStateMode(
  selection: BundledHealthCheckSelection,
): BundledHealthCheckPluginStateMode {
  if (selection.updateReadiness !== undefined) {
    // Update gates may inspect plugin-owned persistent state. Keep every phase on a private
    // snapshot so a future tagged check cannot accidentally mutate the live pre-restart owner.
    return "isolated";
  }
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
export function registerBundledHealthChecks(
  params: BundledHealthCheckParams & { updateReadiness?: "post-plugin" },
): void {
  for (const registration of HEALTH_CHECK_REGISTRATIONS) {
    if (
      params.updateReadiness !== undefined &&
      registration.updateReadiness !== params.updateReadiness
    ) {
      continue;
    }
    registration.register(params);
  }
}

function registerMemoryCoreHealthChecks(
  params: BundledHealthCheckParams,
  registerCheck: typeof registerHealthCheck,
): void {
  const env = params.env ?? process.env;
  loadMemoryCoreHealthApi().registerMemoryCoreDoctorChecks?.({
    getHealthCheck,
    registerHealthCheck: registerCheck,
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
}

function registerCodexHealthChecks(
  params: BundledHealthCheckParams,
  registerCheck: typeof registerHealthCheck,
): void {
  const env = params.env ?? process.env;
  if (shouldRegisterCodexManagedHealth(params.cfg)) {
    const registry = loadPluginManifestRegistryForPluginRegistry({
      config: params.cfg,
      workspaceDir: params.cwd,
      env,
      pluginIds: ["codex"],
    });
    const owner = registry.plugins.find((plugin) => plugin.id === "codex");
    // Doctor must inspect the selected runtime's artifact, including official external installs.
    // A bundled-first lookup can inspect a different version or bypass the selected owner's trust.
    if (!owner || (owner.origin !== "bundled" && owner.trustedOfficialInstall !== true)) {
      throw new MissingPublicSurfaceError(
        "Unable to resolve Codex doctor health API: install the official Codex plugin with openclaw plugins install @openclaw/codex",
      );
    }
    // Retained stable plugins can predate health APIs while an upgrade awaits capability consent.
    // Only load an advertised surface; a broken declaration must still fail visibly.
    if (owner.doctorHealthChecks === true) {
      loadPluginPublicArtifactModuleSync<
        Required<Pick<BundledHealthApi, "registerCodexManagedAppServerDoctorChecks">>
      >({
        pluginRoot: owner.rootDir,
        pluginId: owner.id,
        artifactBasename: "api.js",
        origin: owner.origin === "bundled" ? "bundled" : "global",
      }).registerCodexManagedAppServerDoctorChecks({
        getHealthCheck,
        registerHealthCheck: registerCheck,
      });
    }
  }
}

function registerPolicyHealthChecks(
  params: BundledHealthCheckParams,
  registerCheck: typeof registerHealthCheck,
): void {
  if (shouldRegisterPolicyHealth(params)) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "policy",
      artifactBasename: "api.js",
    }).registerPolicyDoctorChecks?.({ registerHealthCheck: registerCheck });
  }
}

function registerCuaHealthChecks(
  params: BundledHealthCheckParams,
  registerCheck: typeof registerHealthCheck,
): void {
  if (shouldRegisterPluginHealth(params.cfg, "cua-computer")) {
    loadBundledPluginPublicArtifactModuleSync<BundledHealthApi>({
      dirName: "cua-computer",
      artifactBasename: "api.js",
    }).registerCuaDriverDoctorChecks?.({ registerHealthCheck: registerCheck });
  }
}

function registerBundledWorkerProviderHealthChecks(
  params: BundledHealthCheckParams,
  registerCheck: typeof registerHealthCheck,
): void {
  const env = params.env ?? process.env;
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
    })?.registerWorkerProviderDoctorChecks?.({
      getHealthCheck,
      registerHealthCheck: registerCheck,
    });
  }
}

function shouldRegisterCodexManagedHealth(cfg: OpenClawConfig): boolean {
  if (!collectConfiguredAgentHarnessRuntimes(cfg).includes("codex")) {
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
