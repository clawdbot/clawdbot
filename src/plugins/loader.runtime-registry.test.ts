// Verifies plugin loader runtime registry behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCompactionProvider, registerCompactionProvider } from "./compaction-provider.js";
import { getEmbeddingProvider, registerEmbeddingProvider } from "./embedding-providers.js";
import {
  testing,
  clearPluginLoaderCache,
  clearPluginRegistryLoadCache,
  loadOpenClawPlugins,
  resolveRuntimePluginRegistry,
} from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptSupplement,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import type { PluginRecord } from "./registry-types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import type { CreatePluginRuntimeOptions } from "./runtime/index.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

function createLoadedPluginRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: "test",
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

function requireMemoryRuntime() {
  const runtime = getMemoryRuntime();
  if (!runtime) {
    throw new Error("expected memory runtime registration");
  }
  return runtime;
}

function requireMemoryEmbeddingProvider(providerId: string) {
  const provider = getMemoryEmbeddingProvider(providerId);
  if (!provider) {
    throw new Error(`expected ${providerId} memory embedding provider`);
  }
  return provider;
}

function makeOpenClawDevSourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-loader-dev-source-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }), "utf-8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "extensions"), { recursive: true });
  return root;
}

describe("getCompatibleActivePluginRegistry", () => {
  it("reuses the active registry only when the load context cache key matches", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBeUndefined();
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: [],
      }),
    ).toBeUndefined();
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: undefined,
      }),
    ).toBe(registry);
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: {
          subagent: {} as CreatePluginRuntimeOptions["subagent"],
        },
      }),
    ).toBeUndefined();
  });

  it("does not treat a default-mode active registry as compatible with gateway binding", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    ).toBeUndefined();
  });

  it("reuses an active full registry for compatible tool-discovery loads", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        activate: false,
        toolDiscovery: true,
      }),
    ).toBe(registry);
  });

  it("reuses an active wider registry for compatible scoped runtime loads", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createLoadedPluginRecord("demo"), createLoadedPluginRecord("other"));
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo", "other"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBe(registry);
  });

  it("does not reuse a wider registry for scoped loads when the load context changes", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createLoadedPluginRecord("demo"), createLoadedPluginRecord("other"));
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo", "other"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        config: {
          plugins: {
            allow: ["demo"],
            load: { paths: ["/tmp/changed.js"] },
          },
        },
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["missing"],
      }),
    ).toBeUndefined();
  });

  it("does not reuse a default-mode active registry for gateway-bindable tool discovery", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        activate: false,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
        toolDiscovery: true,
      }),
    ).toBeUndefined();
  });

  it("does not embed activation secrets in the loader cache key", () => {
    const { cacheKey } = testing.resolvePluginLoadCacheContext({
      config: {
        plugins: {
          allow: ["telegram"],
        },
      },
      activationSourceConfig: {
        plugins: {
          allow: ["telegram"],
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: "secret-token",
          },
        },
      },
      autoEnabledReasons: {
        telegram: ["telegram configured"],
      },
    });

    expect(cacheKey).not.toContain("secret-token");
    expect(cacheKey).not.toContain("botToken");
    expect(cacheKey).not.toContain("telegram configured");
  });

  it("separates dev source root precedence in the loader cache key", () => {
    const devSourceRoot = makeOpenClawDevSourceRoot();
    try {
      const baseOptions = {
        config: {
          plugins: {
            allow: ["demo"],
            load: { paths: ["/tmp/demo.js"] },
          },
        },
        env: { ...process.env, OPENCLAW_DEV_SOURCE_ROOT: undefined },
      };

      const base = testing.resolvePluginLoadCacheContext(baseOptions).cacheKey;
      const dev = testing.resolvePluginLoadCacheContext({
        ...baseOptions,
        env: { ...process.env, OPENCLAW_DEV_SOURCE_ROOT: devSourceRoot },
      }).cacheKey;

      expect(dev).not.toBe(base);
    } finally {
      fs.rmSync(devSourceRoot, { recursive: true, force: true });
    }
  });

  it("separates raw env substitution mode in the loader cache key", () => {
    const baseOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          entries: {
            demo: { config: { apiKey: "${DEMO_KEY}" } },
          },
        },
      },
    };

    const plain = testing.resolvePluginLoadCacheContext(baseOptions).cacheKey;
    const resolving = testing.resolvePluginLoadCacheContext({
      ...baseOptions,
      resolveRawConfigEnvVars: true,
    }).cacheKey;

    expect(resolving).not.toBe(plain);
  });

  it("does not embed raw resolved plugin config env values in the loader cache key", () => {
    const { cacheKey } = testing.resolvePluginLoadCacheContext({
      config: {
        plugins: {
          allow: ["demo"],
          entries: {
            demo: { config: { apiKey: "${DEMO_KEY}" } },
          },
        },
      },
      env: { ...process.env, DEMO_KEY: "resolved-demo-secret" },
      resolveRawConfigEnvVars: true,
    });

    expect(cacheKey).not.toContain("resolved-demo-secret");
    expect(cacheKey).not.toContain("apiKey");
  });

  it("falls back to the current active runtime when no compatibility-shaping inputs are supplied", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(testing.getCompatibleActivePluginRegistry()).toBe(registry);
  });

  it("does not reuse the active registry when core gateway method names differ", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
      coreGatewayHandlers: {
        "sessions.get": () => undefined,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        coreGatewayHandlers: {
          "sessions.get": () => undefined,
          "sessions.list": () => undefined,
        },
      }),
    ).toBeUndefined();
  });

  it("reuses a scoped gateway-bindable registry for a matching default-mode tool scope", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    ).toBe(registry);
  });

  it("reuses a scoped gateway-bindable registry for a matching snapshot-mode tool scope", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
        activate: false,
      }),
    ).toBe(registry);
  });

  it("does not reuse a scoped registry when the requested tool scope needs another plugin", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram", "tavily"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram", "tavily"],
      }),
    ).toBeUndefined();
  });

  it("does not treat an unscoped request as compatible with the scoped startup registry", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram", "tavily"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
      }),
    ).toBeUndefined();
  });

  it("does not reuse a scoped gateway-bindable registry for an explicit subagent request", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        runtimeOptions: {
          subagent: {} as CreatePluginRuntimeOptions["subagent"],
        },
      }),
    ).toBeUndefined();
  });

  it("reuses a scoped startup registry when only the request omits gateway methods", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    registry.coreGatewayMethodNames = ["sessions.get", "sessions.list"];
    const config = {
      plugins: {
        allow: ["acpx", "telegram"],
      },
    };
    const startupOptions = {
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
      }),
    ).toBe(registry);
  });

  it("reuses a scoped gateway startup registry when dispatch omits built artifact preference", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "acpx" } as (typeof registry.plugins)[number],
      { id: "telegram" } as (typeof registry.plugins)[number],
    );
    registry.coreGatewayMethodNames = ["sessions.get", "sessions.list"];
    const config = {
      plugins: {
        allow: ["acpx", "telegram"],
      },
    };
    const startupOptions = {
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
      preferBuiltPluginArtifacts: true,
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      testing.getCompatibleActivePluginRegistry({
        config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    ).toBe(registry);

    expect(
      testing.getCompatibleActivePluginRegistry({
        config: {
          plugins: {
            allow: ["acpx", "telegram"],
            load: { paths: ["/tmp/changed.js"] },
          },
        },
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      }),
    ).toBeUndefined();
  });
});

