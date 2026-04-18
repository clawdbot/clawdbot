import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type RegistryModule = typeof import("./registry.js");
type RuntimeModule = typeof import("./runtime.js");
type WebSearchProvidersRuntimeModule = typeof import("./web-search-providers.runtime.js");
type ManifestRegistryModule = typeof import("./manifest-registry.js");
type PluginAutoEnableModule = typeof import("../config/plugin-auto-enable.js");
type WebSearchProvidersSharedModule = typeof import("./web-search-providers.shared.js");

const BUNDLED_WEB_SEARCH_PROVIDERS = [
  { pluginId: "brave", id: "brave", order: 10 },
  { pluginId: "google", id: "gemini", order: 20 },
  { pluginId: "xai", id: "grok", order: 30 },
  { pluginId: "moonshot", id: "kimi", order: 40 },
  { pluginId: "perplexity", id: "perplexity", order: 50 },
  { pluginId: "firecrawl", id: "firecrawl", order: 60 },
  { pluginId: "exa", id: "exa", order: 65 },
  { pluginId: "tavily", id: "tavily", order: 70 },
  { pluginId: "duckduckgo", id: "duckduckgo", order: 100 },
] as const;

let createEmptyPluginRegistry: RegistryModule["createEmptyPluginRegistry"];
let loadPluginManifestRegistryMock: ReturnType<typeof vi.fn>;
let setActivePluginRegistry: RuntimeModule["setActivePluginRegistry"];
let resolvePluginWebSearchProviders: WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"];
let resolveRuntimeWebSearchProviders: WebSearchProvidersRuntimeModule["resolveRuntimeWebSearchProviders"];
let resetWebSearchProviderSnapshotCacheForTests: WebSearchProvidersRuntimeModule["__testing"]["resetWebSearchProviderSnapshotCacheForTests"];
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let loaderModule: typeof import("./loader.js");
let manifestRegistryModule: ManifestRegistryModule;
let pluginAutoEnableModule: PluginAutoEnableModule;
let applyPluginAutoEnableSpy: ReturnType<typeof vi.fn>;
let webSearchProvidersSharedModule: WebSearchProvidersSharedModule;

const DEFAULT_WEB_SEARCH_WORKSPACE = "/tmp/workspace";
const EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS = [
  "brave:brave",
  "duckduckgo:duckduckgo",
  "exa:exa",
  "firecrawl:firecrawl",
  "google:gemini",
  "xai:grok",
  "moonshot:kimi",
  "perplexity:perplexity",
  "tavily:tavily",
] as const;

function buildMockedWebSearchProviders(params?: {
  config?: { plugins?: Record<string, unknown> };
}) {
  const plugins = params?.config?.plugins as
    | {
        enabled?: boolean;
        allow?: string[];
        entries?: Record<string, { enabled?: boolean }>;
      }
    | undefined;
  if (plugins?.enabled === false) {
    return [];
  }
  const allow = Array.isArray(plugins?.allow) && plugins.allow.length > 0 ? plugins.allow : null;
  const entries = plugins?.entries ?? {};
  const webSearchProviders = BUNDLED_WEB_SEARCH_PROVIDERS.filter((provider) => {
    if (allow && !allow.includes(provider.pluginId)) {
      return false;
    }
    if (entries[provider.pluginId]?.enabled === false) {
      return false;
    }
    return true;
  }).map((provider) => ({
    pluginId: provider.pluginId,
    pluginName: provider.pluginId,
    source: "test" as const,
    provider: {
      id: provider.id,
      label: provider.id,
      hint: `${provider.id} provider`,
      envVars: [`${provider.id.toUpperCase()}_API_KEY`],
      placeholder: `${provider.id}-...`,
      signupUrl: `https://example.com/${provider.id}`,
      autoDetectOrder: provider.order,
      credentialPath: `plugins.entries.${provider.pluginId}.config.webSearch.apiKey`,
      getCredentialValue: () => "configured",
      setCredentialValue: () => {},
      createTool: () => ({
        description: provider.id,
        parameters: {},
        execute: async () => ({}),
      }),
    },
  }));
  return webSearchProviders;
}

function createBraveAllowConfig() {
  return {
    plugins: {
      allow: ["brave"],
    },
  };
}

function createWebSearchEnv(overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: "/tmp/openclaw-home",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createSnapshotParams(params?: {
  config?: { plugins?: Record<string, unknown> };
  env?: NodeJS.ProcessEnv;
  bundledAllowlistCompat?: boolean;
  workspaceDir?: string;
}) {
  return {
    config: params?.config ?? createBraveAllowConfig(),
    env: params?.env ?? createWebSearchEnv(),
    bundledAllowlistCompat: params?.bundledAllowlistCompat ?? true,
    workspaceDir: params?.workspaceDir ?? DEFAULT_WEB_SEARCH_WORKSPACE,
  };
}

function toRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  return providers.map((provider) => `${provider.pluginId}:${provider.id}`);
}

