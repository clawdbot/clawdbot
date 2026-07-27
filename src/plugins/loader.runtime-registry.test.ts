// Verifies plugin loader runtime registry behavior.
import { afterEach, describe, expect, it } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-records.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import {
  clearPluginRegistryLoadCache,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import { makeTempDir, resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import { buildMemoryPromptSection, registerMemoryCapability } from "./memory-state.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

function requireMemoryEmbeddingProvider(providerId: string) {
  const provider = getMemoryEmbeddingProvider(providerId);
  if (!provider) {
    throw new Error(`expected ${providerId} memory embedding provider`);
  }
  return provider;
}

function setLoaderMetadataSnapshot(params: { pluginIds?: readonly string[] } = {}) {
  const config: OpenClawConfig = {
    plugins: {
      allow: ["demo"],
      slots: { memory: "none" },
    },
  };
  const env = process.env;
  const workspaceDir = makeTempDir();
  const installRecords: Record<string, PluginInstallRecord> = {
    demo: {
      source: "npm",
      spec: "demo@1.0.0",
      installPath: "/tmp/plugins/demo",
    },
  };
  const metadataSnapshot = createPluginMetadataSnapshot({
    config,
    manifestRegistry: { plugins: [], diagnostics: [] },
    workspaceDir,
  });
  const snapshot = {
    ...metadataSnapshot,
    ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
    index: {
      ...metadataSnapshot.index,
      installRecords,
    },
  };
  setCurrentPluginMetadataSnapshot(snapshot, { config, env, workspaceDir });
  return { config, env, installRecords, snapshot, workspaceDir };
}

describe("resolvePluginLoadCacheContext", () => {
  it("reuses prepared install records from the compatible metadata generation", () => {
    const { config, env, installRecords, workspaceDir } = setLoaderMetadataSnapshot();

    expect(resolvePluginLoadCacheContext({ config, env, workspaceDir }).installRecords).toEqual(
      installRecords,
    );
    expect(resolvePluginLoadCacheContext({ config, workspaceDir }).installRecords).toEqual(
      installRecords,
    );
  });

  it("loads a custom profile's install records instead of reusing the process snapshot", () => {
    const profileEnv = { ...process.env, OPENCLAW_STATE_DIR: makeTempDir() };
    const profileInstallRecords: Record<string, PluginInstallRecord> = {
      demo: {
        source: "npm",
        spec: "demo@2.0.0",
        installPath: "/tmp/plugins/profile-b/demo",
      },
    };
    // Writing an installed index invalidates the current metadata generation,
    // so prepare the custom profile before installing the process snapshot.
    writePersistedInstalledPluginIndexInstallRecordsSync(profileInstallRecords, {
      env: profileEnv,
      candidates: [],
    });
    const { config, env, installRecords, workspaceDir } = setLoaderMetadataSnapshot();

    expect(resolvePluginLoadCacheContext({ config, env, workspaceDir }).installRecords).toEqual(
      installRecords,
    );
    expect(
      resolvePluginLoadCacheContext({ config, env: profileEnv, workspaceDir }).installRecords,
    ).toEqual(profileInstallRecords);
  });

  it("reuses an exact matching scoped metadata generation", () => {
    const { config, env, installRecords, workspaceDir } = setLoaderMetadataSnapshot({
      pluginIds: ["demo"],
    });

    expect(
      resolvePluginLoadCacheContext({
        config,
        env,
        workspaceDir,
        onlyPluginIds: ["demo"],
      }).installRecords,
    ).toEqual(installRecords);
  });

  it("prefers explicitly supplied install records over the current metadata generation", () => {
    const { config, env, workspaceDir } = setLoaderMetadataSnapshot();
    const installRecords: Record<string, PluginInstallRecord> = {
      explicit: {
        source: "npm",
        spec: "explicit@2.0.0",
      },
    };

    expect(
      resolvePluginLoadCacheContext({ config, env, workspaceDir, installRecords }).installRecords,
    ).toEqual(installRecords);
  });

  it("does not reuse install records for a different workspace", () => {
    const { config, env } = setLoaderMetadataSnapshot();

    expect(
      resolvePluginLoadCacheContext({ config, env, workspaceDir: makeTempDir() }).installRecords,
    ).toEqual(loadInstalledPluginIndexInstallRecordsSync({ env }));
  });

  it("does not reuse install records for a different plugin policy", () => {
    const { env, workspaceDir } = setLoaderMetadataSnapshot();

    expect(
      resolvePluginLoadCacheContext({
        config: {
          plugins: {
            allow: ["other"],
            slots: { memory: "none" },
          },
        },
        env,
        workspaceDir,
      }).installRecords,
    ).toEqual(loadInstalledPluginIndexInstallRecordsSync({ env }));
  });

  it("does not reuse install records for an unrelated explicit manifest registry", () => {
    const { config, env, workspaceDir } = setLoaderMetadataSnapshot();

    expect(
      resolvePluginLoadCacheContext({
        config,
        env,
        workspaceDir,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }).installRecords,
    ).toEqual(loadInstalledPluginIndexInstallRecordsSync({ env }));
  });

  it("does not reuse scoped metadata for a different plugin scope", () => {
    const { config, env, workspaceDir } = setLoaderMetadataSnapshot({ pluginIds: ["demo"] });

    expect(
      resolvePluginLoadCacheContext({
        config,
        env,
        workspaceDir,
        onlyPluginIds: ["other"],
      }).installRecords,
    ).toEqual(loadInstalledPluginIndexInstallRecordsSync({ env }));
  });

  it("does not reuse metadata while resolving raw config environment variables", () => {
    const { config, env, workspaceDir } = setLoaderMetadataSnapshot();

    expect(
      resolvePluginLoadCacheContext({
        config,
        env,
        workspaceDir,
        resolveRawConfigEnvVars: true,
      }).installRecords,
    ).toEqual(loadInstalledPluginIndexInstallRecordsSync({ env }));
  });

  it("invalidates prepared install records at the plugin metadata lifecycle boundary", () => {
    const { config, env, installRecords, workspaceDir } = setLoaderMetadataSnapshot();

    expect(resolvePluginLoadCacheContext({ config, env, workspaceDir }).installRecords).toEqual(
      installRecords,
    );

    clearPluginMetadataLifecycleCaches();

    expect(resolvePluginLoadCacheContext({ config, env, workspaceDir }).installRecords).toEqual(
      loadInstalledPluginIndexInstallRecordsSync({ env }),
    );
  });
});

describe("resolveRuntimePluginRegistry", () => {
  it("falls back to the current active runtime when no explicit load context is provided", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(resolveRuntimePluginRegistry()).toBe(registry);
  });
});

describe("clearPluginRegistryLoadCache", () => {
  it("preserves plugin-owned runtime registries while invalidating load snapshots", () => {
    registerMemoryEmbeddingProvider({
      id: "still-live",
      create: async () => ({ provider: null }),
    });
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["still live"],
    });

    clearPluginRegistryLoadCache();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["still live"]);
    expect(requireMemoryEmbeddingProvider("still-live").id).toBe("still-live");
  });

  it("invalidates full-workspace load snapshots", () => {
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const registry = loadOpenClawPlugins(loadOptions);

    clearPluginRegistryLoadCache();

    expect(loadOpenClawPlugins(loadOptions)).not.toBe(registry);
  });
});
