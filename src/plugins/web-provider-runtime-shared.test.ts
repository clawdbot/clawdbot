import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  getLoadedRuntimePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn<() => Record<string, unknown> | null>(() => null),
  getActivePluginRegistryWorkspaceDir: vi.fn(() => undefined),
  buildPluginRuntimeLoadOptionsFromValues: vi.fn(
    (_values: unknown, overrides?: Record<string, unknown>) => ({
      ...overrides,
    }),
  ),
  createPluginRuntimeLoaderLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock("./loader.js", () => ({
  isPluginRegistryLoadInFlight: mocks.isPluginRegistryLoadInFlight,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./active-runtime-registry.js", () => ({
  getLoadedRuntimePluginRegistry: mocks.getLoadedRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptionsFromValues: mocks.buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger: mocks.createPluginRuntimeLoaderLogger,
}));

let resolvePluginWebProviders: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProviders;
let resolveRuntimeWebProviders: typeof import("./web-provider-runtime-shared.js").resolveRuntimeWebProviders;

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function mockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ resolvePluginWebProviders, resolveRuntimeWebProviders } =
      await import("./web-provider-runtime-shared.js"));
  });

  beforeEach(() => {
    mocks.isPluginRegistryLoadInFlight.mockReset();
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReset();
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockReset();
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.resolveRuntimePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReset();
    mocks.getActivePluginRegistry.mockReturnValue(null);
    mocks.getActivePluginRegistryWorkspaceDir.mockReset();
    mocks.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    mocks.buildPluginRuntimeLoadOptionsFromValues.mockReset();
    mocks.buildPluginRuntimeLoadOptionsFromValues.mockImplementation(
      (_values: unknown, overrides?: Record<string, unknown>) => ({
        ...overrides,
      }),
    );
  });

  it("preserves explicit empty scopes in runtime-compatible web provider loads", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual([]);
  });

  it("preserves explicit empty scopes in direct runtime web provider resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual([]);
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        onlyPluginIds: ["alpha"],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      },
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["alpha"]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual(["alpha"]);
  });

  it("reuses the active registry after deriving web provider candidates from resolved config", () => {
    const activeRegistry = { source: "active" };
    const resolvedConfig = { plugins: { entries: { brave: { enabled: true } } } };
    const resolveCandidatePluginIds = vi.fn(() => ["brave"]);
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);

    const providers = resolvePluginWebProviders(
      {
        config: { plugins: { entries: {} } },
        env: { BRAVE_API_KEY: "key" },
        onlyPluginIds: ["brave", "firecrawl"],
        origin: "bundled",
        workspaceDir: "/workspace",
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: resolvedConfig,
          activationSourceConfig: { plugins: { entries: {} } },
          autoEnabledReasons: { brave: ["env"] },
        }),
        resolveCandidatePluginIds,
        mapRegistryProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveCandidatePluginIds).toHaveBeenCalledWith({
      config: resolvedConfig,
      workspaceDir: "/workspace",
      env: { BRAVE_API_KEY: "key" },
      onlyPluginIds: ["brave", "firecrawl"],
      origin: "bundled",
    });
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: ["brave"],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("preserves explicit empty candidate scopes when reusing the active registry", () => {
    const activeRegistry = { source: "active" };
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: [],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("uses loaded runtime web providers without runtime plugin loads", () => {
    const loadedRegistry = { source: "loaded" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(loadedRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: ["brave"],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["brave"],
        mapRegistryProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("ignores runtime web provider cache opt-outs after startup loading", () => {
    const loadedRegistry = { source: "loaded" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(loadedRegistry as never);

    resolvePluginWebProviders(
      {
        cache: false,
        config: {},
        onlyPluginIds: ["brave"],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["brave"],
        mapRegistryProviders,
      },
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("caches setup web provider plugin loads by default", () => {
    const loadedRegistry = { source: "setup" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        mode: "setup",
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["brave"],
        mapRegistryProviders,
        resolveBundledPublicArtifactProviders: () => null,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(mockArg(mocks.loadOpenClawPlugins).cache).toBe(true);
    expect(mockArg(mocks.loadOpenClawPlugins).onlyPluginIds).toEqual(["brave"]);
  });

  it("falls back to a scoped provider load when the active runtime registry has no web providers", () => {
    const activeRegistry = { source: "active" };
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === fallbackRegistry ? ["brave"] : [],
    );
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      },
    );

    expect(result).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledTimes(2);
  });

  it("does not fall back when the active runtime registry returns empty under an explicit empty scope", () => {
    const activeRegistry = { source: "active" };
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(result).toStrictEqual([]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("falls back when the direct runtime registry has no web providers", () => {
    const activeRegistry = { source: "active" };
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === fallbackRegistry ? ["brave"] : [],
    );
    mocks.getLoadedRuntimePluginRegistry.mockImplementation((args: unknown) => {
      const requiredPluginIds = (args as { requiredPluginIds?: readonly string[] })
        ?.requiredPluginIds;
      if (requiredPluginIds === undefined) {
        return activeRegistry as never;
      }
      return undefined;
    });
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const result = resolveRuntimeWebProviders(
      {
        config: {},
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      },
    );

    expect(result).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when direct runtime registry returns empty under an explicit empty scope", () => {
    const activeRegistry = { source: "active" };
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);

    const result = resolveRuntimeWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(result).toStrictEqual([]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("keeps explicit setup web provider cache opt-outs", () => {
    const loadedRegistry = { source: "setup" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry as never);

    resolvePluginWebProviders(
      {
        cache: false,
        config: {},
        mode: "setup",
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["brave"],
        mapRegistryProviders,
        resolveBundledPublicArtifactProviders: () => null,
      },
    );

    expect(mockArg(mocks.loadOpenClawPlugins).cache).toBe(false);
    expect(mockArg(mocks.loadOpenClawPlugins).onlyPluginIds).toEqual(["brave"]);
  });
});