function expectBundledRuntimeProviderKeys(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolvePluginWebSearchProviders"]>,
) {
  expect(toRuntimeProviderKeys(providers)).toEqual(
    EXPECTED_BUNDLED_RUNTIME_WEB_SEARCH_PROVIDER_KEYS,
  );
}

function createManifestRegistryFixture() {
  return {
    plugins: [
      {
        id: "brave",
        origin: "bundled",
        rootDir: "/tmp/brave",
        source: "/tmp/brave/index.js",
        manifestPath: "/tmp/brave/openclaw.plugin.json",
        channels: [],
        providers: [],
        skills: [],
        hooks: [],
        configUiHints: { "webSearch.apiKey": { label: "key" } },
      },
      {
        id: "noise",
        origin: "bundled",
        rootDir: "/tmp/noise",
        source: "/tmp/noise/index.js",
        manifestPath: "/tmp/noise/openclaw.plugin.json",
        channels: [],
        providers: [],
        skills: [],
        hooks: [],
        configUiHints: { unrelated: { label: "nope" } },
      },
    ],
    diagnostics: [],
  };
}

function expectLoaderCallCount(count: number) {
  expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(count);
}

function expectScopedWebSearchCandidates(pluginIds: readonly string[]) {
  expect(loadPluginManifestRegistryMock).toHaveBeenCalled();
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      onlyPluginIds: [...pluginIds],
    }),
  );
}

function expectSnapshotMemoization(params: {
  config: { plugins?: Record<string, unknown> };
  env: NodeJS.ProcessEnv;
  expectedLoaderCalls: number;
}) {
  const runtimeParams = createSnapshotParams({
    config: params.config,
    env: params.env,
  });

  const first = resolvePluginWebSearchProviders(runtimeParams);
  const second = resolvePluginWebSearchProviders(runtimeParams);

  if (params.expectedLoaderCalls === 1) {
    expect(second).toBe(first);
  } else {
    expect(second).not.toBe(first);
  }
  expectLoaderCallCount(params.expectedLoaderCalls);
}

function expectAutoEnabledWebSearchLoad(params: {
  rawConfig: { plugins?: Record<string, unknown> };
  expectedAllow: readonly string[];
}) {
  expect(applyPluginAutoEnableSpy).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: createWebSearchEnv(),
  });
  expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
    expect.objectContaining({
      config: expect.objectContaining({
        plugins: expect.objectContaining({
          allow: expect.arrayContaining([...params.expectedAllow]),
        }),
      }),
    }),
  );
}

function expectSnapshotLoaderCalls(params: {
  config: { plugins?: Record<string, unknown> };
  env: NodeJS.ProcessEnv;
  mutate: () => void;
  expectedLoaderCalls: number;
}) {
  resolvePluginWebSearchProviders(
    createSnapshotParams({
      config: params.config,
      env: params.env,
    }),
  );
  params.mutate();
  resolvePluginWebSearchProviders(
    createSnapshotParams({
      config: params.config,
      env: params.env,
    }),
  );
  expectLoaderCallCount(params.expectedLoaderCalls);
}

function createRuntimeWebSearchProvider(params: {
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  hint: string;
  envVar: string;
  signupUrl: string;
  credentialPath: string;
}) {
  return {
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    provider: {
      id: params.id,
      label: params.label,
      hint: params.hint,
      envVars: [params.envVar],
      placeholder: `${params.id}-...`,
      signupUrl: params.signupUrl,
      autoDetectOrder: 1,
      credentialPath: params.credentialPath,
      getCredentialValue: () => "configured",
      setCredentialValue: () => {},
      createTool: () => ({
        description: params.id,
        parameters: {},
        execute: async () => ({}),
      }),
    },
    source: "test" as const,
  };
}

function createBraveRuntimeWebSearchProvider() {
  return createRuntimeWebSearchProvider({
    pluginId: "brave",
    pluginName: "Brave",
    id: "brave",
    label: "Brave Search",
    hint: "Brave runtime provider",
    envVar: "BRAVE_API_KEY",
    signupUrl: "https://example.com/brave",
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
  });
}

