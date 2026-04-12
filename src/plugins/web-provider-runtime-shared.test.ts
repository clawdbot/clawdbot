import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  resolveRuntimePluginRegistry: vi.fn(),
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
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", () => ({
  buildPluginRuntimeLoadOptionsFromValues: mocks.buildPluginRuntimeLoadOptionsFromValues,
  createPluginRuntimeLoaderLogger: mocks.createPluginRuntimeLoaderLogger,
}));

let createWebProviderSnapshotCache: typeof import("./web-provider-runtime-shared.js").createWebProviderSnapshotCache;
let resolvePluginWebProviders: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProviders;
let resolveRuntimeWebProviders: typeof import("./web-provider-runtime-shared.js").resolveRuntimeWebProviders;

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ createWebProviderSnapshotCache, resolvePluginWebProviders, resolveRuntimeWebProviders } =
      await import("./web-provider-runtime-shared.js"));
  });

  beforeEach(() => {
    mocks.isPluginRegistryLoadInFlight.mockReset();
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
    mocks.loadOpenClawPlugins.mockReset();
    mocks.resolveCompatibleRuntimePluginRegistry.mockReset();
    mocks.resolveRuntimePluginRegistry.mockReset();
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
    mocks.resolveCompatibleRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveCompatibleRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("preserves explicit empty scopes in direct runtime web provider resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.resolveRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        config: {},
        onlyPluginIds: [],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => [],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: [],
      }),
    );
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.resolveRuntimePluginRegistry.mockReturnValue({} as never);

    resolveRuntimeWebProviders(
      {
        onlyPluginIds: ["alpha"],
      },
      {
        snapshotCache: createWebProviderSnapshotCache(),
        resolveBundledResolutionConfig: () => ({
          config: {},
          activationSourceConfig: {},
          autoEnabledReasons: {},
        }),
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      },
    );

    expect(mocks.resolveRuntimePluginRegistry).toHaveBeenCalledWith(undefined);
    expect(mapRegistryProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["alpha"],
      }),
    );
  });
});
