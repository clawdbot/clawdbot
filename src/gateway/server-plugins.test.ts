import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { PluginDiagnostic } from "../plugins/types.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const resolveGatewayStartupPluginIds = vi.hoisted(() => vi.fn(() => ["discord", "telegram"]));
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }) => ({ config, changes: [], autoEnabledReasons: {} })),
);
const primeConfiguredBindingRegistry = vi.hoisted(() =>
  vi.fn(() => ({ bindingCount: 0, channelCount: 0 })),
);
const pluginRuntimeLoaderLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../plugins/runtime/load-context.js", () => ({
  createPluginRuntimeLoaderLogger: () => pluginRuntimeLoaderLogger,
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveGatewayStartupPluginIds,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../channels/plugins/binding-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/binding-registry.js")>(
    "../channels/plugins/binding-registry.js",
  );
  return {
    ...actual,
    primeConfiguredBindingRegistry,
  };
});

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

vi.mock("../channels/registry.js", () => ({
  CHAT_CHANNEL_ORDER: [],
  CHANNEL_IDS: [],
  listChatChannels: () => [],
  listChatChannelAliases: () => [],
  getChatChannelMeta: () => null,
  normalizeChatChannelId: () => null,
  normalizeChannelId: () => null,
  normalizeAnyChannelId: () => null,
  formatChannelPrimerLine: () => "",
  formatChannelSelectionLine: () => "",
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  plugins: [],
  tools: [],
  hooks: [],
  typedHooks: [],
  channels: [],
  channelSetups: [],
  commands: [],
  providers: [],
  speechProviders: [],
  realtimeTranscriptionProviders: [],
  realtimeVoiceProviders: [],
  mediaUnderstandingProviders: [],
  imageGenerationProviders: [],
  musicGenerationProviders: [],
  videoGenerationProviders: [],
  webFetchProviders: [],
  webSearchProviders: [],
  memoryEmbeddingProviders: [],
  codexAppServerExtensionFactories: [],
  agentToolResultMiddlewares: [],
  textTransforms: [],
  agentHarnesses: [],
  gatewayHandlers: {},
  httpRoutes: [],
  cliRegistrars: [],
  services: [],
  gatewayDiscoveryServices: [],
  conversationBindingResolvedHandlers: [],
  diagnostics,
});

type ServerPluginsModule = typeof import("./server-plugins.js");
type ServerPluginBootstrapModule = typeof import("./server-plugin-bootstrap.js");
type PluginRuntimeModule = typeof import("../plugins/runtime/index.js");
type PluginRuntimeRegistryModule = typeof import("../plugins/runtime.js");
type GatewayRequestScopeModule = typeof import("../plugins/runtime/gateway-request-scope.js");
type MethodScopesModule = typeof import("./method-scopes.js");
type RuntimeStateModule = typeof import("../plugins/runtime-state.js");

let serverPluginsModule: ServerPluginsModule;
let serverPluginBootstrapModule: ServerPluginBootstrapModule;
let runtimeModule: PluginRuntimeModule;
let runtimeRegistryModule: PluginRuntimeRegistryModule;
let gatewayRequestScopeModule: GatewayRequestScopeModule;
let methodScopesModule: MethodScopesModule;
let getActivePluginRegistryWorkspaceDirFromState: typeof import("../plugins/runtime-state.js").getActivePluginRegistryWorkspaceDirFromState;

function createTestLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createTestContext(label: string): GatewayRequestContext {
  return { label } as unknown as GatewayRequestContext;
}

function getLastDispatchedContext(): GatewayRequestContext | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.context;
}

function getLastDispatchedParams(): Record<string, unknown> | undefined {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  return call?.req?.params as Record<string, unknown> | undefined;
}