describe("resolveRuntimePluginRegistry", () => {
  it("reuses the compatible active registry before attempting a fresh load", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(resolveRuntimePluginRegistry(loadOptions)).toBe(registry);
  });

  it("falls back to the current active runtime when no explicit load context is provided", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(resolveRuntimePluginRegistry()).toBe(registry);
  });

  it("does not treat an explicit empty plugin scope as the active runtime", () => {
    const registry = createEmptyPluginRegistry();
    const loadOptions = {
      config: {
        plugins: {
          allow: ["demo"],
          load: { paths: ["/tmp/demo.js"] },
        },
      },
      workspaceDir: "/tmp/workspace-a",
    };
    const { cacheKey } = testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    const scopedEmpty = resolveRuntimePluginRegistry({ ...loadOptions, onlyPluginIds: [] });
    expect(scopedEmpty).not.toBe(registry);
    expect(scopedEmpty?.plugins).toStrictEqual([]);
  });

  it("keeps the full workspace registry warm when scoped cron registries churn", () => {
    testing.setMaxPluginRegistryCacheEntriesForTest(2);
    try {
      const loadOptions = {
        config: {
          plugins: {
            allow: ["alpha", "bravo", "charlie"],
          },
        },
        workspaceDir: "/tmp/workspace-a",
      };
      const fullRegistry = loadOpenClawPlugins(loadOptions);

      loadOpenClawPlugins({ ...loadOptions, onlyPluginIds: ["alpha"] });
      loadOpenClawPlugins({ ...loadOptions, onlyPluginIds: ["bravo"] });

      expect(resolveRuntimePluginRegistry(loadOptions)).toBe(fullRegistry);
    } finally {
      testing.setMaxPluginRegistryCacheEntriesForTest();
    }
  });
});