function createActiveBraveRegistryFixture(params?: {
  includeResolutionWorkspaceDir?: boolean;
  activeWorkspaceDir?: string;
}) {
  const env = createWebSearchEnv();
  const rawConfig = createBraveAllowConfig();
  const { config, activationSourceConfig, autoEnabledReasons } =
    webSearchProvidersSharedModule.resolveBundledWebSearchResolutionConfig({
      config: rawConfig,
      bundledAllowlistCompat: true,
      ...(params?.includeResolutionWorkspaceDir
        ? { workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE }
        : {}),
      env,
    });
  const { cacheKey } = loaderModule.__testing.resolvePluginLoadCacheContext({
    config,
    activationSourceConfig,
    autoEnabledReasons,
    workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
    env,
    onlyPluginIds: ["brave"],
    cache: false,
    activate: false,
  });
  const registry = createEmptyPluginRegistry();
  registry.webSearchProviders.push(createBraveRuntimeWebSearchProvider());
  setActivePluginRegistry(registry, cacheKey, "default", params?.activeWorkspaceDir);

  return { env, rawConfig };
}

function expectRuntimeProviderResolution(
  providers: ReturnType<WebSearchProvidersRuntimeModule["resolveRuntimeWebSearchProviders"]>,
  expected: readonly string[],
) {
  expect(toRuntimeProviderKeys(providers)).toEqual([...expected]);
  expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
}

