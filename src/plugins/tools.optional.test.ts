import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "../agents/tool-policy.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";

type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  source: string;
  names: string[];
  declaredNames?: string[];
  factory: (ctx: unknown) => unknown;
};

const loadOpenClawPluginsMock = vi.fn();
const resolveRuntimePluginRegistryMock = vi.fn();
const applyPluginAutoEnableMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (params: unknown) => loadOpenClawPluginsMock(params),
  resolveCompatibleRuntimePluginRegistry: (params: unknown) =>
    resolveRuntimePluginRegistryMock(params),
  resolvePluginRegistryLoadCacheKey: (params: unknown) => JSON.stringify(params),
  resolveRuntimePluginRegistry: (params: unknown) => resolveRuntimePluginRegistryMock(params),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (params: unknown) => applyPluginAutoEnableMock(params),
}));

let resolvePluginTools: typeof import("./tools.js").resolvePluginTools;
let ensureStandalonePluginToolRegistryLoaded: typeof import("./tools.js").ensureStandalonePluginToolRegistryLoaded;
let buildPluginToolMetadataKey: typeof import("./tools.js").buildPluginToolMetadataKey;
let getPluginToolMeta: typeof import("./tools.js").getPluginToolMeta;
let resetPluginToolFactoryCache: typeof import("./tools.js").resetPluginToolFactoryCache;
let getActivePluginRegistry: typeof import("./runtime.js").getActivePluginRegistry;
let pinActivePluginChannelRegistry: typeof import("./runtime.js").pinActivePluginChannelRegistry;
let resetPluginRuntimeStateForTest: typeof import("./runtime.js").resetPluginRuntimeStateForTest;
let setActivePluginRegistry: typeof import("./runtime.js").setActivePluginRegistry;
let clearCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").clearCurrentPluginMetadataSnapshot;
let setCurrentPluginMetadataSnapshot: typeof import("./current-plugin-metadata-snapshot.js").setCurrentPluginMetadataSnapshot;

function makeTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function createContext() {
  return {
    config: {
      plugins: {
        enabled: true,
        allow: ["optional-demo", "message", "multi"],
        load: { paths: ["/tmp/plugin.js"] },
        slots: { memory: "none" },
      },
    },
    workspaceDir: "/tmp",
  };
}

function createResolveToolsParams(params?: {
  context?: ReturnType<typeof createContext> & Record<string, unknown>;
  toolAllowlist?: readonly string[];
  toolDenylist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
}) {
  return {
    context: (params?.context ?? createContext()) as never,
    ...(params?.toolAllowlist ? { toolAllowlist: [...params.toolAllowlist] } : {}),
    ...(params?.toolDenylist ? { toolDenylist: [...params.toolDenylist] } : {}),
    ...(params?.existingToolNames ? { existingToolNames: params.existingToolNames } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    ...(params?.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
}

function createToolRegistry(entries: MockRegistryToolEntry[]) {
  return {
    plugins: entries.map((entry) => ({ id: entry.pluginId, status: "loaded" })),
    tools: entries,
    diagnostics: [] as Array<{
      level: string;
      pluginId: string;
      source: string;
      message: string;
    }>,
  };
}

function setRegistry(entries: MockRegistryToolEntry[]) {
  const registry = createToolRegistry(entries);
  loadOpenClawPluginsMock.mockReturnValue(registry);
  setActivePluginRegistry?.(registry as never, "test-tool-registry", "gateway-bindable", "/tmp");
  installToolManifestSnapshots({
    config: createContext().config,
    plugins: entries
      .map((entry) => ({
        id: entry.pluginId,
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: entry.declaredNames ?? entry.names,
        },
        ...(entry.optional
          ? {
              toolMetadata: Object.fromEntries(
                (entry.declaredNames ?? entry.names).map((name) => [name, { optional: true }]),
              ),
            }
          : {}),
      }))
      .filter((plugin) => plugin.contracts.tools.length > 0),
  });
  return registry;
}

function setMultiToolRegistry() {
  return setRegistry([
    {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["message", "other_tool"],
      factory: () => [makeTool("message"), makeTool("other_tool")],
    },
  ]);
}

function createOptionalDemoEntry(): MockRegistryToolEntry {
  return {
    pluginId: "optional-demo",
    names: ["optional_tool"],
    optional: true,
    source: "/tmp/optional-demo.js",
    factory: () => makeTool("optional_tool"),
  };
}

function createMalformedTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "bad" }] };
    },
  };
}

function installConsoleMethodSpy(method: "log" | "warn") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: vi.fn(),
  };
  return spy;
}

function requireConsoleMessage(spy: { mock: { calls: unknown[][] } }, index = 0): string {
  const call = spy.mock.calls[index];
  if (!call) {
    throw new Error(`expected console call ${index}`);
  }
  expect(typeof call[0]).toBe("string");
  if (typeof call[0] !== "string") {
    throw new Error(`expected console call ${index} to contain a string message`);
  }
  return call[0];
}

