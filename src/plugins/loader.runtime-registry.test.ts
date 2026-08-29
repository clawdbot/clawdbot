// Verifies plugin loader runtime registry behavior.
import fs, { writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import {
  getRegisteredEmbeddingProvider,
  registerEmbeddingProvider,
} from "./embedding-providers.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-records.js";
import { resolvePluginLoadCacheContext } from "./loader-load-context.js";
import * as loaderModule from "./loader-module-runtime.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import {
  clearPluginRegistryLoadCache,
  loadAndActivateRootPluginRegistry,
  loadOpenClawPluginCliRegistry,
  loadOpenClawPlugins,
  loadPluginRegistryHandle,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { buildMemoryPromptSection, registerMemoryCapability } from "./memory-state.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { getPluginRegistryRuntime } from "./registry-runtime-binding.js";
import { createEmptyPluginRegistry } from "./registry.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";
import type { PluginRuntime } from "./runtime/types.js";
import * as sdkAlias from "./sdk-alias.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
});

it("initializes trusted state and executable CLI before resolving the broad runtime", async () => {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const bundledDir = path.join(root, "bundled");
  const observed = path.join(root, "observed.json");
  const plugin = writePlugin({
    id: "state-cli",
    dir: path.join(bundledDir, "state-cli"),
    filename: "index.cjs",
    body: `module.exports = { id: "state-cli", register(api) {
      const sync = api.runtime.state.openSyncKeyedStore({ namespace: "registration", maxEntries: 2 });
      const entries = sync.entries();
      const asyncStore = api.runtime.state.openKeyedStore({ namespace: "registration", maxEntries: 2 });
      require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(entries));
      api.registerCli(({ program }) => program.command("state-proof").action(async () => {
        sync.register("before", { value: "retained" });
        const chunks = api.runtime.channel.text.chunkText("channel runtime works", 100);
        const version = api.runtime.version;
        const row = await asyncStore.lookup("before");
        require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ chunks, version, row }));
      }), { commands: ["state-proof"] });
    } };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "cli-metadata.cjs"),
    'module.exports = require("./index.cjs");',
  );
  await withEnvAsync(
    {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    async () => {
      const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
      let fullRuntime: typeof import("./runtime/index.js") | null = null;
      const createLoader = loaderModule.createPluginModuleLoader;
      const factories = vi.fn(
        (...args: Parameters<typeof import("./runtime/index.js").createPluginRuntime>) =>
          fullRuntime!.createPluginRuntime(...args),
      );
      vi.spyOn(loaderModule, "createPluginModuleLoader").mockImplementation((options) => {
        const load = createLoader(options);
        return (modulePath) => {
          if (modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath) {
            if (!fullRuntime) {
              throw new Error("broad runtime requested before state registration completed");
            }
            return { createPluginRuntime: factories };
          }
          return load(modulePath);
        };
      });
      const hooks = {
        dispatchHookAgentTurn: vi.fn<PluginRuntime["hooks"]["dispatchHookAgentTurn"]>(),
      };
      const dispatchReplyFromConfig =
        vi.fn<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>();
      const config = { plugins: { entries: { [plugin.id]: { enabled: true } } } };
      const metadata = await loadOpenClawPluginCliRegistry({ config, pluginSdkResolution: "src" });
      expect(metadata.plugins).toContainEqual(
        expect.objectContaining({
          id: plugin.id,
          status: "error",
          error: expect.stringContaining('unavailable during "cli-metadata"'),
        }),
      );
      expect(fs.existsSync(observed)).toBe(false);
      expect(resolveRuntime).not.toHaveBeenCalled();
      const registry = loadPluginRegistryHandle({
        config,
        cache: false,
        pluginSdkResolution: "src",
        runtimeOptions: { hooks, dispatchReplyFromConfig },
      });
      expect(registry.plugins).toContainEqual(
        expect.objectContaining({ id: plugin.id, status: "loaded" }),
      );
      expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual([]);
      expect(fs.existsSync(path.join(root, "state", "state", "openclaw.sqlite"))).toBe(false);
      expect(resolveRuntime).not.toHaveBeenCalled();
      const runtime = getPluginRegistryRuntime(registry)!;
      const state = runtime.state;
      const descriptor = Object.getOwnPropertyDescriptor(runtime, "state")!;
      expect(descriptor.get?.()).toBe(state);
      expect(resolveRuntime).not.toHaveBeenCalled();
      const program = new Command();
      await registry.cliRegistrars[0]!.register({
        program,
        parentPath: [],
        config,
        workspaceDir: undefined,
        logger: { info() {}, warn() {}, error() {} },
      });
      expect(resolveRuntime).not.toHaveBeenCalled();
      fullRuntime = await import("./runtime/index.js");
      await program.parseAsync(["state-proof"], { from: "user" });
      expect(JSON.parse(fs.readFileSync(observed, "utf8"))).toEqual({
        chunks: ["channel runtime works"],
        version: expect.any(String),
        row: { value: "retained" },
      });
      expect(resolveRuntime).toHaveBeenCalledTimes(1);
      expect(factories).toHaveBeenCalledTimes(1);
      expect(runtime.state).toBe(state);
      expect(runtime.hooks).toBe(hooks);
      expect(runtime.channel.reply.dispatchReplyFromConfig).toBe(dispatchReplyFromConfig);
      const replacement = { ...state };
      // The existing lazy descriptor is an accessor: Reflect.set with the proxy receiver
      // fails, while its explicit setter replaces the materialized data property.
      expect(Reflect.set(runtime, "state", replacement)).toBe(false);
      descriptor.set?.(replacement);
      expect(descriptor.get?.()).toBe(replacement);
      Object.defineProperty(runtime, "state", {
        configurable: true,
        get(this: unknown) {
          if (this === null || this === undefined) {
            return this;
          }
          return this === runtime ? state : replacement;
        },
      });
      expect(runtime.state).toBe(state);
      expect(descriptor.get?.()).toBe(replacement);
      expect.soft(Reflect.get(runtime, "state", null), "explicit null receiver").toBeNull();
      expect
        .soft(Reflect.get(runtime, "state", undefined), "explicit undefined receiver")
        .toBeUndefined();
      Reflect.deleteProperty(runtime, "state");
      expect(runtime.state).toBeUndefined();
      expect(descriptor.get?.()).toBeUndefined();
      expect(resolveRuntime).toHaveBeenCalledTimes(1);
    },
  );
});

it("keeps an empty scoped handle load from replacing the root registry", () => {
  const root = loadAndActivateRootPluginRegistry({ cache: false, config: {} });
  const handle = loadPluginRegistryHandle({ cache: false, config: {}, onlyPluginIds: [] });

  expect(handle).not.toBe(root);
  expect(getActivePluginRegistry()).toBe(root);
});

it("keeps injected instance runtime surfaces independent of the broad runtime module", () => {
  const gateway = {} as PluginRuntime["gateway"];
  const nodes = {} as PluginRuntime["nodes"];
  const subagent = {} as PluginRuntime["subagent"];
  const loadPluginModule = vi.fn((_modulePath: string): unknown => {
    throw new Error("broad runtime should stay lazy");
  });
  const runtime = createLazyPluginRuntime({
    loadPluginModule,
    runtimeOptions: { gateway, nodes, subagent },
  });

  expect(runtime.gateway).toBe(gateway);
  expect(runtime.nodes).toBe(nodes);
  expect(runtime.subagent).toBe(subagent);
  expect(loadPluginModule).not.toHaveBeenCalled();
});

describe("cached plugin load failures", () => {
  it.each([
    { name: "active root registry", load: loadAndActivateRootPluginRegistry, activates: true },
    { name: "non-activating registry handle", load: loadPluginRegistryHandle, activates: false },
  ])("enforces strict errors for a cached $name before activation", ({ load, activates }) => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-load-failure",
      body: 'module.exports = { id: "cached-load-failure", register() { throw new Error("cached registration failed"); } };',
    });
    const options = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      },
    };
    const cached = load(options);
    expect(cached.plugins).toContainEqual(
      expect.objectContaining({ id: plugin.id, status: "error" }),
    );

    const active = createEmptyPluginRegistry();
    // Staging preserves the cached generation until a successor commits its retirement.
    stageActivePluginRegistry(active, "existing-registry", "default");

    expect(() => load({ ...options, throwOnLoadError: true })).toThrow(
      "cached registration failed",
    );
    expect(getActivePluginRegistry()).toBe(active);
    expect(load(options)).toBe(cached);
    expect(getActivePluginRegistry()).toBe(activates ? cached : active);
  });

  it("continues to reuse healthy cached registries for strict loads", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "cached-load-healthy",
      body: 'module.exports = { id: "cached-load-healthy", register() {} };',
    });
    const options = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      },
    };
    const cached = loadPluginRegistryHandle(options);

    expect(loadPluginRegistryHandle({ ...options, throwOnLoadError: true })).toBe(cached);
  });
});

function requireMemoryEmbeddingProvider(providerId: string) {
  const provider = getRegisteredEmbeddingProvider(providerId)?.adapter;
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
  const workspaceDir = makePluginLoaderTempDir();
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
  it("partitions process-HOME catalog registration policy", () => {
    const processHomeKey = resolvePluginLoadCacheContext({
      allowProcessHomeSessionCatalogs: true,
    }).cacheKey;
    const isolatedKey = resolvePluginLoadCacheContext({
      allowProcessHomeSessionCatalogs: false,
    }).cacheKey;

    expect(isolatedKey).not.toBe(processHomeKey);
  });

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
    const profileEnv = { ...process.env, OPENCLAW_STATE_DIR: makePluginLoaderTempDir() };
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
      resolvePluginLoadCacheContext({ config, env, workspaceDir: makePluginLoaderTempDir() })
        .installRecords,
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
  it.each(["clear", "replacement"])(
    "rebuilds plugin registrations after runtime %s with unchanged load options",
    async (retirement) => {
      useNoBundledPlugins();
      const plugin = writePlugin({
        id: "retirement-probe",
        body: `module.exports = {
          id: "retirement-probe",
          register(api) {
            let closed = false;
            api.registerRuntimeLifecycle({ id: "close", cleanup() { closed = true; } });
            api.registerTool({
              name: "retirement_probe", description: "Read fixture lifetime",
              parameters: { type: "object", properties: {} },
              execute() { return { content: [{ type: "text", text: closed ? "closed" : "live" }] }; },
            });
          },
        };`,
      });
      writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: plugin.id,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
          contracts: { tools: ["retirement_probe"] },
        }),
      );
      const options = {
        config: {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            slots: { memory: "none" },
          },
        },
      };
      const read = async (registry: ReturnType<typeof loadOpenClawPlugins>) => {
        const tool = registry.tools[0]!.factory({ config: options.config });
        if (!tool || Array.isArray(tool)) {
          throw new Error("expected one lifetime probe tool");
        }
        return await tool.execute("probe", {});
      };
      const original = loadOpenClawPlugins(options);
      expect(loadOpenClawPlugins(options)).toBe(original);
      expect(await read(original)).toMatchObject({ content: [{ text: "live" }] });

      if (retirement === "clear") {
        await clearActivePluginRegistry();
      } else {
        const replacementOptions = { ...options, workspaceDir: makePluginLoaderTempDir() };
        const replacement = loadOpenClawPlugins(replacementOptions);
        expect(replacement).not.toBe(original);
        expect(await read(replacement)).toMatchObject({ content: [{ text: "live" }] });
        await vi.waitFor(async () => {
          expect(await read(original)).toMatchObject({ content: [{ text: "closed" }] });
        });
        expect(loadOpenClawPlugins(replacementOptions)).toBe(replacement);
      }

      expect(await read(original)).toMatchObject({ content: [{ text: "closed" }] });
      const reloaded = loadOpenClawPlugins(options);
      expect(await read(reloaded)).toMatchObject({ content: [{ text: "live" }] });
      expect(reloaded).not.toBe(original);
      expect(loadOpenClawPlugins(options)).toBe(reloaded);
    },
  );

  it("preserves plugin-owned runtime registries while invalidating load snapshots", () => {
    registerEmbeddingProvider({
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
