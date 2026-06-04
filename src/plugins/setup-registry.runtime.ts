/** Runtime lookup helpers for plugin setup CLI backend descriptors. */
import { createRequire } from "node:module";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";

type SetupRegistryRuntimeModule = Pick<
  typeof import("./setup-registry.js"),
  "resolvePluginSetupCliBackend"
>;

type SetupCliBackendRuntimeEntry = {
  pluginId: string;
  backend: {
    id: string;
  };
};

type SetupCliBackendRuntimeLookupParams = {
  backend: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

const require = createRequire(import.meta.url);
const SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"] as const;

type SetupCliBackendDescriptorCache = {
  configFingerprint: string;
  entries: SetupCliBackendRuntimeEntry[];
};

let setupRegistryRuntimeModule: SetupRegistryRuntimeModule | null | undefined;
let cachedSetupCliBackendDescriptors: SetupCliBackendDescriptorCache | undefined;
let cachedBundledSetupCliBackends: SetupCliBackendDescriptorCache | undefined;

/** Test hooks for resetting setup-registry runtime module caches. */
export const testing = {
  resetRuntimeState(): void {
    setupRegistryRuntimeModule = undefined;
    cachedSetupCliBackendDescriptors = undefined;
    cachedBundledSetupCliBackends = undefined;
  },
  setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void {
    setupRegistryRuntimeModule = module;
  },
};

function resolveMetadataSnapshotForSetupCliBackends(
  params: Omit<SetupCliBackendRuntimeLookupParams, "backend"> = {},
): {
  snapshot: PluginMetadataSnapshot;
  cacheable: boolean;
} {
  const env = params.env ?? process.env;
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const snapshot = resolvePluginMetadataSnapshot({
    config: params.config ?? {},
    env,
    ...(workspaceDir !== undefined
      ? {
          workspaceDir,
          allowWorkspaceScopedCurrent: true,
        }
      : {}),
  });
  return {
    snapshot,
    cacheable: true,
  };
}

function resolveBundledSetupCliBackends(
  params: Omit<SetupCliBackendRuntimeLookupParams, "backend"> = {},
): SetupCliBackendRuntimeEntry[] {
  const { snapshot, cacheable } = resolveMetadataSnapshotForSetupCliBackends(params);
  const configFingerprint = snapshot.configFingerprint;
  if (
    cacheable &&
    configFingerprint &&
    cachedBundledSetupCliBackends?.configFingerprint === configFingerprint
  ) {
    return cachedBundledSetupCliBackends.entries;
  }
  const entries = snapshot.plugins.flatMap((plugin) => {
    if (plugin.origin !== "bundled" || !isInstalledPluginEnabled(snapshot.index, plugin.id)) {
      return [];
    }
    return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
      (backendId) =>
        ({
          pluginId: plugin.id,
          backend: { id: backendId },
        }) satisfies SetupCliBackendRuntimeEntry,
    );
  });
  if (cacheable && configFingerprint) {
    cachedBundledSetupCliBackends = { configFingerprint, entries };
  }
  return entries;
}

function resolveSetupCliBackendDescriptors(
  params: Omit<SetupCliBackendRuntimeLookupParams, "backend"> = {},
): SetupCliBackendRuntimeEntry[] {
  const { snapshot, cacheable } = resolveMetadataSnapshotForSetupCliBackends(params);
  const configFingerprint = snapshot.configFingerprint;
  if (
    cacheable &&
    configFingerprint &&
    cachedSetupCliBackendDescriptors?.configFingerprint === configFingerprint
  ) {
    return cachedSetupCliBackendDescriptors.entries;
  }
  const entries = snapshot.plugins.flatMap((plugin) => {
    if (!isInstalledPluginEnabled(snapshot.index, plugin.id)) {
      return [];
    }
    return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
      (backendId) =>
        ({
          pluginId: plugin.id,
          backend: { id: backendId },
        }) satisfies SetupCliBackendRuntimeEntry,
    );
  });
  if (cacheable && configFingerprint) {
    cachedSetupCliBackendDescriptors = { configFingerprint, entries };
  }
  return entries;
}

function loadSetupRegistryRuntime(): SetupRegistryRuntimeModule | null {
  if (setupRegistryRuntimeModule !== undefined) {
    return setupRegistryRuntimeModule;
  }
  for (const candidate of SETUP_REGISTRY_RUNTIME_CANDIDATES) {
    try {
      setupRegistryRuntimeModule = require(candidate) as SetupRegistryRuntimeModule;
      return setupRegistryRuntimeModule;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  setupRegistryRuntimeModule = null;
  return null;
}

export function resolvePluginSetupCliBackendDescriptor(params: SetupCliBackendRuntimeLookupParams) {
  const normalized = normalizeProviderId(params.backend);
  return resolveSetupCliBackendDescriptors(params).find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}

export function resolvePluginSetupCliBackendRuntime(params: SetupCliBackendRuntimeLookupParams) {
  const normalized = normalizeProviderId(params.backend);
  const runtime = loadSetupRegistryRuntime();
  if (runtime !== null) {
    return runtime.resolvePluginSetupCliBackend(params);
  }
  return resolveBundledSetupCliBackends(params).find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}
export { testing as __testing };