function getLastDispatchedClientScopes(): string[] {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

function getLastPluginLoadLogger(): {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
} {
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | {
        logger?: {
          info: (message: string) => void;
          warn: (message: string) => void;
          error: (message: string) => void;
          debug?: (message: string) => void;
        };
      }
    | undefined;
  if (!call?.logger) {
    throw new Error("Expected plugin loader to receive a logger");
  }
  return call.logger;
}

async function loadTestModules() {
  serverPluginsModule = await import("./server-plugins.js");
  serverPluginBootstrapModule = await import("./server-plugin-bootstrap.js");
  runtimeModule = await import("../plugins/runtime/index.js");
  runtimeRegistryModule = await import("../plugins/runtime.js");
  gatewayRequestScopeModule = await import("../plugins/runtime/gateway-request-scope.js");
  methodScopesModule = await import("./method-scopes.js");
  const runtimeStateModule: RuntimeStateModule = await import("../plugins/runtime-state.js");
  ({ getActivePluginRegistryWorkspaceDirFromState } = runtimeStateModule);
}

async function createSubagentRuntime(
  _serverPlugins: ServerPluginsModule,
  cfg: Record<string, unknown> = {},
): Promise<PluginRuntime["subagent"]> {
  const log = createTestLog();
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  serverPluginBootstrapModule.loadGatewayStartupPlugins({
    cfg,
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
  });
  const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
    | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
    | undefined;
  if (call?.runtimeOptions?.allowGatewaySubagentBinding !== true) {
    throw new Error("Expected loadGatewayPlugins to opt into gateway subagent binding");
  }
  return runtimeModule.createPluginRuntime({ allowGatewaySubagentBinding: true }).subagent;
}

async function reloadServerPluginsModule(): Promise<ServerPluginsModule> {
  vi.resetModules();
  return await import("./server-plugins.js");
}

function loadGatewayPluginsForTest(
  overrides: Partial<Parameters<ServerPluginsModule["loadGatewayPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  serverPluginsModule.loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    ...overrides,
  });
  return log;
}

function loadGatewayStartupPluginsForTest(
  overrides: Partial<Parameters<ServerPluginBootstrapModule["loadGatewayStartupPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  serverPluginBootstrapModule.loadGatewayStartupPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    ...overrides,
  });
  return log;
}