describe("clearPluginLoaderCache", () => {
  it("resets registered memory plugin registries", () => {
    registerEmbeddingProvider({
      id: "stale-embedding",
      create: async () => ({ provider: null }),
    });
    registerMemoryEmbeddingProvider({
      id: "stale",
      create: async () => ({ provider: null }),
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => null,
    });
    registerMemoryPromptSupplement("memory-wiki", () => ["stale wiki supplement"]);
    registerMemoryCapability("memory-core", {
      promptBuilder: () => ["stale memory section"],
      flushPlanResolver: () => ({
        softThresholdTokens: 1,
        forceFlushTranscriptBytes: 2,
        reserveTokensFloor: 3,
        prompt: "stale",
        systemPrompt: "stale",
        relativePath: "memory/stale.md",
      }),
      runtime: {
        async getMemorySearchManager() {
          return { manager: null };
        },
        resolveMemoryBackendConfig() {
          return { backend: "builtin" as const };
        },
      },
    });
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "stale memory section",
      "stale wiki supplement",
    ]);
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/stale.md");
    expect(
      requireMemoryRuntime().resolveMemoryBackendConfig({ cfg: {} as never, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
    expect(getEmbeddingProvider("stale-embedding")?.id).toBe("stale-embedding");
    expect(requireMemoryEmbeddingProvider("stale").id).toBe("stale");

    clearPluginLoaderCache();

    expect(getEmbeddingProvider("stale-embedding")).toBeUndefined();
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toStrictEqual([]);
    expect(listMemoryCorpusSupplements()).toStrictEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeUndefined();
  });
});

describe("loadOpenClawPlugins active runtime clearing", () => {
  it("clears plugin-owned global providers before activating a new registry", () => {
    registerEmbeddingProvider({
      id: "stale-embedding",
      create: async () => ({ provider: null }),
    });
    registerCompactionProvider({
      id: "stale-compaction",
      label: "Stale Compaction",
      summarize: async () => "stale",
    });
    registerMemoryEmbeddingProvider({
      id: "stale-memory",
      create: async () => ({ provider: null }),
    });

    loadOpenClawPlugins({ onlyPluginIds: [] });

    expect(getEmbeddingProvider("stale-embedding")).toBeUndefined();
    expect(getCompactionProvider("stale-compaction")).toBeUndefined();
    expect(getMemoryEmbeddingProvider("stale-memory")).toBeUndefined();
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