function resolveWithConflictingCoreName(options?: { suppressNameConflicts?: boolean }) {
  return resolvePluginTools(
    createResolveToolsParams({
      existingToolNames: new Set(["message"]),
      ...(options?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    }),
  );
}

function setOptionalDemoRegistry() {
  setRegistry([createOptionalDemoEntry()]);
}

function resolveOptionalDemoTools(toolAllowlist?: readonly string[]) {
  return resolvePluginTools(createResolveToolsParams({ toolAllowlist }));
}

function createAutoEnabledOptionalContext() {
  const rawContext = createContext();
  const autoEnabledConfig = {
    ...rawContext.config,
    plugins: {
      ...rawContext.config.plugins,
      entries: {
        "optional-demo": { enabled: true },
      },
    },
  };
  return { rawContext, autoEnabledConfig };
}

function expectAutoEnabledOptionalLoad(autoEnabledConfig: unknown) {
  expectLoaderCall({ config: autoEnabledConfig });
}

function resolveAutoEnabledOptionalDemoTools() {
  setOptionalDemoRegistry();
  const { rawContext, autoEnabledConfig } = createAutoEnabledOptionalContext();
  installToolManifestSnapshot({
    config: autoEnabledConfig,
    compatibleConfigs: [rawContext.config],
    plugin: {
      id: "optional-demo",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      contracts: {
        tools: ["optional_tool"],
      },
    },
  });
  applyPluginAutoEnableMock.mockReturnValue({ config: autoEnabledConfig, changes: [] });

  const tools = resolvePluginTools({
    context: {
      ...rawContext,
      config: rawContext.config as never,
    } as never,
    toolAllowlist: ["optional_tool"],
  });

  return { rawContext, autoEnabledConfig, tools };
}

function createOptionalDemoActiveRegistry() {
  installToolManifestSnapshot({
    config: createContext().config,
    plugin: {
      id: "optional-demo",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      contracts: {
        tools: ["optional_tool"],
      },
    },
  });
  const registry = {
    plugins: [{ id: "optional-demo", status: "loaded" }],
    tools: [createOptionalDemoEntry()],
    diagnostics: [],
  };
  setActivePluginRegistry?.(registry as never, "test-tool-registry", "gateway-bindable", "/tmp");
  return registry;
}

function installToolManifestSnapshot(params: {
  config: ReturnType<typeof createContext>["config"];
  compatibleConfigs?: ReturnType<typeof createContext>["config"][];
  env?: NodeJS.ProcessEnv;
  plugin: Record<string, unknown>;
}) {
  installToolManifestSnapshots({
    config: params.config,
    compatibleConfigs: params.compatibleConfigs,
    env: params.env,
    plugins: [params.plugin],
  });
}

function installToolManifestSnapshots(params: {
  config: ReturnType<typeof createContext>["config"];
  compatibleConfigs?: ReturnType<typeof createContext>["config"][];
  env?: NodeJS.ProcessEnv;
  plugins: Record<string, unknown>[];
}) {
  const plugins = params.plugins;
  setCurrentPluginMetadataSnapshot(
    {
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      workspaceDir: "/tmp",
      index: {
        version: 1,
        hostContractVersion: "test",
        compatRegistryVersion: "test",
        migrationVersion: 1,
        policyHash: "test",
        generatedAtMs: 0,
        installRecords: {},
        plugins: plugins.map((plugin) => ({
          pluginId: String(plugin.id),
          origin: plugin.origin,
          enabled: true,
          enabledByDefault: plugin.enabledByDefault,
          startup: {
            sidecar: false,
            memory: false,
            deferConfiguredChannelFullLoadUntilAfterListen: false,
            agentHarnesses: [],
          },
          compat: [],
        })),
        diagnostics: [],
      },
      registryDiagnostics: [],
      manifestRegistry: { plugins, diagnostics: [] },
      plugins,
      diagnostics: [],
      byPluginId: new Map(plugins.map((plugin) => [String(plugin.id), plugin])),
      normalizePluginId: (id: string) => id,
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: plugins.length,
        manifestPluginCount: plugins.length,
      },
    } as never,
    {
      config: params.config,
      compatibleConfigs: params.compatibleConfigs,
      env: params.env ?? process.env,
      workspaceDir: "/tmp",
    },
  );
}

function createXaiToolManifest() {
  return {
    id: "xai",
    origin: "bundled",
    enabledByDefault: true,
    channels: [],
    providers: ["xai"],
    providerAuthEnvVars: {
      xai: ["XAI_API_KEY"],
    },
    contracts: {
      tools: ["x_search"],
    },
    toolMetadata: {
      x_search: {
        authSignals: [{ provider: "xai" }],
        configSignals: [
          {
            rootPath: "plugins.entries.xai.config",
            overlayPath: "webSearch",
            required: ["apiKey"],
          },
        ],
      },
    },
  };
}

function expectResolvedToolNames(
  tools: ReturnType<typeof resolvePluginTools>,
  expectedToolNames: readonly string[],
) {
  expect(tools.map((tool) => tool.name)).toEqual(expectedToolNames);
}

function expectLoaderCall(overrides: Record<string, unknown>) {
  void overrides;
  expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
}

function mockCallParams(
  mock: { mock: { calls: unknown[][] } },
  index = 0,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[0] as Record<string, unknown>;
}

function expectLoaderSelectedOnlyPluginIds(expectedPluginIds: readonly string[]) {
  const selectedPluginIds = loadOpenClawPluginsMock.mock.calls.map(
    ([params]) => (params as { onlyPluginIds?: string[] }).onlyPluginIds,
  );
  expect(selectedPluginIds).toStrictEqual([expectedPluginIds]);
}

function expectSingleDiagnosticMessage(
  diagnostics: Array<{ message: string }>,
  messageFragment: string,
) {
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.message).toContain(messageFragment);
}

function expectConflictingCoreNameResolution(params: {
  suppressNameConflicts?: boolean;
  expectedDiagnosticFragment?: string;
}) {
  const registry = setMultiToolRegistry();
  const tools = resolveWithConflictingCoreName({
    suppressNameConflicts: params.suppressNameConflicts,
  });

  expectResolvedToolNames(tools, ["other_tool"]);
  if (params.expectedDiagnosticFragment) {
    expectSingleDiagnosticMessage(registry.diagnostics, params.expectedDiagnosticFragment);
    return;
  }
  expect(registry.diagnostics).toHaveLength(0);
}

