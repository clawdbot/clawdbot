import { afterEach, describe, expect, it } from "vitest";
import { __testing, clearPluginLoaderCache, resolveRuntimePluginRegistry } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import {
  getMemoryEmbeddingProvider,
  registerMemoryEmbeddingProvider,
} from "./memory-embedding-providers.js";
import {
  buildMemoryPromptSection,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  registerMemoryCorpusSupplement,
  registerMemoryFlushPlanResolver,
  registerMemoryPromptSupplement,
  registerMemoryPromptSection,
  registerMemoryRuntime,
  resolveMemoryFlushPlan,
} from "./memory-state.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { setActivePluginRegistry } from "./runtime.js";
import type { CreatePluginRuntimeOptions } from "./runtime/index.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

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
    registerMemoryPromptSection(() => ["stale memory section"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["stale wiki supplement"]);
    registerMemoryFlushPlanResolver(() => ({
      softThresholdTokens: 1,
      forceFlushTranscriptBytes: 2,
      reserveTokensFloor: 3,
      prompt: "stale",
      systemPrompt: "stale",
      relativePath: "memory/stale.md",
    }));
    registerMemoryRuntime({
      async getMemorySearchManager() {
        return { manager: null };
      },
      resolveMemoryBackendConfig() {
        return { backend: "builtin" as const };
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