beforeAll(async () => {
  await loadTestModules();
});

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  resolveGatewayStartupPluginIds.mockReset().mockReturnValue(["discord", "telegram"]);
  applyPluginAutoEnable
    .mockReset()
    .mockImplementation(({ config }) => ({ config, changes: [], autoEnabledReasons: {} }));
  primeConfiguredBindingRegistry.mockClear().mockReturnValue({ bindingCount: 0, channelCount: 0 });
  pluginRuntimeLoaderLogger.info.mockClear();
  pluginRuntimeLoaderLogger.warn.mockClear();
  pluginRuntimeLoaderLogger.error.mockClear();
  pluginRuntimeLoaderLogger.debug.mockClear();
  handleGatewayRequest.mockReset();
  runtimeModule.clearGatewaySubagentRuntime();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      case "sessions.get":
        opts.respond(true, { messages: [] });
        return;
      case "sessions.delete":
        opts.respond(true, {});
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(() => {
  runtimeModule.clearGatewaySubagentRuntime();
  runtimeRegistryModule.resetPluginRuntimeStateForTest();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", async () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = loadGatewayStartupPluginsForTest();

    expect(log.error).toHaveBeenCalledWith(
      "[plugins] failed to load plugin: boom (plugin=telegram, source=/tmp/telegram/index.ts)",
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("loads only gateway startup plugin ids", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: {},
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord", "telegram"],
      }),
    );
  });

  test("routes plugin registration logs through the plugin logger", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const log = loadGatewayPluginsForTest();

    const logger = getLastPluginLoadLogger();
    logger.info("plugin ready");
    logger.warn("plugin warning");

    expect(pluginRuntimeLoaderLogger.info).toHaveBeenCalledWith("plugin ready");
    expect(pluginRuntimeLoaderLogger.warn).toHaveBeenCalledWith("plugin warning");
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("can suppress provisional plugin info logs while preserving warnings", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest({
      suppressPluginInfoLogs: true,
    });

    const logger = getLastPluginLoadLogger();
    logger.info("plugin ready");
    logger.warn("plugin warning");

    expect(pluginRuntimeLoaderLogger.info).not.toHaveBeenCalled();
    expect(pluginRuntimeLoaderLogger.warn).toHaveBeenCalledWith("plugin warning");
  });

  test("reuses the provided startup plugin scope without recomputing it", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      pluginIds: ["browser"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["browser"],
      }),
    );
  });

  test("pins the initial startup channel registry against later active-registry churn", async () => {
    const startupRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(startupRegistry);

    loadGatewayStartupPluginsForTest({
      pluginIds: ["slack"],
    });

    const replacementRegistry = createRegistry([]);
    runtimeRegistryModule.setActivePluginRegistry(replacementRegistry);

    expect(runtimeRegistryModule.getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  test("keeps the raw activation source when a precomputed startup scope is reused", async () => {
    const rawConfig = { channels: { slack: { botToken: "x" } } };
    const resolvedConfig = {
      channels: { slack: { botToken: "x", enabled: true } },
      autoEnabled: true,
    };
    applyPluginAutoEnable.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayStartupPluginsForTest({
      cfg: resolvedConfig,
      activationSourceConfig: rawConfig,
      pluginIds: ["slack"],
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: rawConfig,
        onlyPluginIds: ["slack"],
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("treats an empty startup scope as no plugin load instead of an unscoped load", async () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    const result = serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: ["sessions.get"],
    });

    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(result.pluginRegistry.plugins).toEqual([]);
    expect(result.gatewayMethods).toEqual(["sessions.get"]);
  });

  test("stores workspaceDir on the active registry when startup scope is empty", () => {
    resolveGatewayStartupPluginIds.mockReturnValue([]);

    serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp/gateway-workspace",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/tmp/gateway-workspace");
  });

  test("loads gateway plugins from the auto-enabled config snapshot", async () => {
    const autoEnabledConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest();

    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: {},
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("re-derives auto-enable reasons when only activationSourceConfig is provided", async () => {
    const rawConfig = { channels: { slack: { enabled: true } } };
    const resolvedConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: resolvedConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      cfg: resolvedConfig,
      activationSourceConfig: rawConfig,
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(resolveGatewayStartupPluginIds).toHaveBeenCalledWith({
      config: resolvedConfig,
      activationSourceConfig: rawConfig,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: resolvedConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          slack: ["slack configured"],
        },
      }),
    );
  });

  test("provides subagent runtime with sessions.get method aliases", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    const call = loadOpenClawPlugins.mock.calls.at(-1)?.[0] as
      | { runtimeOptions?: { allowGatewaySubagentBinding?: boolean } }
      | undefined;
    expect(call?.runtimeOptions?.allowGatewaySubagentBinding).toBe(true);
    const subagent = runtimeModule.createPluginRuntime({
      allowGatewaySubagentBinding: true,
    }).subagent;
    expect(typeof subagent?.getSessionMessages).toBe("function");
    expect(typeof subagent?.getSession).toBe("function");
  });

  test("filters connected plugin nodes locally without sending unsupported node.list params", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("nodes-list-filter"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.req.method).toBe("node.list");
      opts.respond(true, {
        nodes: [
          { nodeId: "connected", connected: true },
          { nodeId: "offline", connected: false },
        ],
      });
    });

    const runtime = runtimeModule.createPluginRuntime({
      allowGatewaySubagentBinding: true,
    });
    const result = await runtime.nodes.list({ connected: true });

    expect(getLastDispatchedParams()).toEqual({});
    expect(result.nodes).toEqual([{ nodeId: "connected", connected: true }]);
  });

  test("forwards provider and model overrides when the request scope is authorized", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const scope = {
      context: createTestContext("request-scope-forward-overrides"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        sessionKey: "s-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-override",
      message: "use the override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      deliver: false,
    });
  });

  test("forwards caller-supplied idempotencyKey on subagent run", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("idempotency-forward"));

    await runtime.run({
      sessionKey: "s-idem-forward",
      message: "hello",
      deliver: false,
      idempotencyKey: "caller-provided-key",
    });

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-idem-forward",
      message: "hello",
      idempotencyKey: "caller-provided-key",
    });
  });

  test("forwards lightContext as lightweight bootstrap context on subagent run", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("light-context-forward"));

    await runtime.run({
      sessionKey: "s-light-context",
      message: "hello",
      lightContext: true,
      lane: "dreaming-narrative:s-light-context",
      deliver: false,
    });

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-light-context",
      message: "hello",
      lane: "dreaming-narrative:s-light-context",
      bootstrapContextMode: "lightweight",
      deliver: false,
    });
  });

  test("generates a non-empty idempotencyKey when the caller omits it", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("idempotency-generate"));

    await runtime.run({
      sessionKey: "s-idem-generate",
      message: "hello",
      deliver: false,
    });

    const params = getLastDispatchedParams();
    expect(params).toBeDefined();
    // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`, so
    // the runtime must always send a populated value. A missing field here
    // would reproduce the memory-core dreaming-narrative regression.
    const generated = params?.idempotencyKey;
    expect(typeof generated).toBe("string");
    expect((generated as string).length).toBeGreaterThan(0);
  });

  test("rejects provider/model overrides for fallback runs without explicit authorization", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-deny-overrides"));

    await expect(
      runtime.run({
        sessionKey: "s-fallback-override",
        message: "use the override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    ).rejects.toThrow(
      "provider/model override requires plugin identity in fallback subagent runs.",
    );
  });

  test("allows trusted fallback provider/model overrides when plugin config is explicit", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-trusted-overrides"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-trusted-override",
        message: "use trusted override",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-trusted-override",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  test("includes docs guidance when a plugin fallback override is not trusted", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-untrusted-plugin"));

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-untrusted-override",
          message: "use untrusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/tools/plugin#runtime-helpers and search for: plugins.entries.<id>.subagent.allowModelOverride',
    );
  });

  test("allows trusted fallback model-only overrides when the model ref is canonical", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-model-only-override"));
    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
      runtime.run({
        sessionKey: "s-model-only-override",
        message: "use trusted model-only override",
        model: "anthropic/claude-haiku-4-5",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-model-only-override",
      model: "anthropic/claude-haiku-4-5",
    });
    expect(getLastDispatchedParams()).not.toHaveProperty("provider");
  });

  test("rejects trusted fallback overrides when the configured allowlist normalizes to empty", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins, {
      plugins: {
        entries: {
          "voice-call": {
            subagent: {
              allowModelOverride: true,
              allowedModels: ["anthropic"],
            },
          },
        },
      },
    });
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-invalid-allowlist"));
    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-invalid-allowlist",
          message: "use trusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      ),
    ).rejects.toThrow(
      'plugin "voice-call" configured subagent.allowedModels, but none of the entries normalized to a valid provider/model target.',
    );
  });

  test("uses least-privilege synthetic fallback scopes without admin", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-least-privilege"));

    await runtime.run({
      sessionKey: "s-synthetic",
      message: "run synthetic",
      deliver: false,
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows fallback session reads with synthetic write scope", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-session-read"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = methodScopesModule.authorizeOperatorScopesForMethod("sessions.get", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, { messages: [{ id: "m-1" }] });
    });

    await expect(
      runtime.getSessionMessages({
        sessionKey: "s-read",
      }),
    ).resolves.toEqual({
      messages: [{ id: "m-1" }],
    });

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("rejects fallback session deletion without minting admin scope", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("synthetic-delete-session"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      // Re-run the gateway scope check here so the test proves fallback dispatch
      // does not smuggle admin into the request client.
      const scopes = Array.isArray(opts.client?.connect?.scopes) ? opts.client.connect.scopes : [];
      const auth = methodScopesModule.authorizeOperatorScopesForMethod("sessions.delete", scopes);
      if (!auth.allowed) {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: `missing scope: ${auth.missingScope}`,
        });
        return;
      }
      opts.respond(true, {});
    });

    await expect(
      runtime.deleteSession({
        sessionKey: "s-delete",
        deleteTranscript: true,
      }),
    ).rejects.toThrow("missing scope: operator.admin");

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
  });

  test("allows session deletion when the request scope already has admin", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const scope = {
      context: createTestContext("request-scope-delete-session"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await expect(
      gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
        runtime.deleteSession({
          sessionKey: "s-delete-admin",
          deleteTranscript: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
  });

  test("can prefer setup-runtime channel plugins during startup loads", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest({
      preferSetupRuntimeForChannelPlugins: true,
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        preferSetupRuntimeForChannelPlugins: true,
      }),
    );
  });

  test("primes configured bindings during gateway startup", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const cfg = {};
    const autoEnabledConfig = { channels: { slack: { enabled: true } }, autoEnabled: true };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    loadGatewayStartupPluginsForTest({ cfg });

    expect(primeConfiguredBindingRegistry).toHaveBeenCalledWith({ cfg: autoEnabledConfig });
  });

  test("uses the auto-enabled config snapshot for gateway bootstrap policies", async () => {
    const serverPlugins = serverPluginsModule;
    const autoEnabledConfig = {
      plugins: {
        entries: {
          demo: {
            subagent: { allowModelOverride: true, allowedModels: ["openai/gpt-5.4"] },
          },
        },
      },
    };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });
    const runtime = await createSubagentRuntime(serverPlugins, {});
    serverPlugins.setFallbackGatewayContext(createTestContext("auto-enabled-bootstrap-policy"));

    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("demo", () =>
      runtime.run({
        sessionKey: "s-auto-enabled-bootstrap-policy",
        message: "use trusted override",
        model: "openai/gpt-5.4",
        deliver: false,
      }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      sessionKey: "s-auto-enabled-bootstrap-policy",
      model: "openai/gpt-5.4",
    });
  });

  test("can suppress duplicate diagnostics when reloading full runtime plugins", async () => {
    const { reloadDeferredGatewayPlugins } = serverPluginBootstrapModule;
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "error",
        pluginId: "telegram",
        source: "/tmp/telegram/index.ts",
        message: "failed to load plugin: boom",
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = createTestLog();

    reloadDeferredGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log,
      coreGatewayHandlers: {},
      baseMethods: [],
      logDiagnostics: false,
    });

    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  test("reuses the initial startup plugin scope during deferred reloads", async () => {
    const { reloadDeferredGatewayPlugins } = serverPluginBootstrapModule;
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    reloadDeferredGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
      pluginIds: ["discord"],
      logDiagnostics: false,
    });

    expect(resolveGatewayStartupPluginIds).not.toHaveBeenCalled();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["discord"],
      }),
    );
  });

  test("runs registry hook before priming configured bindings", async () => {
    const { prepareGatewayPluginLoad } = serverPluginBootstrapModule;
    const order: string[] = [];
    const pluginRegistry = createRegistry([]);
    loadOpenClawPlugins.mockReturnValue(pluginRegistry);
    primeConfiguredBindingRegistry.mockImplementation(() => {
      order.push("prime");
      return { bindingCount: 0, channelCount: 0 };
    });

    prepareGatewayPluginLoad({
      cfg: {},
      workspaceDir: "/tmp",
      log: {
        ...createTestLog(),
      },
      coreGatewayHandlers: {},
      baseMethods: [],
      beforePrimeRegistry: (loadedRegistry) => {
        expect(loadedRegistry).toBe(pluginRegistry);
        order.push("hook");
      },
    });

    expect(order).toEqual(["hook", "prime"]);
  });

  test("shares fallback context across module reloads for existing runtimes", async () => {
    const first = serverPluginsModule;
    const runtime = await createSubagentRuntime(first);

    const staleContext = createTestContext("stale");
    first.setFallbackGatewayContext(staleContext);
    await runtime.run({ sessionKey: "s-1", message: "hello" });
    expect(getLastDispatchedContext()).toBe(staleContext);

    const reloaded = await reloadServerPluginsModule();
    const freshContext = createTestContext("fresh");
    reloaded.setFallbackGatewayContext(freshContext);

    await runtime.run({ sessionKey: "s-1", message: "hello again" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });

  test("uses updated fallback context after context replacement", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const firstContext = createTestContext("before-restart");
    const secondContext = createTestContext("after-restart");

    serverPlugins.setFallbackGatewayContext(firstContext);
    await runtime.run({ sessionKey: "s-2", message: "before restart" });
    expect(getLastDispatchedContext()).toBe(firstContext);

    serverPlugins.setFallbackGatewayContext(secondContext);
    await runtime.run({ sessionKey: "s-2", message: "after restart" });
    expect(getLastDispatchedContext()).toBe(secondContext);
  });

  test("reflects fallback context object mutation at dispatch time", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const context = { marker: "before-mutation" } as GatewayRequestContext & {
      marker: string;
    };

    serverPlugins.setFallbackGatewayContext(context);
    context.marker = "after-mutation";

    await runtime.run({ sessionKey: "s-3", message: "mutated context" });
    const dispatched = getLastDispatchedContext() as
      | (GatewayRequestContext & { marker: string })
      | undefined;
    expect(dispatched?.marker).toBe("after-mutation");
  });

  test("resolves fallback context lazily when a resolver is registered", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    let currentContext = createTestContext("before-resolver-update");

    serverPlugins.setFallbackGatewayContextResolver(() => currentContext);
    await runtime.run({ sessionKey: "s-4", message: "before resolver update" });
    expect(getLastDispatchedContext()).toBe(currentContext);

    currentContext = createTestContext("after-resolver-update");
    await runtime.run({ sessionKey: "s-4", message: "after resolver update" });
    expect(getLastDispatchedContext()).toBe(currentContext);
  });

  test("prefers resolver output over an older fallback context snapshot", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    const staleContext = createTestContext("stale-snapshot");
    const freshContext = createTestContext("fresh-resolver");

    serverPlugins.setFallbackGatewayContext(staleContext);
    serverPlugins.setFallbackGatewayContextResolver(() => freshContext);

    await runtime.run({ sessionKey: "s-5", message: "prefer resolver" });
    expect(getLastDispatchedContext()).toBe(freshContext);
  });
});
