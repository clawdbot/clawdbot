import { createRequire } from "node:module";
import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginRegistrySnapshot } from "./plugin-registry.js";

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

const require = createRequire(import.meta.url);
const SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"] as const;

let setupRegistryRuntimeModule: SetupRegistryRuntimeModule | null | undefined;
let bundledSetupCliBackendsCache: SetupCliBackendRuntimeEntry[] | undefined;

export const __testing = {
  resetRuntimeState(): void {
    setupRegistryRuntimeModule = undefined;
    bundledSetupCliBackendsCache = undefined;
  },
  setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void {
    setupRegistryRuntimeModule = module;
  },
};

function resolveBundledSetupCliBackends(): SetupCliBackendRuntimeEntry[] {
  if (bundledSetupCliBackendsCache) {
    return bundledSetupCliBackendsCache;
  }
  const index = loadPluginRegistrySnapshot({ cache: true });
  bundledSetupCliBackendsCache = loadPluginManifestRegistryForInstalledIndex({
    index,
  }).plugins.flatMap((plugin) => {
    if (plugin.origin !== "bundled") {
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
  return bundledSetupCliBackendsCache;
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
  return null;
}

export function resolvePluginSetupCliBackendRuntime(params: { backend: string }) {
  const normalized = normalizeProviderId(params.backend);
  const runtime = loadSetupRegistryRuntime();
  if (runtime !== null) {
    return runtime.resolvePluginSetupCliBackend(params);
  }
  return resolveBundledSetupCliBackends().find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}
