// Covers web fetch provider runtime hooks supplied by plugins.
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
let clearLoadPluginMetadataSnapshotMemo: typeof import("./plugin-metadata-snapshot.js").clearLoadPluginMetadataSnapshotMemo;

const DEFAULT_WORKSPACE = "/tmp/workspace";

type PluginLoadOptions = { logger?: Record<string, unknown> } & Record<string, unknown>;

function firstPluginLoadOptions(mock: { mock: { calls: unknown[][] } }): PluginLoadOptions {
  return (mock.mock.calls[0]?.[0] ?? {}) as PluginLoadOptions;
}

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

function createManifestRegistryFixture(origin: "bundled" | "global" = "bundled") {
  return {
    plugins: [
      {
        id: "firecrawl",
        origin,
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
        contracts: { webFetchProviders: ["firecrawl"] },
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
    ({ clearLoadPluginMetadataSnapshotMemo } = await import("./plugin-metadata-snapshot.js"));
    ({ resolvePluginWebFetchProviders } = await import("./web-fetch-providers.runtime.js"));
  });

  beforeEach(() => {
    clearLoadPluginMetadataSnapshotMemo();
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
    clearLoadPluginMetadataSnapshotMemo();
    vi.restoreAllMocks();
  });

  it("loads bundled runtime artifacts when no compatible active registry exists", () => {
    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("falls back to the plugin loader for non-bundled provider owners", () => {
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistry).mockReturnValue(
      createManifestRegistryFixture(
        "global",
      ) as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
        ...args: unknown[]
      ) => infer R
        ? R
        : never,
    );

    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "denylisted",
      config: { plugins: { deny: ["firecrawl"] } },
    },
    {
      label: "explicitly disabled",
      config: { plugins: { entries: { firecrawl: { enabled: false } } } },
    },
  ])("does not load $label bundled runtime artifacts", ({ config }) => {
    const providers = resolvePluginWebFetchProviders({ config });

    expect(providers).toStrictEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
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
    const rawConfig = createFirecrawlAllowConfig();
    const env = createWebFetchEnv();
    const { config, activationSourceConfig, autoEnabledReasons } =
      webFetchProvidersSharedModule.resolveBundledWebFetchResolutionConfig({
        config: rawConfig,
        workspaceDir: DEFAULT_WORKSPACE,
        env,
      });

    const providers = resolvePluginWebFetchProviders({
      config: rawConfig,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
    });

    expect(providers).toStrictEqual([]);
    const { logger: inFlightLogger, ...inFlightLoadOptions } = firstPluginLoadOptions(inFlightSpy);
    expect(Object.keys(inFlightLogger ?? {}).toSorted()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(inFlightLoadOptions).toEqual({
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
      installRecords: undefined,
      manifestRegistry: undefined,
    });
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
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistry).mockReturnValue(
      createManifestRegistryFixture(
        "global",
      ) as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
        ...args: unknown[]
      ) => infer R
        ? R
        : never,
    );

    resolvePluginWebFetchProviders({
      config: rawConfig,
      env,
    });

    expect(manifestRegistryModule.loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: rawConfig,
      workspaceDir: "/tmp/runtime-workspace",
      env,
      diagnostics: [],
      installRecords: {},
    });
    const { logger, ...loadOptions } = firstPluginLoadOptions(loadOpenClawPluginsMock);
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
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistry).mockReturnValue(
      createManifestRegistryFixture(
        "global",
      ) as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
        ...args: unknown[]
      ) => infer R
        ? R
        : never,
    );

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebFetchProviders({
      config,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebFetchProviders({
      config,
      env,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });
});