describe("resolvePluginWebSearchProviders", () => {
  beforeAll(async () => {
    ({ createEmptyPluginRegistry } = await import("./registry.js"));
    manifestRegistryModule = await import("./manifest-registry.js");
    loaderModule = await import("./loader.js");
    pluginAutoEnableModule = await import("../config/plugin-auto-enable.js");
    webSearchProvidersSharedModule = await import("./web-search-providers.shared.js");
    ({ setActivePluginRegistry } = await import("./runtime.js"));
    ({
      resolvePluginWebSearchProviders,
      resolveRuntimeWebSearchProviders,
      __testing: { resetWebSearchProviderSnapshotCacheForTests },
    } = await import("./web-search-providers.runtime.js"));
  });

  beforeEach(() => {
    resetWebSearchProviderSnapshotCacheForTests();
    applyPluginAutoEnableSpy?.mockRestore();
    applyPluginAutoEnableSpy = vi
      .spyOn(pluginAutoEnableModule, "applyPluginAutoEnable")
      .mockImplementation(
        (params) =>
          ({
            config: params.config ?? {},
            changes: [],
            autoEnabledReasons: {},
          }) as ReturnType<PluginAutoEnableModule["applyPluginAutoEnable"]>,
      );
    loadPluginManifestRegistryMock = vi
      .spyOn(manifestRegistryModule, "loadPluginManifestRegistry")
      .mockReturnValue(
        createManifestRegistryFixture() as ManifestRegistryModule["loadPluginManifestRegistry"] extends (
          ...args: unknown[]
        ) => infer R
          ? R
          : never,
      );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders = buildMockedWebSearchProviders(params);
        return registry;
      });
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.useRealTimers();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it("loads bundled providers through the plugin loader in alphabetical order", () => {
    const providers = resolvePluginWebSearchProviders({});

    expectBundledRuntimeProviderKeys(providers);
    expectLoaderCallCount(1);
  });

  it("loads manifest-declared web-search providers in setup mode", () => {
    const providers = resolvePluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["perplexity"],
        },
      },
      mode: "setup",
    });

    expect(toRuntimeProviderKeys(providers)).toEqual(["brave:brave"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin web-search providers from the auto-enabled config snapshot", () => {
    const rawConfig = createBraveAllowConfig();
    const autoEnabledConfig = {
      plugins: {
        allow: ["brave", "perplexity"],
      },
    };
    applyPluginAutoEnableSpy.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });

    resolvePluginWebSearchProviders(createSnapshotParams({ config: rawConfig }));

    expectAutoEnabledWebSearchLoad({
      rawConfig,
      expectedAllow: ["brave", "perplexity"],
    });
  });

  it("scopes plugin loading to manifest-declared web-search candidates", () => {
    resolvePluginWebSearchProviders({});

    expectScopedWebSearchCandidates(["brave"]);
  });

  it("uses the active registry workspace for candidate discovery and snapshot loads when workspaceDir is omitted", () => {
    const env = createWebSearchEnv();
    const rawConfig = createBraveAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );

    resolvePluginWebSearchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    expect(loadPluginManifestRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
      }),
    );
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/runtime-workspace",
        onlyPluginIds: ["brave"],
      }),
    );
  });
  it("memoizes snapshot provider resolution for the same config and env", () => {
    expectSnapshotMemoization({
      config: createBraveAllowConfig(),
      env: createWebSearchEnv(),
      expectedLoaderCalls: 1,
    });
  });

  it("reuses a compatible active registry for snapshot resolution when config is provided", () => {
    const { env, rawConfig } = createActiveBraveRegistryFixture();

    const providers = resolvePluginWebSearchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
      env,
    });

    expectRuntimeProviderResolution(providers, ["brave:brave"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("inherits workspaceDir from the active registry for compatible web-search snapshot reuse", () => {
    const { env, rawConfig } = createActiveBraveRegistryFixture({
      includeResolutionWorkspaceDir: true,
      activeWorkspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
    });

    const providers = resolvePluginWebSearchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    expectRuntimeProviderResolution(providers, ["brave:brave"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("keys web-search snapshot memoization by the inherited active workspace", () => {
    const env = createWebSearchEnv();
    const rawConfig = createBraveAllowConfig();

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-a");
    resolvePluginWebSearchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", "/tmp/workspace-b");
    resolvePluginWebSearchProviders({
      config: rawConfig,
      bundledAllowlistCompat: true,
      env,
    });

    expectLoaderCallCount(2);
  });

  it("retains the snapshot cache when config contents change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({ OPENCLAW_HOME: "/tmp/openclaw-home-a" });

    expectSnapshotLoaderCalls({
      config,
      env,
      mutate: () => {
        config.plugins = { allow: ["perplexity"] };
      },
      expectedLoaderCalls: 1,
    });
  });

  it("invalidates the snapshot cache when env contents change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({ OPENCLAW_HOME: "/tmp/openclaw-home-a" });

    expectSnapshotLoaderCalls({
      config,
      env,
      mutate: () => {
        env.OPENCLAW_HOME = "/tmp/openclaw-home-b";
      },
      expectedLoaderCalls: 2,
    });
  });

  it.each([
    {
      title: "skips web-search snapshot memoization when plugin cache opt-outs are set",
      env: {
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      },
    },
    {
      title: "skips web-search snapshot memoization when discovery cache ttl is zero",
      env: {
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
      },
    },
  ])("$title", ({ env }) => {
    expectSnapshotMemoization({
      config: createBraveAllowConfig(),
      env: createWebSearchEnv(env),
      expectedLoaderCalls: 2,
    });
  });

  it("does not leak host Vitest env into an explicit non-Vitest cache key", () => {
    const originalVitest = process.env.VITEST;
    const config = {};
    const env = createWebSearchEnv();

    try {
      delete process.env.VITEST;
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));

      process.env.VITEST = "1";
      resolvePluginWebSearchProviders(createSnapshotParams({ config, env }));
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
    }

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it("expires web-search snapshot memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    });
    const runtimeParams = createSnapshotParams({ config, env });

    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(4);
    resolvePluginWebSearchProviders(runtimeParams);
    vi.advanceTimersByTime(2);
    resolvePluginWebSearchProviders(runtimeParams);

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates web-search snapshots when cache-control env values change in place", () => {
    const config = createBraveAllowConfig();
    const env = createWebSearchEnv({
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    });

    expectSnapshotLoaderCalls({
      config,
      env,
      mutate: () => {
        env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";
      },
      expectedLoaderCalls: 2,
    });
  });

  it.each([
    {
      name: "prefers the active plugin registry for runtime resolution",
      setupRegistry: () => {
        const registry = createEmptyPluginRegistry();
        registry.webSearchProviders.push(
          createRuntimeWebSearchProvider({
            pluginId: "custom-search",
            pluginName: "Custom Search",
            id: "custom",
            label: "Custom Search",
            hint: "Custom runtime provider",
            envVar: "CUSTOM_SEARCH_API_KEY",
            signupUrl: "https://example.com/signup",
            credentialPath: "tools.web.search.custom.apiKey",
          }),
        );
        setActivePluginRegistry(registry);
      },
      params: {},
      expected: ["custom-search:custom"],
    },
    {
      name: "reuses a compatible active registry for runtime resolution when config is provided",
      setupRegistry: () => {
        const { env, rawConfig } = createActiveBraveRegistryFixture();
        return {
          config: rawConfig,
          bundledAllowlistCompat: true,
          workspaceDir: DEFAULT_WEB_SEARCH_WORKSPACE,
          env,
        };
      },
      expected: ["brave:brave"],
    },
  ] as const)("$name", ({ setupRegistry, params, expected }) => {
    const runtimeParams = setupRegistry() ?? params ?? {};
    const providers = resolveRuntimeWebSearchProviders(runtimeParams);

    expectRuntimeProviderResolution(providers, expected);
  });
});
