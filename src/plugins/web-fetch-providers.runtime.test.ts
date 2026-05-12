import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";

type LoaderModule = typeof import("./loader.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebFetchProvidersRuntimeModule = typeof import("./web-fetch-providers.runtime.js");
type WebFetchProvidersSharedModule = typeof import("./web-fetch-providers.shared.js");

let loaderModule: LoaderModule;
let manifestRegistryModule: ManifestRegistryModule;
let webFetchProvidersSharedModule: WebFetchProvidersSharedModule;
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resetPluginRuntimeStateForTest: RuntimeModule["resetPluginRuntimeStateForTest"];
let resolvePluginWebFetchProviders: WebFetchProvidersRuntimeModule["resolvePluginWebFetchProviders"];

const DEFAULT_WORKSPACE = "/tmp/workspace";

function createWebFetchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createFirecrawlAllowConfig() {
  return {
    plugins: {
      allow: ["firecrawl"],
    },
  };
}

function createManifestRegistryFixture() {
  return {
    plugins: [
      {
        id: "firecrawl",
        origin: "bundled",
        rootDir: "/tmp/firecrawl",
        source: "/tmp/firecrawl/index.js",
        manifestPath: "/tmp/firecrawl/openclaw.plugin.json",
        channels: [],
        providers: [],
        cliBackends: [],
        syntheticAuthRefs: [],
        nonSecretAuthMarkers: [],
        skills: [],
        hooks: [],
        configUiHints: { "webFetch.apiKey": { label: "key" } },
      },
      {
        id: "noise",
        origin: "bundled",
        rootDir: "/tmp/noise",
        source: "/tmp/noise/index.js",
        manifestPath: "/tmp/noise/openclaw.plugin.json",
        channels: [],
        providers: [],
        cliBackends: [],
        syntheticAuthRefs: [],
        nonSecretAuthMarkers: [],
        skills: [],
        hooks: [],
        configUiHints: { unrelated: { label: "nope" } },
      },
    ],
    diagnostics: [],
  };
}

function createRuntimeWebFetchProvider() {
  return {
    pluginId: "firecrawl",
    pluginName: "Firecrawl",
    source: "test" as const,
    provider: {
      id: "firecrawl",
      label: "Firecrawl",
      hint: "Firecrawl runtime provider",
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "firecrawl-...",
      signupUrl: "https://example.com/firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      getCredentialValue: () => "configured",
      setCredentialValue: () => {},
      createTool: () => ({
        description: "firecrawl",
        parameters: {},
        execute: async () => ({}),
      }),
    },
  };
}

describe("resolvePluginWebFetchProviders", () => {
  beforeAll(async () => {
    vi.doMock("./plugin-registry.js", async () => {
      const actual =
        await vi.importActual<typeof import("./plugin-registry.js")>("./plugin-registry.js");
      return {
        ...actual,
        loadPluginRegistrySnapshotWithMetadata: () => ({
          snapshot: { plugins: [], diagnostics: [] },
          source: "derived",
          diagnostics: [],
        }),
      };
    });
    loaderModule = await import("./loader.js");
    manifestRegistryModule = await import("./manifest-registry.js");
    webFetchProvidersSharedModule = await import("./web-fetch-providers.shared.js");
    ({ resetPluginRuntimeStateForTest, setActivePluginRegistry } = await import("./runtime.js"));
    ({ resolvePluginWebFetchProviders } = await import("./web-fetch-providers.runtime.js"));
  });

  beforeEach(() => {
    vi.spyOn(manifestRegistryModule, "loadPluginManifestRegistry").mockReturnValue(
      createManifestRegistryFixture() as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
        ...args: unknown[]
      ) => infer R
        ? R
        : never,
    );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation(() => {
        const registry = createEmptyPluginRegistry();
        registry.webFetchProviders = [createRuntimeWebFetchProvider()];
        return registry;
      });
    resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("falls back to the plugin loader when no compatible active registry exists", () => {
    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("loads manifest-declared web-fetch providers in setup mode without the plugin loader", () => {
    const providers = resolvePluginWebFetchProviders({
      config: createFirecrawlAllowConfig(),
      mode: "setup",
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not force a fresh snapshot load when the same web-provider load is already in flight", () => {
    const inFlightSpy = vi
      .spyOn(loaderModule, "isPluginRegistryLoadInFlight")
      .mockReturnValue(true);
    loadOpenClawPluginsMock.mockImplementation(() => {
      throw new Error("resolvePluginWebFetchProviders should not bypass the in-flight guard");
    });

    const providers = resolvePluginWebFetchProviders({
      config: createFirecrawlAllowConfig(),
      bundledAllowlistCompat: true,
      workspaceDir: DEFAULT_WORKSPACE,
      env: createWebFetchEnv(),
    });

    expect(providers).toStrictEqual([]);
    const { logger: inFlightLogger, ...inFlightLoadOptions } =
      inFlightSpy.mock.calls.at(0)?.[0] ?? {};
    expect(Object.keys(inFlightLogger ?? {}).toSorted()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(inFlightLoadOptions).toEqual({
      config: createFirecrawlAllowConfig(),
      activationSourceConfig: createFirecrawlAllowConfig(),
      autoEnabledReasons: {},
      workspaceDir: DEFAULT_WORKSPACE,
      env: createWebFetchEnv(),
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
    });
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses a compatible active registry for snapshot resolution when config is provided", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webFetchProvidersSharedModule.resolveBundledWebFetchResolutionConfig({
        config: rawConfig,
        bundledAllowlistCompat: true,
        env,
      });
    const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
      onlyPluginIds: ["firecrawl"],
      cache: true,
      activate: false,
    });
    const registry = createEmptyPluginRegistry();
    registry.webFetchProviders.push(createRuntimeWebFetchProvider());
    setActivePluginRegistry(registry, cacheKey);

    const providers = resolvePluginWebFetchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("inherits workspaceDir from the active registry for compatible web-fetch snapshot reuse", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webFetchProvidersSharedModule.resolveBundledWebFetchResolutionConfig({
        config: rawConfig,
        bundledAllowlistCompat: true,
        workspaceDir: DEFAULT_WORKSPACE,
        env,
      });
    const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
      onlyPluginIds: ["firecrawl"],
      cache: true,
      activate: false,
    });
    const registry = createEmptyPluginRegistry();
    registry.webFetchProviders.push(createRuntimeWebFetchProvider());
    setActivePluginRegistry(registry, cacheKey, "default", DEFAULT_WORKSPACE);

    const providers = resolvePluginWebFetchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses the active registry workspace for candidate discovery when workspaceDir is omitted", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );

    resolvePluginWebFetchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    expect(manifestRegistryModule.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: rawConfig,
      workspaceDir: "/tmp/runtime-workspace",
      env,
      diagnostics: [],
      installRecords: {},
    });
    const { logger, ...loadOptions } = loadOpenClawPluginsMock.mock.calls.at(0)?.[0] ?? {};
    expect(Object.keys(logger ?? {}).toSorted()).toEqual(["debug", "error", "info", "warn"]);
    expect(loadOptions).toEqual({
      config: createFirecrawlAllowConfig(),
      activationSourceConfig: createFirecrawlAllowConfig(),
      autoEnabledReasons: {},
      workspaceDir: "/tmp/runtime-workspace",
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
    });
  });

  it("resolves web-fetch providers for each active registry workspace", () => {
    const env = createWebFetchEnv();
    const config = createFirecrawlAllowConfig();

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebFetchProviders({
      config,
      bundledAllowlistCompat: true,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebFetchProviders({
      config,
      bundledAllowlistCompat: true,
      env,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });
});
