// Covers shared web provider runtime helpers.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";

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

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ resolvePluginWebProviders } = await import("./web-provider-runtime-shared.js"));
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

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: [],
    });
    expect(result).toStrictEqual([]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
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

  it("resolves provider candidates from the original config and prepared manifests", () => {
    const activeRegistry = { source: "active" };
    const config = { plugins: { entries: {} } };
    const resolvedConfig = { plugins: { entries: { brave: { enabled: true } } } };
    const manifestRecords: PluginManifestRecord[] = [];
    const resolveCandidatePluginIds = vi.fn(() => ["brave"]);
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);

    const providers = resolvePluginWebProviders(
      {
        config,
        env: { BRAVE_API_KEY: "key" },
        onlyPluginIds: ["brave", "firecrawl"],
        origin: "bundled",
        sandboxed: true,
        workspaceDir: "/workspace",
        manifestRecords,
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: resolvedConfig,
          activationSourceConfig: config,
          autoEnabledReasons: { brave: ["env"] },
          manifestRecords,
        }),
        resolveCandidatePluginIds,
        mapRegistryProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveCandidatePluginIds).toHaveBeenCalledWith({
      config,
      workspaceDir: "/workspace",
      env: { BRAVE_API_KEY: "key" },
      onlyPluginIds: ["brave", "firecrawl"],
      origin: "bundled",
      sandboxed: true,
      manifestRecords,
    });
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: ["brave"],
    });
    expect(mockArg(mocks.buildPluginRuntimeLoadOptionsFromValues).manifestRegistry).toEqual({
      plugins: manifestRecords,
      diagnostics: [],
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

  it("uses bundled runtime artifacts before loading a plugin registry", () => {
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => ["provider"]);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        workspaceDir: "/workspace",
        env: { FIRECRAWL_API_KEY: "" },
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["firecrawl"],
        mapRegistryProviders: vi.fn(() => []),
        resolveBundledRuntimeArtifactProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/workspace",
      env: { FIRECRAWL_API_KEY: "" },
      onlyPluginIds: ["firecrawl"],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("falls back to plugin loading when bundled runtime artifacts do not cover the scope", () => {
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => null);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["external-provider"],
        mapRegistryProviders,
        resolveBundledRuntimeArtifactProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: fallbackRegistry,
      onlyPluginIds: ["external-provider"],
    });
  });

  it("loads the plugin registry when runtime activation is explicitly requested", () => {
    const fallbackRegistry = { source: "activated" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => ["artifact-provider"]);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        activate: true,
        config: {},
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["firecrawl"],
        mapRegistryProviders,
        resolveBundledRuntimeArtifactProviders,
      },
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).not.toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mockArg(mocks.loadOpenClawPlugins).activate).toBe(true);
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

  it("does not treat an active registry missing declared candidates as authoritative", () => {
    // Regression: an active registry with SOME web providers used to win even when a
    // manifest-declared candidate (npm-installed Brave with BRAVE_API_KEY set) was
    // absent from it, so env-var auto-detect could never see the installed provider.
    const activeRegistry = { source: "active" };
    const scopedRegistry = { source: "scoped" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === scopedRegistry ? ["brave", "grok"] : ["grok"],
    );
    mocks.getLoadedRuntimePluginRegistry.mockImplementation((args: unknown) => {
      const requiredPluginIds = (args as { requiredPluginIds?: readonly string[] })
        ?.requiredPluginIds;
      // Simulate active-registry coverage: brave never loaded at startup.
      if (requiredPluginIds?.includes("brave")) {
        return undefined;
      }
      return activeRegistry as never;
    });
    mocks.loadOpenClawPlugins.mockReturnValue(scopedRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
        env: { BRAVE_API_KEY: "key" } as never,
      },
      {
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["brave", "xai"],
        mapRegistryProviders,
      },
    );

    expect(result).toEqual(["brave", "grok"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
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
