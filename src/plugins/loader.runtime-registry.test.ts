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
  loadAndActivateRootPluginRegistry,
  loadOpenClawPlugins,
  loadPluginRegistryHandle,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import { makeTempDir, resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getRegisteredMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import { buildMemoryPromptSection, registerMemoryCapability } from "./memory-state.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

it("keeps an empty scoped handle load from replacing the root registry", () => {
  const root = loadAndActivateRootPluginRegistry({ cache: false, config: {} });
  const handle = loadPluginRegistryHandle({ cache: false, config: {}, onlyPluginIds: [] });

  expect(handle).not.toBe(root);
  expect(getActivePluginRegistry()).toBe(root);
});

function requireMemoryEmbeddingProvider(providerId: string) {
  const provider = getRegisteredMemoryEmbeddingProvider(providerId)?.adapter;
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
  it("partitions full and setup channel plugin load intent", () => {
    const fullKey = resolvePluginLoadCacheContext({ config: {} }).cacheKey;
    const setupKey = resolvePluginLoadCacheContext({
      config: {},
      channelPluginLoadIntent: "setup",
    }).cacheKey;

    expect(setupKey).not.toBe(fullKey);
    expect(resolvePluginLoadCacheContext({ config: {} }).channelPluginLoadIntent).toBe("full");
  });

  it("keys concrete runtime bindings by identity", () => {
    const firstNodes = {} as PluginRuntime["nodes"];
    const firstSubagent = {} as PluginRuntime["subagent"];
    const firstOptions = {
      config: {},
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
        nodes: firstNodes,
        subagent: firstSubagent,
      },
    };
    const firstKey = resolvePluginLoadCacheContext(firstOptions).cacheKey;

    expect(resolvePluginLoadCacheContext(firstOptions).cacheKey).toBe(firstKey);
    expect(
      resolvePluginLoadCacheContext({
        ...firstOptions,
        runtimeOptions: {
          ...firstOptions.runtimeOptions,
          nodes: {} as PluginRuntime["nodes"],
          subagent: {} as PluginRuntime["subagent"],
        },
      }).cacheKey,
    ).not.toBe(firstKey);
  });

  it("reuses prepared install records from the compatible metadata generation", () => {
    const { config, env, installRecords, snapshot, workspaceDir } = setLoaderMetadataSnapshot();

    for (const options of [
      { config, env, workspaceDir },
      { config, workspaceDir },
    ]) {
      const context = resolvePluginLoadCacheContext(options);

      expect(context.installRecords).toEqual(installRecords);
      expect(context.metadataSnapshot).toBe(snapshot);
    }
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
    const profileContext = resolvePluginLoadCacheContext({
      config,
      env: profileEnv,
      workspaceDir,
    });

    expect(profileContext.installRecords).toEqual(profileInstallRecords);
    expect(profileContext.metadataSnapshot).toBeUndefined();
  });

  it("does not reuse metadata when the activation source adds plugin load paths", () => {
    const { config, env, workspaceDir } = setLoaderMetadataSnapshot();
    const activationSourceConfig: OpenClawConfig = {
      plugins: {
        ...config.plugins,
        load: { paths: ["/plugins/activation-source-only"] },
      },
    };

    const context = resolvePluginLoadCacheContext({
      activationSourceConfig,
      config,
      env,
      workspaceDir,
    });

    expect(context.normalized.loadPaths).toContain("/plugins/activation-source-only");
    expect(context.metadataSnapshot).toBeUndefined();
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
