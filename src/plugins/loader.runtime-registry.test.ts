import { afterEach, describe, expect, it } from "vitest";
import { getCompactionProvider, registerCompactionProvider } from "./compaction-provider.js";
import {
  __testing,
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
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        onlyPluginIds: [],
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        runtimeOptions: undefined,
      }),
    ).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
        ...loadOptions,
        workspaceDir: "/tmp/workspace-b",
        onlyPluginIds: ["demo"],
      }),
    ).toBeUndefined();
    expect(
      __testing.getCompatibleActivePluginRegistry({
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
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey, "default");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext({
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

  it("falls back to the current active runtime when no compatibility-shaping inputs are supplied", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry, "startup-registry");

    expect(__testing.getCompatibleActivePluginRegistry()).toBe(registry);
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    expect(__testing.getCompatibleActivePluginRegistry(loadOptions)).toBe(registry);
    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
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
    const startupOptions = {
      config: {
        plugins: {
          allow: ["acpx", "telegram"],
        },
      },
      workspaceDir: "/tmp/workspace-a",
      onlyPluginIds: ["acpx", "telegram"],
      coreGatewayMethodNames: ["sessions.get", "sessions.list"],
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    };
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(startupOptions);
    setActivePluginRegistry(registry, cacheKey, "gateway-bindable");

    expect(
      __testing.getCompatibleActivePluginRegistry({
        config: startupOptions.config,
        workspaceDir: "/tmp/workspace-a",
        onlyPluginIds: ["acpx", "telegram"],
      }),
    ).toBe(registry);
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
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
    const { cacheKey } = __testing.resolvePluginLoadCacheContext(loadOptions);
    setActivePluginRegistry(registry, cacheKey);

    const scopedEmpty = resolveRuntimePluginRegistry({ ...loadOptions, onlyPluginIds: [] });
    expect(scopedEmpty).not.toBe(registry);
    expect(scopedEmpty?.plugins).toEqual([]);
  });

  it("keeps the full workspace registry warm when scoped cron registries churn", () => {
    __testing.setMaxPluginRegistryCacheEntriesForTest(2);
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
      __testing.setMaxPluginRegistryCacheEntriesForTest();
    }
  });
});

describe("clearPluginLoaderCache", () => {
  it("resets registered memory plugin registries", () => {
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
    expect(getMemoryRuntime()).toBeDefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeDefined();

    clearPluginLoaderCache();

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([]);
    expect(listMemoryCorpusSupplements()).toEqual([]);
    expect(resolveMemoryFlushPlan({})).toBeNull();
    expect(getMemoryRuntime()).toBeUndefined();
    expect(getMemoryEmbeddingProvider("stale")).toBeUndefined();
  });
});

describe("loadOpenClawPlugins active runtime clearing", () => {
  it("clears plugin-owned global providers before activating a new registry", () => {
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
    expect(getMemoryEmbeddingProvider("still-live")).toBeDefined();
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