describe("resolvePluginTools optional tools", () => {
  beforeAll(async () => {
    ({
      buildPluginToolMetadataKey,
      ensureStandalonePluginToolRegistryLoaded,
      getPluginToolMeta,
      resetPluginToolFactoryCache,
      resolvePluginTools,
    } = await import("./tools.js"));
    ({
      getActivePluginRegistry,
      pinActivePluginChannelRegistry,
      resetPluginRuntimeStateForTest,
      setActivePluginRegistry,
    } = await import("./runtime.js"));
    ({ clearCurrentPluginMetadataSnapshot, setCurrentPluginMetadataSnapshot } =
      await import("./current-plugin-metadata-snapshot.js"));
  });

  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockImplementation((params) =>
      loadOpenClawPluginsMock(params),
    );
    applyPluginAutoEnableMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation(({ config }: { config: unknown }) => ({
      config,
      changes: [],
    }));
    resetPluginRuntimeStateForTest?.();
    clearCurrentPluginMetadataSnapshot?.();
    resetPluginToolFactoryCache?.();
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest?.();
    clearCurrentPluginMetadataSnapshot?.();
    resetPluginToolFactoryCache?.();
    setLoggerOverride(null);
    loggingState.rawConsole = null;
    resetLogger();
    vi.useRealTimers();
  });

  it("does not load plugin-owned tools whose manifest metadata has no available signal", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    loadOpenClawPluginsMock.mockImplementation((params) =>
      Array.isArray((params as { onlyPluginIds?: string[] }).onlyPluginIds) &&
      (params as { onlyPluginIds?: string[] }).onlyPluginIds?.length === 0
        ? { tools: [], diagnostics: [] }
        : {
            tools: [
              {
                pluginId: "xai",
                optional: false,
                source: "/tmp/xai.js",
                names: ["x_search"],
                factory,
              },
            ],
            diagnostics: [],
          },
    );

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {},
    });

    expect(tools).toStrictEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("standalone bootstrap loads configured plugin tools before resolution", () => {
    const config = createContext().config;
    const registry = createToolRegistry([createOptionalDemoEntry()]);
    loadOpenClawPluginsMock.mockReturnValue(registry);
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "optional-demo",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["optional_tool"],
        },
      },
    });

    ensureStandalonePluginToolRegistryLoaded({
      context: createContext() as never,
      toolAllowlist: ["optional_tool"],
    });
    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderSelectedOnlyPluginIds(["optional-demo"]);
  });

  it("auto-loads cold registry for path-based config-origin plugins without pre-warming (#76598)", () => {
    const context = {
      ...createContext(),
      config: {
        ...createContext().config,
        plugins: {
          ...createContext().config.plugins,
          entries: {
            "optional-demo": { enabled: true },
          },
        },
      },
    };
    const config = context.config;
    const registry = createToolRegistry([createOptionalDemoEntry()]);
    loadOpenClawPluginsMock.mockReturnValue(registry);
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "optional-demo",
        origin: "config",
        enabledByDefault: undefined,
        channels: [],
        providers: [],
        contracts: {
          tools: ["optional_tool"],
        },
      },
    });

    // No ensureStandalonePluginToolRegistryLoaded pre-call and no pinned channel registry —
    // resolvePluginTools must trigger standalone load itself when the registry is cold.
    // This is the regression path from PR #76004 where path-based plugin tools disappeared.
    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderSelectedOnlyPluginIds(["optional-demo"]);
  });

  it("does not reuse a partial active registry for wildcard-selected plugin tools", () => {
    const context = createContext();
    const config = context.config;
    const optionalEntry = createOptionalDemoEntry();
    const multiEntry: MockRegistryToolEntry = {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["other_tool"],
      declaredNames: ["other_tool"],
      factory: () => makeTool("other_tool"),
    };
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "multi",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["other_tool"],
          },
        },
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
          toolMetadata: {
            optional_tool: {
              optional: true,
            },
          },
        },
      ],
    });
    const partialRegistry = createToolRegistry([multiEntry]);
    partialRegistry.plugins.push({ id: "optional-demo", status: "loaded" });
    const fullRegistry = createToolRegistry([multiEntry, optionalEntry]);
    setActivePluginRegistry?.(
      partialRegistry as never,
      "partial-test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(partialRegistry);
    loadOpenClawPluginsMock.mockReturnValue(fullRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: ["*", "optional-demo"],
      }),
    );

    expectResolvedToolNames(tools, ["other_tool", "optional_tool"]);
    const loaderParams = mockCallParams(loadOpenClawPluginsMock) as {
      activate?: unknown;
      cache?: unknown;
      onlyPluginIds?: unknown;
      toolDiscovery?: unknown;
    };
    expect(loaderParams.activate).toBe(false);
    expect(loaderParams.cache).toBe(false);
    expect(loaderParams.onlyPluginIds).toEqual(["multi", "optional-demo"]);
    expect(loaderParams.toolDiscovery).toBe(true);
  });

  it("warns when cold registry load still does not provide the selected plugin tools", () => {
    const context = {
      ...createContext(),
      config: {
        ...createContext().config,
        plugins: {
          ...createContext().config.plugins,
          entries: {
            "optional-demo": { enabled: true },
          },
        },
      },
    };
    const config = context.config;
    const registry = createToolRegistry([]);
    loadOpenClawPluginsMock.mockReturnValue(registry);
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "optional-demo",
        origin: "config",
        enabledByDefault: undefined,
        channels: [],
        providers: [],
        contracts: {
          tools: ["optional_tool"],
        },
      },
    });

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: ["optional_tool"],
      }),
    );

    expect(tools).toStrictEqual([]);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool registry did not include selected plugin tools after cold load (optional-demo)",
    );
  });

  it("uses the fresh cold-loaded registry for diagnostics when partial active registries remain incomplete", () => {
    const context = createContext();
    const config = context.config;
    const multiEntry: MockRegistryToolEntry = {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["other_tool"],
      declaredNames: ["other_tool"],
      factory: () => makeTool("other_tool"),
    };
    const optionalEntry = createOptionalDemoEntry();
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "multi",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["other_tool"],
          },
        },
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
        },
      ],
    });
    const staleRegistry = createToolRegistry([multiEntry]);
    staleRegistry.plugins.push({ id: "optional-demo", status: "loaded" });
    const freshRegistry = createToolRegistry([optionalEntry]);
    freshRegistry.plugins.push({ id: "multi", status: "loaded" });
    setActivePluginRegistry?.(
      staleRegistry as never,
      "partial-test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(staleRegistry);
    loadOpenClawPluginsMock.mockReturnValue(freshRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: ["*", "optional-demo"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(getActivePluginRegistry?.()).toBe(staleRegistry);
    expectSingleDiagnosticMessage(
      freshRegistry.diagnostics,
      "plugin tool registry did not include selected plugin tools after cold load (multi)",
    );
    expect(staleRegistry.diagnostics).toStrictEqual([]);
  });

  it("does not reuse a pinned gateway registry for manifest-unavailable tools", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    pinActivePluginChannelRegistry({
      plugins: [{ id: "xai", status: "loaded" }],
      tools: [
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          factory,
        },
      ],
      diagnostics: [],
    } as never);
    loadOpenClawPluginsMock.mockReturnValue({ tools: [], diagnostics: [] });

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {},
      allowGatewaySubagentBinding: true,
    });

    expect(tools).toStrictEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin-owned tools when manifest tool metadata has env auth evidence", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: { XAI_API_KEY: "test-key" },
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    setActivePluginRegistry(
      {
        plugins: [{ id: "xai", status: "loaded" }],
        tools: [
          {
            pluginId: "xai",
            optional: false,
            source: "/tmp/xai.js",
            names: ["x_search"],
            factory,
          },
        ],
        diagnostics: [],
      } as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );

    const tools = resolvePluginTools({
      context: {
        ...createContext(),
        config,
      } as never,
      env: {
        XAI_API_KEY: "test-key",
      },
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin-owned tools when manifest config signals point at configured non-env SecretRefs", () => {
    const base = createContext();
    const config = {
      ...base.config,
      plugins: {
        ...base.config.plugins,
        entries: {
          xai: {
            config: {
              webSearch: {
                apiKey: {
                  source: "file",
                  provider: "vault",
                  id: "/xai/tool-key",
                },
              },
            },
          },
        },
      },
      secrets: {
        providers: {
          vault: {
            source: "file",
            path: "/tmp/openclaw-secrets.json",
            mode: "json",
          },
        },
      },
    } as const;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: createXaiToolManifest(),
    });
    const factory = vi.fn(() => makeTool("x_search"));
    setActivePluginRegistry(
      {
        plugins: [{ id: "xai", status: "loaded" }],
        tools: [
          {
            pluginId: "xai",
            optional: false,
            source: "/tmp/xai.js",
            names: ["x_search"],
            factory,
          },
        ],
        diagnostics: [],
      } as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );

    const tools = resolvePluginTools({
      context: {
        ...base,
        config,
      } as never,
      env: {},
    });

    expectResolvedToolNames(tools, ["x_search"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("skips optional tools without explicit allowlist", () => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools();

    expect(tools).toHaveLength(0);
  });

  it("does not invoke named optional tool factories without a matching allowlist", () => {
    const factory = vi.fn(() => makeTool("optional_tool"));
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: ["optional_tool"],
        factory,
      },
    ]);

    expect(resolveOptionalDemoTools()).toHaveLength(0);
    expect(resolveOptionalDemoTools(["other_tool"])).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
  });

  it("invokes unnamed optional tool factories when a tool allowlist may match the result", () => {
    const factory = vi.fn(() => makeTool("optional_tool"));
    setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: [],
        declaredNames: ["optional_tool"],
        factory,
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "allows optional tools by tool name",
      toolAllowlist: ["optional_tool"],
    },
    {
      name: "allows optional tools via plugin id",
      toolAllowlist: ["optional-demo"],
    },
    {
      name: "allows optional tools via plugin-scoped allowlist entries",
      toolAllowlist: ["optional_tool", "tavily"],
    },
  ] as const)("$name", ({ toolAllowlist }) => {
    setOptionalDemoRegistry();
    const tools = resolveOptionalDemoTools(toolAllowlist);

    expectResolvedToolNames(tools, ["optional_tool"]);
  });

  it("keeps default non-optional plugin tools when alsoAllow opts into optional tools", () => {
    const defaultEntry: MockRegistryToolEntry = {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["other_tool"],
      declaredNames: ["other_tool"],
      factory: () => makeTool("other_tool"),
    };
    setRegistry([defaultEntry, createOptionalDemoEntry()]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["other_tool", "optional_tool"]);
  });

  it("cold-loads default plugin tools when alsoAllow opts into optional tools", () => {
    const context = createContext();
    const config = context.config;
    const defaultEntry: MockRegistryToolEntry = {
      pluginId: "multi",
      optional: false,
      source: "/tmp/multi.js",
      names: ["other_tool"],
      declaredNames: ["other_tool"],
      factory: () => makeTool("other_tool"),
    };
    loadOpenClawPluginsMock.mockReturnValue(
      createToolRegistry([defaultEntry, createOptionalDemoEntry()]),
    );
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "multi",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["other_tool"],
          },
        },
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
        },
      ],
    });

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["other_tool", "optional_tool"]);
    expectLoaderSelectedOnlyPluginIds(["multi", "optional-demo"]);
  });

  it("does not cold-load unrelated manifest-optional plugins when alsoAllow opts into one optional tool", () => {
    const context = createContext();
    const config = context.config;
    const explicitOptionalEntry = createOptionalDemoEntry();
    loadOpenClawPluginsMock.mockReturnValue(createToolRegistry([explicitOptionalEntry]));
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
          toolMetadata: {
            optional_tool: {
              optional: true,
            },
          },
        },
        {
          id: "unrelated-optional",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["unrelated_optional_tool"],
          },
          toolMetadata: {
            unrelated_optional_tool: {
              optional: true,
            },
          },
        },
      ],
    });

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context,
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderSelectedOnlyPluginIds(["optional-demo"]);
  });

  it("does not materialize manifest-unavailable default tools from warm registries under alsoAllow", () => {
    const config = createContext().config;
    installToolManifestSnapshots({
      config,
      env: {},
      plugins: [
        createXaiToolManifest(),
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
          toolMetadata: {
            optional_tool: {
              optional: true,
            },
          },
        },
      ],
    });
    const unavailableFactory = vi.fn(() => makeTool("x_search"));
    const optionalFactory = vi.fn(() => makeTool("optional_tool"));
    setActivePluginRegistry(
      createToolRegistry([
        {
          pluginId: "xai",
          optional: false,
          source: "/tmp/xai.js",
          names: ["x_search"],
          declaredNames: ["x_search"],
          factory: unavailableFactory,
        },
        {
          pluginId: "optional-demo",
          optional: true,
          source: "/tmp/optional-demo.js",
          names: ["optional_tool"],
          declaredNames: ["optional_tool"],
          factory: optionalFactory,
        },
      ]) as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          config,
        },
        env: {},
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(optionalFactory).toHaveBeenCalledTimes(1);
    expect(unavailableFactory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not materialize manifest-unavailable optional sibling tools under alsoAllow", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      env: {},
      plugin: {
        id: "multi",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        providerAuthEnvVars: {
          xai: ["XAI_API_KEY"],
        },
        contracts: {
          tools: ["other_tool", "optional_tool"],
        },
        toolMetadata: {
          optional_tool: {
            optional: true,
            authSignals: [{ provider: "xai" }],
          },
        },
      },
    });
    const defaultFactory = vi.fn(() => makeTool("other_tool"));
    const optionalFactory = vi.fn(() => makeTool("optional_tool"));
    setActivePluginRegistry(
      createToolRegistry([
        {
          pluginId: "multi",
          optional: false,
          source: "/tmp/multi.js",
          names: ["other_tool"],
          declaredNames: ["other_tool"],
          factory: defaultFactory,
        },
        {
          pluginId: "multi",
          optional: true,
          source: "/tmp/multi.js",
          names: ["optional_tool"],
          declaredNames: ["optional_tool"],
          factory: optionalFactory,
        },
      ]) as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          config,
        },
        env: {},
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["other_tool"]);
    expect(defaultFactory).toHaveBeenCalledTimes(1);
    expect(optionalFactory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not materialize manifest-optional sibling tools from non-optional factories by default", async () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "multi",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["other_tool", "optional_tool"],
        },
        toolMetadata: {
          optional_tool: {
            optional: true,
          },
        },
      },
    });
    const factory = vi.fn(() => [makeTool("other_tool"), makeTool("optional_tool")]);
    setActivePluginRegistry(
      createToolRegistry([
        {
          pluginId: "multi",
          optional: false,
          source: "/tmp/multi.js",
          names: ["other_tool", "optional_tool"],
          declaredNames: ["other_tool", "optional_tool"],
          factory,
        },
      ]) as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );
    const { loadManifestContractSnapshot } = await import("./manifest-contract-eligibility.js");
    const snapshot = loadManifestContractSnapshot({ config, workspaceDir: "/tmp" });
    const optionalToolMetadata = snapshot.plugins.find((plugin) => plugin.id === "multi")
      ?.toolMetadata?.optional_tool;
    expect(optionalToolMetadata?.optional).toBe(true);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          config,
        },
      }),
    );

    expectResolvedToolNames(tools, ["other_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("marks allowlisted manifest-optional sibling tools from non-optional factories as optional", () => {
    const config = createContext().config;
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "multi",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["other_tool", "optional_tool"],
        },
        toolMetadata: {
          optional_tool: {
            optional: true,
          },
        },
      },
    });
    const factory = vi.fn(() => [makeTool("other_tool"), makeTool("optional_tool")]);
    setActivePluginRegistry(
      createToolRegistry([
        {
          pluginId: "multi",
          optional: false,
          source: "/tmp/multi.js",
          names: ["other_tool", "optional_tool"],
          declaredNames: ["other_tool", "optional_tool"],
          factory,
        },
      ]) as never,
      "test-tool-registry",
      "gateway-bindable",
      "/tmp",
    );

    const first = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          config,
        },
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );
    const second = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          config,
        },
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY, "optional_tool"],
      }),
    );

    expectResolvedToolNames(first, ["other_tool", "optional_tool"]);
    expectResolvedToolNames(second, ["other_tool", "optional_tool"]);
    expect(getPluginToolMeta(first[0])?.optional).toBe(false);
    expect(getPluginToolMeta(first[1])?.optional).toBe(true);
    expect(getPluginToolMeta(second[1])?.optional).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects plugin id collisions with core tool names", () => {
    const registry = setRegistry([
      {
        pluginId: "message",
        optional: false,
        source: "/tmp/message.js",
        names: ["optional_tool"],
        factory: () => makeTool("optional_tool"),
      },
    ]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        existingToolNames: new Set(["message"]),
      }),
    );

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin id conflicts with core tool name");
  });

  it.each([
    {
      name: "skips conflicting tool names but keeps other tools",
      expectedDiagnosticFragment: "plugin tool name conflict",
    },
    {
      name: "suppresses conflict diagnostics when requested",
      suppressNameConflicts: true,
    },
  ] as const)("$name", ({ suppressNameConflicts, expectedDiagnosticFragment }) => {
    expectConflictingCoreNameResolution({
      suppressNameConflicts,
      expectedDiagnosticFragment,
    });
  });

  it("rejects normalized plugin tool name collisions with core tools", () => {
    const registry = setRegistry([
      {
        pluginId: "multi",
        optional: false,
        source: "/tmp/multi.js",
        names: ["Message", "other_tool"],
        declaredNames: ["Message", "other_tool"],
        factory: () => [makeTool("Message"), makeTool("other_tool")],
      },
    ]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        existingToolNames: new Set(["message"]),
      }),
    );

    expectResolvedToolNames(tools, ["other_tool"]);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool name conflict (multi): Message",
    );
  });

  it("rejects normalized cached plugin tool name collisions with core tools", () => {
    const factory = vi.fn(() => makeTool("Message"));
    setRegistry([
      {
        pluginId: "multi",
        optional: false,
        source: "/tmp/multi.js",
        names: ["Message"],
        declaredNames: ["Message"],
        factory,
      },
    ]);

    const first = resolvePluginTools(createResolveToolsParams());
    const second = resolvePluginTools(
      createResolveToolsParams({
        existingToolNames: new Set(["message"]),
      }),
    );

    expectResolvedToolNames(first, ["Message"]);
    expect(second).toStrictEqual([]);
    expect(factory).toHaveBeenCalled();
  });

  it.each([
    {
      name: "uses loaded plugin tools with an explicit env",
      params: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" },
      },
    },
    {
      name: "uses loaded plugin tools with gateway subagent binding",
      params: {
        allowGatewaySubagentBinding: true,
        toolAllowlist: ["optional_tool"],
      },
      expectedLoaderCall: {
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      },
    },
  ])("$name", ({ params, expectedLoaderCall }) => {
    setOptionalDemoRegistry();
    if (params.env) {
      installToolManifestSnapshot({
        config: createContext().config,
        env: params.env,
        plugin: {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
        },
      });
    }

    resolvePluginTools(createResolveToolsParams(params));

    expectLoaderCall(expectedLoaderCall);
  });

  it("skips malformed plugin tools while keeping valid sibling tools", () => {
    const registry = setRegistry([
      {
        pluginId: "schema-bug",
        optional: false,
        source: "/tmp/schema-bug.js",
        names: ["broken_tool", "valid_tool"],
        factory: () => [createMalformedTool("broken_tool"), makeTool("valid_tool")],
      },
    ]);

    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["valid_tool"]);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (schema-bug): broken_tool missing parameters object",
    );
  });

  it("warns with plugin factory timing details when a factory is slow", () => {
    vi.useFakeTimers({ now: 0 });
    const warnSpy = installConsoleMethodSpy("warn");
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(1200);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = requireConsoleMessage(warnSpy);
    expect(message).toContain("[trace:plugin-tools] factory timings");
    expect(message).toContain("totalMs=1200");
    expect(message).toContain("optional-demo:1200ms@1200ms");
    expect(message).toContain("names=[optional_tool]");
    expect(message).toContain("result=single");
    expect(message).toContain("count=1");
  });

  it("emits trace factory timings below the warn threshold when trace logging is enabled", () => {
    vi.useFakeTimers({ now: 0 });
    const logSpy = installConsoleMethodSpy("log");
    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(5);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const message = requireConsoleMessage(logSpy);
    expect(message).toContain("[trace:plugin-tools] factory timings");
    expect(message).toContain("totalMs=5");
    expect(message).toContain("optional-demo:5ms@5ms");
  });

  it("does not log plugin factory timings for fast factories without trace logging", () => {
    vi.useFakeTimers({ now: 0 });
    const warnSpy = installConsoleMethodSpy("warn");
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    setRegistry([
      {
        pluginId: "optional-demo",
        names: ["optional_tool"],
        optional: true,
        source: "/tmp/optional-demo.js",
        factory: () => {
          vi.advanceTimersByTime(5);
          return makeTool("optional_tool");
        },
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("caches plugin tool descriptors and uses the runtime only on execution", async () => {
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { sessionId?: string };
      return {
        ...makeTool("cached_tool"),
        async execute() {
          return { content: [{ type: "text", text: ctx.sessionId ?? "missing" }] };
        },
      };
    });
    setRegistry([
      {
        pluginId: "cache-test",
        optional: false,
        source: "/tmp/cache-test.js",
        names: ["cached_tool"],
        factory,
      },
    ]);

    const first = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sessionId: "same" },
      }),
    );
    const second = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sessionId: "same" },
      }),
    );

    expectResolvedToolNames(first, ["cached_tool"]);
    expectResolvedToolNames(second, ["cached_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second[0]).not.toBe(first[0]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();

    await expect(second[0]?.execute("call", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "same" }],
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("reuses cached plugin tool descriptors across session identity changes", async () => {
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { sessionId?: string };
      return {
        ...makeTool("cached_session_tool"),
        async execute() {
          return { content: [{ type: "text", text: ctx.sessionId ?? "missing" }] };
        },
      };
    });
    setRegistry([
      {
        pluginId: "cache-session-test",
        optional: false,
        source: "/tmp/cache-session-test.js",
        names: ["cached_session_tool"],
        factory,
      },
    ]);

    const first = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          sessionId: "first-session",
          sessionKey: "agent:main:first-session",
        },
      }),
    );
    const second = resolvePluginTools(
      createResolveToolsParams({
        context: {
          ...createContext(),
          sessionId: "second-session",
          sessionKey: "agent:main:second-session",
        },
      }),
    );

    expectResolvedToolNames(first, ["cached_session_tool"]);
    expectResolvedToolNames(second, ["cached_session_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);

    await expect(second[0]?.execute("call", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "second-session" }],
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached plugin tool descriptors across sandbox context changes", () => {
    const factory = vi.fn((rawCtx: unknown) => {
      const ctx = rawCtx as { sandboxed?: boolean };
      return ctx.sandboxed ? null : makeTool("sandbox_sensitive_tool");
    });
    setRegistry([
      {
        pluginId: "sandbox-sensitive",
        optional: false,
        source: "/tmp/sandbox-sensitive.js",
        names: ["sandbox_sensitive_tool"],
        factory,
      },
    ]);

    const hostTools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sandboxed: false },
      }),
    );
    const sandboxedTools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), sandboxed: true },
      }),
    );

    expectResolvedToolNames(hostTools, ["sandbox_sensitive_tool"]);
    expect(sandboxedTools).toStrictEqual([]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("executes cached plugin tools registered with implicit names", async () => {
    const factory = vi.fn(() => ({
      ...makeTool("implicit_tool"),
      async execute() {
        return { content: [{ type: "text", text: "implicit-ok" }] };
      },
    }));
    setRegistry([
      {
        pluginId: "implicit-owner",
        optional: false,
        source: "/tmp/implicit-owner.js",
        names: [],
        declaredNames: ["implicit_tool"],
        factory,
      },
    ]);

    const first = resolvePluginTools(createResolveToolsParams());
    const second = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(first, ["implicit_tool"]);
    expectResolvedToolNames(second, ["implicit_tool"]);
    expect(factory).toHaveBeenCalledTimes(1);

    await expect(second[0]?.execute("call", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "implicit-ok" }],
    });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("executes the matching cached plugin tool when unnamed factories share declared names", async () => {
    const alphaFactory = vi.fn(() => ({
      ...makeTool("implicit_alpha"),
      async execute() {
        return { content: [{ type: "text", text: "implicit-alpha-ok" }] };
      },
    }));
    const betaFactory = vi.fn(() => ({
      ...makeTool("implicit_beta"),
      async execute() {
        return { content: [{ type: "text", text: "implicit-beta-ok" }] };
      },
    }));
    setRegistry([
      {
        pluginId: "implicit-owner",
        optional: false,
        source: "/tmp/implicit-owner.js",
        names: [],
        declaredNames: ["implicit_alpha", "implicit_beta"],
        factory: alphaFactory,
      },
      {
        pluginId: "implicit-owner",
        optional: false,
        source: "/tmp/implicit-owner.js",
        names: [],
        declaredNames: ["implicit_alpha", "implicit_beta"],
        factory: betaFactory,
      },
    ]);

    const first = resolvePluginTools(createResolveToolsParams());
    const second = resolvePluginTools(createResolveToolsParams());
    const betaTool = second.find((tool) => tool.name === "implicit_beta");

    expectResolvedToolNames(first, ["implicit_alpha", "implicit_beta"]);
    expectResolvedToolNames(second, ["implicit_alpha", "implicit_beta"]);
    await expect(betaTool?.execute("call", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "implicit-beta-ok" }],
    });
    expect(alphaFactory).toHaveBeenCalledTimes(2);
    expect(betaFactory).toHaveBeenCalledTimes(2);
  });

  it("does not invoke unrelated named factories before cached unnamed tool fallback", async () => {
    const namedFactory = vi.fn(() => makeTool("unrelated_tool"));
    const implicitFactory = vi.fn(() => ({
      ...makeTool("implicit_tool"),
      async execute() {
        return { content: [{ type: "text", text: "implicit-ok" }] };
      },
    }));
    setRegistry([
      {
        pluginId: "implicit-owner",
        optional: false,
        source: "/tmp/implicit-owner.js",
        names: ["unrelated_tool"],
        declaredNames: ["unrelated_tool"],
        factory: namedFactory,
      },
      {
        pluginId: "implicit-owner",
        optional: false,
        source: "/tmp/implicit-owner.js",
        names: [],
        declaredNames: ["implicit_tool"],
        factory: implicitFactory,
      },
    ]);

    resolvePluginTools(createResolveToolsParams());
    const cachedTools = resolvePluginTools(createResolveToolsParams());
    namedFactory.mockClear();
    implicitFactory.mockClear();

    const implicitTool = cachedTools.find((tool) => tool.name === "implicit_tool");
    await expect(implicitTool?.execute("call", {}, undefined)).resolves.toEqual({
      content: [{ type: "text", text: "implicit-ok" }],
    });
    expect(namedFactory).not.toHaveBeenCalled();
    expect(implicitFactory).toHaveBeenCalledTimes(1);
  });

  it("skips factory-returned tools outside the manifest tool contract", () => {
    const registry = setRegistry([
      {
        pluginId: "dynamic-owner",
        optional: false,
        source: "/tmp/dynamic-owner.js",
        names: ["declared_tool"],
        declaredNames: ["declared_tool"],
        factory: () => [makeTool("declared_tool"), makeTool("rogue_tool")],
      },
    ]);

    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["declared_tool"]);
    expectSingleDiagnosticMessage(registry.diagnostics, "plugin tool is undeclared");
  });

  it("skips allowlisted optional malformed plugin tools", () => {
    const registry = setRegistry([
      {
        pluginId: "optional-demo",
        optional: true,
        source: "/tmp/optional-demo.js",
        names: ["optional_tool"],
        factory: () => createMalformedTool("optional_tool"),
      },
    ]);

    const tools = resolveOptionalDemoTools(["optional_tool"]);

    expect(tools).toHaveLength(0);
    expectSingleDiagnosticMessage(
      registry.diagnostics,
      "plugin tool is malformed (optional-demo): optional_tool missing parameters object",
    );
  });

  it.each([
    {
      name: "loads plugin tools from the auto-enabled config snapshot",
      expectedToolNames: undefined,
    },
    {
      name: "does not reuse a cached active registry when auto-enable changes the config snapshot",
      expectedToolNames: ["optional_tool"],
    },
  ] as const)("$name", ({ expectedToolNames }) => {
    const { rawContext, autoEnabledConfig, tools } = resolveAutoEnabledOptionalDemoTools();

    const autoEnableParams = mockCallParams(applyPluginAutoEnableMock) as {
      config?: { plugins?: { allow?: unknown; load?: unknown } };
      env?: unknown;
    };
    expect(autoEnableParams.config?.plugins?.allow).toEqual(rawContext.config.plugins?.allow);
    expect(autoEnableParams.config?.plugins?.load).toEqual(rawContext.config.plugins?.load);
    expect(autoEnableParams.env).toBe(process.env);
    if (expectedToolNames) {
      expectResolvedToolNames(tools, expectedToolNames);
    }
    expectAutoEnabledOptionalLoad(autoEnabledConfig);
  });

  it("reuses a compatible active registry instead of loading again", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses the gateway-bindable registry when it covers the tool runtime scope", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable", "/tmp");
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not widen active registry reuse to non-matching plugin tool owners", () => {
    installToolManifestSnapshot({
      config: createContext().config,
      plugin: {
        id: "optional-demo",
        origin: "bundled",
        enabledByDefault: true,
        channels: [],
        providers: [],
        contracts: {
          tools: ["optional_tool"],
        },
      },
    });
    const heavyFactory = vi.fn(() => makeTool("heavy_tool"));
    const activeRegistry = {
      plugins: [
        { id: "optional-demo", status: "loaded" },
        { id: "heavy-startup", status: "loaded" },
      ],
      tools: [
        createOptionalDemoEntry(),
        {
          pluginId: "heavy-startup",
          optional: false,
          source: "/tmp/heavy-startup.js",
          names: ["heavy_tool"],
          factory: heavyFactory,
        },
      ],
      diagnostics: [],
    };
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable", "/tmp");
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(heavyFactory).not.toHaveBeenCalled();
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not let disabled bundled tool owners poison explicit runtime allowlists", () => {
    const config = {
      plugins: {
        enabled: true,
        allow: ["memory-core", "memory-lancedb"],
        load: { paths: [] },
        entries: {
          "memory-core": { enabled: true },
          "memory-lancedb": { enabled: false },
        },
        slots: { memory: "memory-core" },
      },
    };
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "memory-core",
          origin: "bundled",
          enabledByDefault: false,
          channels: [],
          providers: [],
          contracts: {
            tools: ["memory_get", "memory_search"],
          },
        },
        {
          id: "memory-lancedb",
          origin: "bundled",
          enabledByDefault: false,
          channels: [],
          providers: [],
          contracts: {
            tools: ["memory_recall"],
          },
        },
      ],
    });
    const memorySearchFactory = vi.fn(() => [makeTool("memory_search"), makeTool("memory_get")]);
    const activeRegistry = {
      plugins: [
        { id: "memory-core", status: "loaded" },
        { id: "memory-lancedb", status: "disabled" },
      ],
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          declaredNames: ["memory_search", "memory_get"],
          factory: memorySearchFactory,
        },
      ],
      diagnostics: [],
    };
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable", "/tmp");
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), config },
        toolAllowlist: ["memory_recall", "memory_search", "memory_get"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["memory_search", "memory_get"]);
    expect(memorySearchFactory).toHaveBeenCalledTimes(1);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("falls back from a loaded channel registry without matching tool entries", () => {
    const config = {
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        load: { paths: [] },
        entries: {
          "memory-core": { enabled: true },
        },
        slots: { memory: "memory-core" },
      },
    };
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "memory-core",
        origin: "bundled",
        enabledByDefault: false,
        channels: [],
        providers: [],
        contracts: {
          tools: ["memory_get", "memory_search"],
        },
      },
    });
    const memorySearchFactory = vi.fn(() => [makeTool("memory_search"), makeTool("memory_get")]);
    const activeRegistry = {
      plugins: [{ id: "memory-core", status: "loaded" }],
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          declaredNames: ["memory_search", "memory_get"],
          factory: memorySearchFactory,
        },
      ],
      diagnostics: [],
    };
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable", "/tmp");
    pinActivePluginChannelRegistry({
      plugins: [{ id: "memory-core", status: "loaded" }],
      tools: [],
      diagnostics: [],
    } as never);
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), config },
        toolAllowlist: ["memory_search", "memory_get"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["memory_search", "memory_get"]);
    expect(memorySearchFactory).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads a standalone registry when cached runtime registries lack matching tool entries", () => {
    const config = {
      plugins: {
        enabled: true,
        allow: ["memory-core"],
        load: { paths: [] },
        entries: {
          "memory-core": { enabled: true },
        },
        slots: { memory: "memory-core" },
      },
    };
    installToolManifestSnapshot({
      config,
      plugin: {
        id: "memory-core",
        origin: "bundled",
        enabledByDefault: false,
        channels: [],
        providers: [],
        contracts: {
          tools: ["memory_get", "memory_search"],
        },
      },
    });
    const memorySearchFactory = vi.fn(() => [makeTool("memory_search"), makeTool("memory_get")]);
    const loadedRegistry = {
      plugins: [{ id: "memory-core", status: "loaded" }],
      tools: [
        {
          pluginId: "memory-core",
          optional: false,
          source: "/tmp/memory-core.js",
          names: ["memory_search", "memory_get"],
          declaredNames: ["memory_search", "memory_get"],
          factory: memorySearchFactory,
        },
      ],
      diagnostics: [],
    };
    setActivePluginRegistry(
      {
        plugins: [{ id: "memory-core", status: "loaded" }],
        tools: [],
        diagnostics: [],
      } as never,
      "gateway-startup",
      "gateway-bindable",
      "/tmp",
    );
    pinActivePluginChannelRegistry({
      plugins: [{ id: "memory-core", status: "loaded" }],
      tools: [],
      diagnostics: [],
    } as never);
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
    loadOpenClawPluginsMock.mockReturnValue(loadedRegistry);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        context: { ...createContext(), config },
        toolAllowlist: ["memory_search", "memory_get"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["memory_search", "memory_get"]);
    expect(memorySearchFactory).toHaveBeenCalledTimes(1);
    const loaderParams = mockCallParams(loadOpenClawPluginsMock) as {
      activate?: unknown;
      onlyPluginIds?: unknown;
      toolDiscovery?: unknown;
    };
    expect(loaderParams.activate).toBe(false);
    expect(loaderParams.onlyPluginIds).toEqual(["memory-core"]);
    expect(loaderParams.toolDiscovery).toBe(true);
  });

  it("adds enabled non-startup tool plugins to the active tool runtime scope", () => {
    const activeRegistry = createOptionalDemoActiveRegistry();
    const context = createContext();
    const config = {
      ...context.config,
      plugins: {
        ...context.config.plugins,
        allow: ["tavily"],
        entries: {
          tavily: { enabled: true },
        },
      },
    };
    installToolManifestSnapshots({
      config,
      plugins: [
        {
          id: "optional-demo",
          origin: "bundled",
          enabledByDefault: true,
          channels: [],
          providers: [],
          contracts: {
            tools: ["optional_tool"],
          },
        },
        {
          id: "tavily",
          origin: "bundled",
          enabledByDefault: false,
          channels: [],
          providers: [],
          contracts: {
            tools: ["tavily_search"],
          },
        },
      ],
    });
    setActivePluginRegistry(activeRegistry as never, "gateway-startup", "gateway-bindable", "/tmp");
    resolveRuntimePluginRegistryMock.mockReturnValue(activeRegistry);
    loadOpenClawPluginsMock.mockReturnValue(createToolRegistry([]));

    resolvePluginTools({
      context: {
        ...context,
        config,
      } as never,
      toolAllowlist: ["*", "tavily"],
      allowGatewaySubagentBinding: true,
    });
    const runtimeRegistryParams = mockCallParams(resolveRuntimePluginRegistryMock) as {
      onlyPluginIds?: string[];
      toolDiscovery?: unknown;
    };
    expect(runtimeRegistryParams.onlyPluginIds).toContain("tavily");
    expect(runtimeRegistryParams.toolDiscovery).toBe(true);
    const loaderParams = mockCallParams(loadOpenClawPluginsMock) as {
      onlyPluginIds?: string[];
      toolDiscovery?: unknown;
    };
    expect(loaderParams.onlyPluginIds).toContain("tavily");
    expect(loaderParams.toolDiscovery).toBe(true);
  });

  it("reuses the pinned gateway channel registry after provider runtime loads replace active registry", () => {
    const gatewayRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(
      gatewayRegistry as never,
      "gateway-startup",
      "gateway-bindable",
      "/tmp",
    );
    pinActivePluginChannelRegistry(gatewayRegistry as never);
    setActivePluginRegistry(
      {
        plugins: [],
        tools: [],
        diagnostics: [],
      } as never,
      "provider-runtime",
      "default",
      "/tmp",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("reuses the pinned gateway channel registry even when the caller omits gateway binding", () => {
    const gatewayRegistry = createOptionalDemoActiveRegistry();
    setActivePluginRegistry(
      gatewayRegistry as never,
      "gateway-startup",
      "gateway-bindable",
      "/tmp",
    );
    pinActivePluginChannelRegistry(gatewayRegistry as never);
    setActivePluginRegistry(
      {
        plugins: [],
        tools: [],
        diagnostics: [],
      } as never,
      "provider-runtime",
      "default",
      "/tmp",
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expect(resolveRuntimePluginRegistryMock).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads plugin tools when gateway-bindable tool loads have no active registry", () => {
    setOptionalDemoRegistry();

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["optional_tool"],
        allowGatewaySubagentBinding: true,
      }),
    );

    expectResolvedToolNames(tools, ["optional_tool"]);
    expectLoaderCall({
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  });

  it("reloads when gateway binding would otherwise reuse a default-mode active registry", () => {
    setActivePluginRegistry(
      {
        plugins: [],
        tools: [],
        diagnostics: [],
      } as never,
      "default-registry",
      "default",
    );
    setOptionalDemoRegistry();

    resolvePluginTools({
      context: createContext() as never,
      allowGatewaySubagentBinding: true,
      toolAllowlist: ["optional_tool"],
    });

    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("includes non-optional browser tool when toolAllowlist is empty (full profile)", () => {
    const browserEntry: MockRegistryToolEntry = {
      pluginId: "browser",
      optional: false,
      source: "/tmp/browser.js",
      names: ["browser"],
      declaredNames: ["browser"],
      factory: () => makeTool("browser"),
    };
    setRegistry([browserEntry]);

    // Empty toolAllowlist simulates tools.profile: "full" where no explicit
    // allow list exists. Non-optional plugin tools must still be resolved.
    const tools = resolvePluginTools(createResolveToolsParams({ toolAllowlist: [] }));

    expectResolvedToolNames(tools, ["browser"]);
  });

  it("includes non-optional browser tool when toolAllowlist is undefined (full profile)", () => {
    const browserEntry: MockRegistryToolEntry = {
      pluginId: "browser",
      optional: false,
      source: "/tmp/browser.js",
      names: ["browser"],
      declaredNames: ["browser"],
      factory: () => makeTool("browser"),
    };
    setRegistry([browserEntry]);

    // Undefined toolAllowlist is the other variant of "no explicit allowlist".
    const tools = resolvePluginTools(createResolveToolsParams());

    expectResolvedToolNames(tools, ["browser"]);
  });

  it("includes non-optional browser tool when toolAllowlist has wildcard (#76507)", () => {
    const browserEntry: MockRegistryToolEntry = {
      pluginId: "browser",
      optional: false,
      source: "/tmp/browser.js",
      names: ["browser"],
      declaredNames: ["browser"],
      factory: () => makeTool("browser"),
    };
    setRegistry([browserEntry]);

    // Wildcard allowlist from tools.profile: "full" explicitly grants all tools.
    const tools = resolvePluginTools(createResolveToolsParams({ toolAllowlist: ["*"] }));

    expectResolvedToolNames(tools, ["browser"]);
  });

  it("does not materialize plugin tools blocked by explicit deny policy", () => {
    const browserFactory = vi.fn(() => makeTool("browser"));
    const browserEntry: MockRegistryToolEntry = {
      pluginId: "browser",
      optional: false,
      source: "/tmp/browser.js",
      names: ["browser"],
      declaredNames: ["browser"],
      factory: browserFactory,
    };
    setRegistry([browserEntry]);

    const tools = resolvePluginTools(
      createResolveToolsParams({
        toolAllowlist: ["*"],
        toolDenylist: ["browser"],
      }),
    );

    expectResolvedToolNames(tools, []);
    expect(browserFactory).not.toHaveBeenCalled();
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("includes optional tools when wildcard allowlist is active (#76507)", () => {
    setOptionalDemoRegistry();

    // Wildcard must grant optional tools too.
    const tools = resolvePluginTools(createResolveToolsParams({ toolAllowlist: ["*"] }));

    expectResolvedToolNames(tools, ["optional_tool"]);
  });
});

describe("buildPluginToolMetadataKey", () => {
  beforeAll(async () => {
    ({ buildPluginToolMetadataKey } = await import("./tools.js"));
  });

  it("does not collide when ids or names contain separator-like characters", () => {
    expect(buildPluginToolMetadataKey("plugin", "a\uE000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\uE000a", "b"),
    );
    expect(buildPluginToolMetadataKey("plugin", "a\u0000b")).not.toBe(
      buildPluginToolMetadataKey("plugin\u0000a", "b"),
    );
  });
});
