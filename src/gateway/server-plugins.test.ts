// Gateway plugin tests cover plugin loading, auto-enable, runtime registry setup,
// request-scope injection, diagnostics, and handler dispatch integration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createTerminalTool } from "../agents/tools/terminal-tool.js";
import {
  getGlobalPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import type { PluginDiagnostic } from "../plugins/manifest-types.js";
import type { PluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.test-fixtures.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { withEnv } from "../test-utils/env.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const loadPluginLookUpTable = vi.hoisted(() =>
  vi.fn(() => ({
    startup: {
      pluginIds: ["discord", "telegram"],
    },
  })),
);
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }) => ({ config, changes: [], autoEnabledReasons: {} })),
);
const primeConfiguredBindingRegistry = vi.hoisted(() =>
  vi.fn(() => ({ bindingCount: 0, channelCount: 0 })),
);
const normalizeProviderModelIdWithRuntime = vi.hoisted(() => vi.fn(() => undefined));
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
const dispatchReplyFromConfig = vi.hoisted(() =>
  vi.fn(async () => ({ counts: {}, queuedFinal: false })),
);

vi.mock("../plugins/loader.js", () => ({
  loadAndActivateRootPluginRegistry: loadOpenClawPlugins,
  loadOpenClawPlugins,
}));

vi.mock("../plugins/runtime/load-context.js", async (importOriginal) => {
  const { buildPluginRuntimeLoadOptions, setPluginRuntimeLoadContext } =
    await importOriginal<typeof import("../plugins/runtime/load-context.js")>();
  return {
    buildPluginRuntimeLoadOptions,
    setPluginRuntimeLoadContext,
    createPluginRuntimeLoaderLogger: () => pluginRuntimeLoaderLogger,
  };
});

vi.mock("../plugins/plugin-lookup-table.js", () => ({
  loadPluginLookUpTable,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime,
}));

vi.mock("../channels/plugins/configured-binding-registry.js", async () => {
  const actual = await vi.importActual<
    typeof import("../channels/plugins/configured-binding-registry.js")
  >("../channels/plugins/configured-binding-registry.js");
  return {
    ...actual,
    primeConfiguredBindingRegistry,
  };
});

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

vi.mock("../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig,
  dispatchLowLevelChannelReplyFromConfig: dispatchReplyFromConfig,
}));

vi.mock("./agent-turn/internal-facade.js", () => ({
  createInternalAgentTurnFacade: (options: {
    client: GatewayRequestOptions["client"];
    getContext: () => GatewayRequestContext;
    isWebchatConnect?: GatewayRequestOptions["isWebchatConnect"];
  }) => ({
    dispatch: async (
      request: Record<string, unknown>,
      dispatchOptions?: {
        expectFinal?: boolean;
        onAccepted?: (payload: unknown) => void;
        onSignalAbort?: () => Promise<void> | void;
        signal?: AbortSignal;
        timeoutMs?: number;
      },
    ) => {
      const { dispatchGatewayRequestInProcess } = await import("./server-in-process-dispatch.js");
      return await dispatchGatewayRequestInProcess("agent", request, {
        client: options.client,
        context: options.getContext(),
        isWebchatConnect: options.isWebchatConnect,
        ...dispatchOptions,
      });
    },
    wait: async (params: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => {
      const { dispatchGatewayRequestInProcess } = await import("./server-in-process-dispatch.js");
      return await dispatchGatewayRequestInProcess("agent.wait", params, {
        client: options.client,
        context: options.getContext(),
        isWebchatConnect: options.isWebchatConnect,
        signal,
        timeoutMs,
      });
    },
  }),
}));

vi.mock("../channels/registry.js", () => ({
  CHAT_CHANNEL_ORDER: [],
  CHANNEL_IDS: [],
  listChatChannels: () => [],
  getChatChannelMeta: () => null,
  normalizeChatChannelId: () => null,
  normalizeChannelId: () => null,
  normalizeAnyChannelId: () => null,
  formatChannelPrimerLine: () => "",
  formatChannelSelectionLine: () => "",
}));

const createRegistry = (diagnostics: PluginDiagnostic[]): PluginRegistry => ({
  ...createEmptyPluginRegistry(),
  diagnostics,
});

function addLoadedPlugin(
  registry: PluginRegistry,
  params: {
    id: string;
    origin?: PluginRegistry["plugins"][number]["origin"];
    trustedOfficialInstall?: boolean;
  },
): PluginRegistry {
  registry.plugins.push(
    createPluginRecord({
      id: params.id,
      name: params.id,
      source: `/tmp/${params.id}/index.js`,
      origin: params.origin ?? "bundled",
      enabled: true,
      configSchema: false,
      ...(params.trustedOfficialInstall !== undefined
        ? { trustedOfficialInstall: params.trustedOfficialInstall }
        : {}),
    }),
  );
  return registry;
}

function createDuplexPluginRegistry(command = "image.bridge"): PluginRegistry {
  const registry = addLoadedPlugin(createRegistry([]), { id: "duplex-plugin" });
  registry.nodeHostCommands.push({
    pluginId: "duplex-plugin",
    pluginName: "Duplex plugin",
    command: { command, duplex: true, handle: async () => "{}" },
    source: "test",
  });
  return registry;
}

function createLookUpTableForTest(params: {
  installRecords?: PluginLookUpTable["index"]["installRecords"];
  manifestRegistry?: PluginLookUpTable["manifestRegistry"];
  pluginIds?: readonly string[];
  workerProviderIds?: readonly string[];
}): PluginLookUpTable {
  const index: PluginLookUpTable["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: params.installRecords ?? {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: "test",
    index,
    registryIndex: index,
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry ?? { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
      modelIdNormalizationPolicies: new Map(),
    },
    startup: {
      channelPluginIds: [],
      pluginIds: params.pluginIds ?? [],
    },
    workerProviderIds: params.workerProviderIds ?? [],
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      startupPlanMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
      startupPluginCount: params.pluginIds?.length ?? 0,
    },
  };
}

type ServerPluginsModule = typeof import("./server-plugins.js") & {
  clearFallbackGatewayContext: () => void;
  setFallbackGatewayContext: (context: GatewayRequestContext) => () => void;
  setFallbackGatewayContextResolver: (
    resolve: () => GatewayRequestContext | undefined,
  ) => () => void;
};
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
let resolveTestGatewayContext: () => GatewayRequestContext | undefined = () => undefined;

function createTestLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createTestContext(label: string): GatewayRequestContext {
  const config = {};
  return bindTestAgentTurns({
    label,
    getRuntimeConfig: () => config,
  } as unknown as GatewayRequestContext);
}

function bindTestAgentTurns(context: GatewayRequestContext): GatewayRequestContext {
  context.trackExecution = trackAsyncWork;
  context.createAgentTurnFacade ??= (principal) =>
    createInternalAgentTurnFacade({ ...principal, getContext: () => context });
  return context;
}

const requireRecord = createRequireRecord("record", "expected-label-object-capitalized");

function getLastMockFirstArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  label: string,
): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`Expected ${label} mock to have at least one call`);
  }
  return call[0];
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function getLastPluginLoadOptions(): Record<string, unknown> {
  return requireRecord(
    getLastMockFirstArg(loadOpenClawPlugins, "plugin load"),
    "plugin load options",
  );
}

function getLastPluginLoadOption(key: string) {
  return getLastPluginLoadOptions()[key];
}

function getLastDispatchedParams(): Record<string, unknown> | undefined {
  const call = getLastMockFirstArg(handleGatewayRequest, "gateway request") as
    | HandleGatewayRequestOptions
    | undefined;
  return call?.req?.params as Record<string, unknown> | undefined;
}

function getRequiredLastDispatchedParams(): Record<string, unknown> {
  return requireRecord(getLastDispatchedParams(), "dispatched params");
}

function getLastDispatchedClientScopes(): string[] {
  const call = getLastMockFirstArg(handleGatewayRequest, "gateway request") as
    | HandleGatewayRequestOptions
    | undefined;
  const scopes = call?.client?.connect?.scopes;
  return Array.isArray(scopes) ? scopes : [];
}

function getLastDispatchedClientInternal(): Record<string, unknown> {
  const call = getLastMockFirstArg(handleGatewayRequest, "gateway request") as
    | HandleGatewayRequestOptions
    | undefined;
  return (call?.client?.internal ?? {}) as Record<string, unknown>;
}

function getLastPluginLoadLogger(): {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
} {
  const call = getLastMockFirstArg(loadOpenClawPlugins, "plugin load") as
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
  const actualServerPlugins = await import("./server-plugins.js");
  serverPluginsModule = {
    ...actualServerPlugins,
    clearFallbackGatewayContext: () => {
      resolveTestGatewayContext = () => undefined;
    },
    setFallbackGatewayContext: (context) => {
      bindTestAgentTurns(context);
      resolveTestGatewayContext = () => context;
      return () => {
        if (resolveTestGatewayContext() === context) {
          resolveTestGatewayContext = () => undefined;
        }
      };
    },
    setFallbackGatewayContextResolver: (resolve) => {
      const boundResolve = () => {
        const context = resolve();
        return context ? bindTestAgentTurns(context) : undefined;
      };
      resolveTestGatewayContext = boundResolve;
      return () => {
        if (resolveTestGatewayContext === boundResolve) {
          resolveTestGatewayContext = () => undefined;
        }
      };
    },
    dispatchGatewayMethodInProcess: (method, params, options) =>
      actualServerPlugins.dispatchGatewayMethodInProcess(method, params, {
        ...options,
        resolveGatewayContext: resolveTestGatewayContext,
      }),
    dispatchGatewayMethodInProcessRaw: (method, params, options) =>
      actualServerPlugins.dispatchGatewayMethodInProcessRaw(method, params, {
        ...options,
        resolveGatewayContext: resolveTestGatewayContext,
      }),
    getInProcessGatewayRequestContext: () =>
      actualServerPlugins.getInProcessGatewayRequestContext(resolveTestGatewayContext),
    hasInProcessGatewayContext: () =>
      actualServerPlugins.hasInProcessGatewayContext(resolveTestGatewayContext),
  } as ServerPluginsModule;
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
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  loadGatewayStartupPluginsForTest({
    cfg,
  });
  return createRuntimeFromLastGatewayLoad().subagent;
}

async function createRequestScopedSubagentRuntime(): Promise<PluginRuntime["subagent"]> {
  loadOpenClawPlugins.mockReturnValue(createRegistry([]));
  loadGatewayStartupPluginsForTest({ resolveGatewayContext: undefined });
  return createRuntimeFromLastGatewayLoad().subagent;
}

function createRuntimeFromLastGatewayLoad(): PluginRuntime {
  const runtimeOptions = getLastPluginLoadOption("runtimeOptions") as
    | Parameters<PluginRuntimeModule["createPluginRuntime"]>[0]
    | undefined;
  if (!runtimeOptions?.nodes || !runtimeOptions.subagent) {
    throw new Error("Expected gateway plugin load to receive concrete node and subagent runtimes");
  }
  return runtimeModule.createPluginRuntime(runtimeOptions);
}

function registerActivePluginToolOwnership(
  pluginId: string,
  names: string[],
  declaredNames: string[] = names,
): void {
  const registry = runtimeRegistryModule.getActivePluginRegistry();
  if (!registry) {
    throw new Error("Expected an active plugin registry");
  }
  registry.tools.push({
    pluginId,
    factory: () => null,
    names,
    declaredNames,
    optional: true,
    source: `/tmp/${pluginId}/index.js`,
  });
}

function loadGatewayPluginsForTest(
  overrides: Partial<Parameters<ServerPluginsModule["loadGatewayPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  const loaded = serverPluginsModule.loadGatewayPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    resolveGatewayContext: () => resolveTestGatewayContext(),
    ...overrides,
  });
  // The mocked root loader returns a value without performing its production
  // installation side effect, so mirror that ownership boundary in the harness.
  runtimeRegistryModule.setActivePluginRegistry(loaded.pluginRegistry);
  return log;
}

function loadGatewayStartupPluginsForTest(
  overrides: Partial<Parameters<ServerPluginBootstrapModule["loadGatewayStartupPlugins"]>[0]> = {},
) {
  const log = createTestLog();
  const loaded = serverPluginBootstrapModule.loadGatewayStartupPlugins({
    cfg: {},
    workspaceDir: "/tmp",
    log,
    coreGatewayHandlers: {},
    baseMethods: [],
    resolveGatewayContext: () => resolveTestGatewayContext(),
    ...overrides,
  });
  runtimeRegistryModule.setActivePluginRegistry(loaded.pluginRegistry);
  return log;
}

beforeAll(async () => {
  await loadTestModules();
});

beforeEach(() => {
  loadOpenClawPlugins.mockReset();
  loadPluginLookUpTable.mockReset().mockReturnValue({
    startup: {
      pluginIds: ["discord", "telegram"],
    },
  });
  applyPluginAutoEnable
    .mockReset()
    .mockImplementation(({ config }) => ({ config, changes: [], autoEnabledReasons: {} }));
  primeConfiguredBindingRegistry.mockClear().mockReturnValue({ bindingCount: 0, channelCount: 0 });
  normalizeProviderModelIdWithRuntime.mockReset().mockReturnValue(undefined);
  dispatchReplyFromConfig.mockClear();
  pluginRuntimeLoaderLogger.info.mockClear();
  pluginRuntimeLoaderLogger.warn.mockClear();
  pluginRuntimeLoaderLogger.error.mockClear();
  pluginRuntimeLoaderLogger.debug.mockClear();
  handleGatewayRequest.mockReset();
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
  setActiveDegradedPlugins([]);
  serverPluginsModule.clearFallbackGatewayContext();
  runtimeRegistryModule.resetPluginRuntimeStateForTest();
  resetGlobalHookRunner();
});

describe("loadGatewayPlugins", () => {
  test("logs plugin errors with details", () => {
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

  test("logs warn-level plugin diagnostics through the warn sink, not info", () => {
    const diagnostics: PluginDiagnostic[] = [
      {
        level: "warn",
        pluginId: "beads",
        source: "/tmp/beads/index.ts",
        message: 'typed hook "before_prompt_build" blocked by policy',
      },
    ];
    loadOpenClawPlugins.mockReturnValue(createRegistry(diagnostics));
    const log = loadGatewayStartupPluginsForTest();

    expect(log.warn).toHaveBeenCalledWith(
      '[plugins] typed hook "before_prompt_build" blocked by policy (plugin=beads, source=/tmp/beads/index.ts)',
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("[plugins] typed hook"));
    expect(log.error).not.toHaveBeenCalled();
  });

  test("does not re-log a quarantined plugin verification diagnostic", () => {
    const diagnostic: PluginDiagnostic = {
      level: "error",
      code: "plugin-verification",
      pluginId: "broken-payload",
      source: "/tmp/broken-payload/index.ts",
      message: "configured plugin payload verification failed (missing-main-entry): missing",
    };
    const distinctDiagnostic: PluginDiagnostic = {
      ...diagnostic,
      message: "configured plugin payload verification failed (missing-package-json): missing",
    };
    const registry = createRegistry([diagnostic, distinctDiagnostic]);
    loadOpenClawPlugins.mockReturnValue(registry);
    setActiveDegradedPlugins([
      {
        pluginId: "broken-payload",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "missing",
        },
      },
    ]);

    const log = loadGatewayStartupPluginsForTest();

    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      "[plugins] configured plugin payload verification failed (missing-package-json): missing (plugin=broken-payload, source=/tmp/broken-payload/index.ts)",
    );
    expect(registry.diagnostics).toEqual([diagnostic, distinctDiagnostic]);
  });

  test("loads only gateway startup plugin ids", () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest();

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    expect(loadPluginLookUpTable).toHaveBeenCalledWith({
      config: {},
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(getLastPluginLoadOption("onlyPluginIds")).toEqual(["discord", "telegram"]);
    expect(getLastPluginLoadOption("preferBuiltPluginArtifacts")).toBe(true);
  });

  test("binds channel reply dispatch to the owning Gateway context", async () => {
    const terminalSessions = { listAgent: vi.fn(() => []) };
    const context = {
      label: "channel-reply-owner",
      workerSessionPlacementService: { getMany: vi.fn(() => new Map()) },
      terminalSessions,
    } as unknown as GatewayRequestContext;
    serverPluginsModule.setFallbackGatewayContext(context);
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    dispatchReplyFromConfig.mockImplementationOnce(async () => {
      const result = await createTerminalTool({
        agentId: "main",
        agentSessionKey: "agent:main:telegram:direct:123",
        sessionId: "session-123",
      }).execute("terminal-list", { action: "list" });
      expect(result.details).toEqual({ sessions: [] });
      expect(terminalSessions.listAgent).toHaveBeenCalledWith({
        kind: "agent",
        agentId: "main",
        agentSessionKey: "agent:main:telegram:direct:123",
        agentSessionId: "session-123",
      });
      return { counts: {}, queuedFinal: false };
    });

    loadGatewayPluginsForTest();
    const runtimeOptions = getLastPluginLoadOption("runtimeOptions") as
      | Parameters<PluginRuntimeModule["createPluginRuntime"]>[0]
      | undefined;
    const boundDispatch = runtimeOptions?.dispatchReplyFromConfig;
    if (!boundDispatch) {
      throw new Error("Expected gateway plugin load to bind channel reply dispatch");
    }
    const params = {} as Parameters<typeof boundDispatch>[0];

    await boundDispatch(params);

    expect(dispatchReplyFromConfig).toHaveBeenCalledWith({
      ...params,
      sessionWorkerPlacementContext: context,
    });
  });

  test("captures retired plugin reply owners through their canonical Gateway binding", async () => {
    const { admitReplyTurn } = await import("../auto-reply/reply/reply-turn-admission.js");
    const { captureGatewayReplyRunRestartAbort } =
      await import("../auto-reply/reply/reply-run-registry.js");
    const { captureGatewaySessionWorkAdmissions } =
      await import("../sessions/session-lifecycle-admission.js");
    const { replaceSessionEntry } = await import("../config/sessions/session-accessor.js");
    const { closeOpenClawAgentDatabasesForTest } = await import("../state/openclaw-agent-db.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-restart-owner-"));
    const storePath = path.join(stateDir, "sessions.json");
    const context = createTestContext("same-context-distinct-owners");
    const closingResolver = vi.fn(() => context);
    const otherResolver = vi.fn(() => context);
    const operations: import("../auto-reply/reply/reply-run-registry.js").ReplyOperation[] = [];
    const runtimes: ReturnType<ServerPluginsModule["loadGatewayPlugins"]>[] = [];
    try {
      for (const [name, resolver] of [
        ["closing", closingResolver],
        ["other", otherResolver],
      ] as const) {
        const sessionKey = `agent:main:plugin-${name}`;
        await replaceSessionEntry(
          { storePath, sessionKey },
          { sessionId: name, updatedAt: Date.now() },
        );
        loadOpenClawPlugins.mockReturnValue(createRegistry([]));
        runtimes.push(
          serverPluginsModule.loadGatewayPlugins({
            cfg: {},
            workspaceDir: stateDir,
            log: createTestLog(),
            baseMethods: [],
            pluginIds: ["test-channel"],
            resolveGatewayContext: resolver,
          }),
        );
        const runtimeOptions = getLastPluginLoadOption("runtimeOptions") as Parameters<
          PluginRuntimeModule["createPluginRuntime"]
        >[0];
        const dispatch = runtimeOptions?.dispatchReplyFromConfig;
        if (!dispatch) {
          throw new Error("Expected bound channel dispatch");
        }
        dispatchReplyFromConfig.mockImplementationOnce(async () => {
          const admission = await admitReplyTurn({
            sessionKey,
            sessionId: name,
            storePath,
            kind: "visible",
            resetTriggered: false,
          });
          if (admission.status !== "owned") {
            throw new Error("Expected an owned reply");
          }
          operations.push(admission.operation);
          return { counts: {}, queuedFinal: false };
        });
        await dispatch({} as Parameters<typeof dispatch>[0]);
      }
      const capturedResolver = gatewayRequestScopeModule.getGatewayContextResolver(operations[0]!);
      expect(capturedResolver?.()).toBe(context);
      runtimes[0]!.retireGatewayRuntimeBindings();
      expect(capturedResolver?.()).toBeUndefined();
      closingResolver.mockImplementation(() => {
        throw new Error("Retired resolver must not be invoked");
      });
      otherResolver.mockClear();
      const admissions = captureGatewaySessionWorkAdmissions(closingResolver);
      const aborted = captureGatewayReplyRunRestartAbort(closingResolver)(() => {});
      expect({
        closing: admissions.isActive({
          scope: storePath,
          sessionKey: "agent:main:plugin-closing",
          sessionId: "closing",
        }),
        other: admissions.isActive({
          scope: storePath,
          sessionKey: "agent:main:plugin-other",
          sessionId: "other",
        }),
        aborted,
        signals: operations.map((operation) => operation.abortSignal.aborted),
      }).toEqual({ closing: true, other: false, aborted: 1, signals: [true, false] });
      expect(otherResolver).not.toHaveBeenCalled();
    } finally {
      operations.forEach((operation) => operation.complete());
      runtimes.forEach((runtime) => runtime.retireGatewayRuntimeBindings());
      await Promise.resolve();
      closeOpenClawAgentDatabasesForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  test("injects the process HOME-isolation fact into registry construction", () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const home = os.userInfo().homedir;
    const defaultStateDir = path.join(home, ".openclaw");
    withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_STATE_DIR: defaultStateDir,
        OPENCLAW_CONFIG_PATH: path.join(defaultStateDir, "openclaw.json"),
      },
      () => loadGatewayPluginsForTest(),
    );
    expect(getLastPluginLoadOption("allowProcessHomeSessionCatalogs")).toBe(true);

    withEnv(
      {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: undefined,
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw-dev"),
        OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-dev", "openclaw.json"),
      },
      () => loadGatewayPluginsForTest(),
    );

    expect(getLastPluginLoadOption("allowProcessHomeSessionCatalogs")).toBe(false);
  });

  test("routes plugin registration logs through the plugin logger", () => {
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

  test("can suppress provisional plugin info logs while preserving warnings", () => {
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

  test("reuses the provided startup plugin scope without recomputing it", () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayPluginsForTest({
      pluginIds: ["browser"],
    });

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(getLastPluginLoadOption("onlyPluginIds")).toEqual(["browser"]);
  });

  test("reuses a provided lookup table for startup scope and auto-enable manifests", () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    const manifestRegistry = { plugins: [], diagnostics: [] };
    const installRecords = {
      telegram: {
        source: "npm" as const,
        spec: "@openclaw/telegram@1.0.0",
        installPath: "/tmp/plugins/telegram",
      },
    };

    loadGatewayPluginsForTest({
      pluginLookUpTable: createLookUpTableForTest({
        installRecords,
        manifestRegistry,
        pluginIds: ["telegram"],
      }),
    });

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
      manifestRegistry,
    });
    expect(getLastPluginLoadOption("manifestRegistry")).toBe(manifestRegistry);
    expect(getLastPluginLoadOption("installRecords")).toEqual(installRecords);
    expect(getLastPluginLoadOption("onlyPluginIds")).toEqual(["telegram"]);
  });

  test("keeps the raw activation source when a precomputed startup scope is reused", () => {
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

    expect(loadPluginLookUpTable).not.toHaveBeenCalled();
    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: rawConfig,
      env: process.env,
    });
    expect(getLastPluginLoadOption("config")).toStrictEqual(resolvedConfig);
    expect(getLastPluginLoadOption("activationSourceConfig")).toStrictEqual(rawConfig);
    expect(getLastPluginLoadOption("onlyPluginIds")).toEqual(["slack"]);
    expect(getLastPluginLoadOption("autoEnabledReasons")).toEqual({
      slack: ["slack configured"],
    });
  });

  test("passes durable worker activation reasons to the runtime plugin load", () => {
    applyPluginAutoEnable.mockReturnValue({
      config: {},
      changes: [],
      autoEnabledReasons: { "qa-lab": ["static-ssh worker provider selected"] },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayStartupPluginsForTest({
      pluginIds: ["qa-lab"],
      pluginLookUpTable: createLookUpTableForTest({
        manifestRegistry: {
          plugins: [
            {
              id: "qa-lab",
              origin: "bundled",
              channels: [],
              providers: [],
              cliBackends: [],
              skills: [],
              hooks: [],
              rootDir: "/tmp/qa-lab",
              source: "/tmp/qa-lab/index.js",
              manifestPath: "/tmp/qa-lab/openclaw.plugin.json",
              contracts: { workerProviders: ["static-ssh"] },
            },
          ],
          diagnostics: [],
        },
        workerProviderIds: ["static-ssh"],
      }),
    });

    expect(getLastPluginLoadOption("autoEnabledReasons")).toEqual({
      "qa-lab": ["static-ssh durable worker lease"],
    });
  });

  test("preserves runtime defaults while applying source activation to startup loads", () => {
    const rawConfig = {
      channels: {
        telegram: {
          botToken: "token",
        },
      },
      plugins: {
        allow: ["bench-plugin"],
      },
    };
    const runtimeConfig = {
      channels: {
        telegram: {
          botToken: "token",
          dmPolicy: "pairing" as const,
          groupPolicy: "allowlist" as const,
        },
      },
      plugins: {
        allow: ["bench-plugin", "memory-core"],
        entries: {
          "bench-plugin": {
            config: {
              runtimeDefault: true,
            },
          },
          "memory-core": {
            config: {
              dreaming: {
                enabled: false,
              },
            },
          },
        },
      },
    };
    const activationConfig = {
      channels: {
        telegram: {
          botToken: "token",
          enabled: true,
        },
      },
      plugins: {
        allow: ["bench-plugin"],
        entries: {
          "bench-plugin": {
            enabled: true,
          },
        },
      },
    };
    applyPluginAutoEnable.mockReturnValue({
      config: activationConfig,
      changes: [],
      autoEnabledReasons: {
        telegram: ["telegram configured"],
      },
    });
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));

    loadGatewayStartupPluginsForTest({
      cfg: runtimeConfig,
      activationSourceConfig: rawConfig,
      pluginIds: ["telegram"],
    });

    const config = requireRecord(getLastPluginLoadOption("config"), "plugin load config");
    const channels = readRecordField(config, "channels", "plugin load channels");
    const telegram = readRecordField(channels, "telegram", "telegram channel config");
    expect(telegram.enabled).toBe(true);
    expect(telegram.dmPolicy).toBe("pairing");
    expect(telegram.groupPolicy).toBe("allowlist");
    const plugins = readRecordField(config, "plugins", "plugin load plugins config");
    expect(plugins.allow).toEqual(["bench-plugin"]);
    const entries = readRecordField(plugins, "entries", "plugin load entries");
    const benchPlugin = readRecordField(entries, "bench-plugin", "bench plugin entry");
    expect(benchPlugin.enabled).toBe(true);
    expect(benchPlugin.config).toEqual({
      runtimeDefault: true,
    });
    expect(entries["memory-core"]).toEqual({
      config: {
        dreaming: {
          enabled: false,
        },
      },
    });
    expect(getLastPluginLoadOption("activationSourceConfig")).toStrictEqual(rawConfig);
    expect(getLastPluginLoadOption("autoEnabledReasons")).toEqual({
      telegram: ["telegram configured"],
    });
  });

  test("treats an empty startup scope as no plugin load instead of an unscoped load", () => {
    loadPluginLookUpTable.mockReturnValue({
      startup: {
        pluginIds: [],
      },
    });

    const result = serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: ["sessions.get"],
    });

    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(result.pluginRegistry.plugins).toStrictEqual([]);
    expect(result.gatewayMethods).toEqual(["sessions.get"]);
  });

  test("activates the empty registry in the global hook runner", () => {
    const previous = addLoadedPlugin(createRegistry([]), { id: "previous-plugin" });
    runtimeRegistryModule.setActivePluginRegistry(previous);
    initializeGlobalHookRunner(previous);
    loadPluginLookUpTable.mockReturnValue({ startup: { pluginIds: [] } });

    const result = serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(getGlobalPluginRegistry()).toBe(result.pluginRegistry);
    expect(result.pluginRegistry.plugins).toStrictEqual([]);
  });

  test("stores workspaceDir on the active registry when startup scope is empty", () => {
    loadPluginLookUpTable.mockReturnValue({
      startup: {
        pluginIds: [],
      },
    });

    serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp/gateway-workspace",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/tmp/gateway-workspace");
  });

  test("loads gateway plugins from the auto-enabled config snapshot", () => {
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

    expect(loadPluginLookUpTable).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      activationSourceConfig: undefined,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(getLastPluginLoadOption("config")).toStrictEqual(autoEnabledConfig);
    expect(getLastPluginLoadOption("activationSourceConfig")).toEqual({});
    expect(getLastPluginLoadOption("autoEnabledReasons")).toEqual({
      slack: ["slack configured"],
    });
  });

  test("re-derives auto-enable reasons when only activationSourceConfig is provided", () => {
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
    expect(loadPluginLookUpTable).toHaveBeenCalledWith({
      config: resolvedConfig,
      activationSourceConfig: rawConfig,
      workspaceDir: "/tmp",
      env: process.env,
    });
    expect(getLastPluginLoadOption("config")).toStrictEqual(resolvedConfig);
    expect(getLastPluginLoadOption("activationSourceConfig")).toStrictEqual(rawConfig);
    expect(getLastPluginLoadOption("autoEnabledReasons")).toEqual({
      slack: ["slack configured"],
    });
  });

  test("provides subagent runtime session messages through sessions.get", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("sessions-get-aliases"));
    handleGatewayRequest
      .mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        expect(opts.req.method).toBe("sessions.get");
        expect(opts.req.params).toEqual({ key: "s-read" });
        opts.respond(true, { messages: [{ id: "m-1" }] });
      })
      .mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        expect(opts.req.method).toBe("sessions.get");
        expect(opts.req.params).toEqual({ key: "s-limited", limit: 1_000 });
        opts.respond(true, { messages: [{ id: "m-3" }] });
      });

    await expect(runtime.getSessionMessages({ sessionKey: "s-read" })).resolves.toEqual({
      messages: [{ id: "m-1" }],
    });
    await expect(
      runtime.getSessionMessages({
        sessionKey: "s-limited",
        limit: 9e15,
      }),
    ).resolves.toEqual({
      messages: [{ id: "m-3" }],
    });
  });

  test("times out while waiting for the first in-process gateway response", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("initial-response-timeout"));
    handleGatewayRequest.mockImplementationOnce(async () => {
      await new Promise(() => {});
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "sessions.delete",
        { key: "stuck-session" },
        { timeoutMs: 5 },
      ),
    ).rejects.toThrow("gateway request timeout for sessions.delete");
  });

  test("does not dispatch or clean up a pre-aborted in-process request", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("pre-aborted-request"));
    const controller = new AbortController();
    const onSignalAbort = vi.fn();
    controller.abort();

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "conversations.turn",
        { turnId: "turn-pre-aborted" },
        { signal: controller.signal, onSignalAbort },
      ),
    ).rejects.toThrow();
    expect(handleGatewayRequest).not.toHaveBeenCalled();
    expect(onSignalAbort).not.toHaveBeenCalled();
  });

  test("runs in-process abort cleanup once without replacing the abort error", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("aborted-request-cleanup"));
    const controller = new AbortController();
    const onSignalAbort = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    handleGatewayRequest.mockImplementationOnce(async () => {
      await new Promise(() => {});
    });

    const result = serverPluginsModule.dispatchGatewayMethodInProcess(
      "conversations.turn",
      { turnId: "turn-aborted" },
      { signal: controller.signal, onSignalAbort },
    );
    await vi.waitFor(() => expect(handleGatewayRequest).toHaveBeenCalledTimes(1));
    controller.abort(new Error("primary aborted"));

    await expect(result).rejects.toThrow("primary aborted");
    expect(onSignalAbort).toHaveBeenCalledTimes(1);
  });

  test("returns an accepted in-process response without waiting for handler completion", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("accepted-before-complete"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      opts.respond(true, { status: "accepted", runId: "run-accepted" });
      await new Promise(() => {});
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "agent",
        { sessionKey: "s-accepted" },
        { timeoutMs: 5 },
      ),
    ).resolves.toEqual({ status: "accepted", runId: "run-accepted" });
  });

  test("marks synthetic cron continuation calls as server-owned", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("cron-run-continuation"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.client?.connect.client.mode).toBe("backend");
      expect(opts.client?.internal?.cronRunContinuation).toBe(true);
      opts.respond(true, { status: "ok" });
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "agent",
        { sessionKey: "agent:main:cron:job:run:run-1" },
        { allowSyntheticCronRunContinuation: true, forceSyntheticClient: true },
      ),
    ).resolves.toEqual({ status: "ok" });
  });

  test("carries delegated tool-policy handoffs only in synthetic client context", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("delegated-tool-policy"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.req.params).not.toHaveProperty("delegatedToolPolicyHandoff");
      expect(opts.client?.internal?.delegatedToolPolicyHandoffId).toEqual(expect.any(String));
      opts.respond(true, { status: "ok" });
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "agent",
        { sessionKey: "agent:main:main" },
        {
          delegatedToolPolicyHandoff: {
            sourceSessionKey: "agent:main:subagent:child",
            targetSessionKey: "agent:main:main",
            targetSessionId: "requester-session",
            idempotencyKey: "announce-1",
          },
          forceSyntheticClient: true,
        },
      ),
    ).resolves.toEqual({ status: "ok" });
  });

  test("carries scoped delivery media only in the synthetic client context", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("scoped-delivery-media"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.req.params).not.toHaveProperty("internalDeliveryMediaUrls");
      expect(opts.req.params).not.toHaveProperty("internalDeliverySuppressText");
      expect(opts.client?.internal?.internalDeliveryMediaUrls).toEqual(["/tmp/proof.png"]);
      expect(opts.client?.internal?.internalDeliverySuppressText).toBe(true);
      opts.respond(true, { status: "ok" });
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "agent",
        { sessionKey: "agent:main:main" },
        {
          forceSyntheticClient: true,
          internalDeliveryMediaUrls: ["/tmp/proof.png"],
          internalDeliverySuppressText: true,
        },
      ),
    ).resolves.toEqual({ status: "ok" });
  });

  test("uses one timeout budget across accepted and final in-process responses", async () => {
    vi.useFakeTimers();
    try {
      serverPluginsModule.setFallbackGatewayContext(createTestContext("single-final-deadline"));
      handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        setTimeout(() => {
          opts.respond(true, { status: "accepted", runId: "run-deadline" });
        }, 7);
        setTimeout(() => {
          opts.respond(true, { status: "ok", runId: "run-deadline" });
        }, 13);
        await new Promise((resolve) => {
          setTimeout(resolve, 13);
        });
      });

      const result = expect(
        serverPluginsModule.dispatchGatewayMethodInProcess(
          "agent",
          { sessionKey: "s-deadline" },
          { expectFinal: true, timeoutMs: 10 },
        ),
      ).rejects.toThrow("gateway request timeout for agent");

      await vi.advanceTimersByTimeAsync(10);
      await result;
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports accepted in-process agent requests before their final response", async () => {
    serverPluginsModule.setFallbackGatewayContext(createTestContext("accepted-callback"));
    const onAccepted = vi.fn();
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      opts.respond(true, { status: "accepted", runId: "run-callback" });
      opts.respond(true, { status: "ok", runId: "run-callback" });
    });

    await expect(
      serverPluginsModule.dispatchGatewayMethodInProcess(
        "agent",
        { sessionKey: "s-callback" },
        { expectFinal: true, onAccepted },
      ),
    ).resolves.toEqual({ status: "ok", runId: "run-callback" });
    expect(onAccepted).toHaveBeenCalledWith({ status: "accepted", runId: "run-callback" });
  });

  test("clears final-response timeout when handler rejects after accepted response", async () => {
    vi.useFakeTimers();
    try {
      serverPluginsModule.setFallbackGatewayContext(createTestContext("accepted-then-error"));
      handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        opts.respond(true, { status: "accepted", runId: "run-error-after-accepted" });
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
        throw new Error("handler failed after accepted");
      });

      const result = expect(
        serverPluginsModule.dispatchGatewayMethodInProcess(
          "agent",
          { sessionKey: "s-error-after-accepted" },
          { expectFinal: true, timeoutMs: 1_000 },
        ),
      ).rejects.toThrow("handler failed after accepted");

      await vi.advanceTimersByTimeAsync(5);
      await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("filters connected plugin nodes locally without sending unsupported node.list params", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("nodes-list-filter"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.req.method).toBe("node.list");
      opts.respond(true, {
        nodes: [
          { nodeId: "connected", connected: true, gatewayLocal: true },
          { nodeId: "offline", connected: false },
        ],
      });
    });

    const runtime = createRuntimeFromLastGatewayLoad();
    const result = await runtime.nodes.list({ connected: true });

    expect(getLastDispatchedParams()).toStrictEqual({});
    expect(result.nodes).toEqual([{ nodeId: "connected", connected: true, gatewayLocal: true }]);
  });

  test("projects effective node-command policy into the plugin node runtime", async () => {
    const command = "agent.cli.claude.run.v1";
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext({
      getRuntimeConfig: () => ({ gateway: { nodes: { commands: { deny: [command] } } } }),
      nodeRegistry: {
        get: () => ({
          nodeId: "node-policy",
          connId: "conn-policy",
          platform: "linux",
          commands: [command],
        }),
      },
    } as unknown as GatewayRequestContext);
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      opts.respond(true, {
        nodes: [{ nodeId: "node-policy", connected: true, commands: [command] }],
      });
    });

    const runtime = createRuntimeFromLastGatewayLoad();
    const result = await runtime.nodes.list({ connected: true });

    expect(result.nodes[0]?.commands).toEqual([command]);
    expect(result.nodes[0]?.invocableCommands).toEqual([]);
  });

  test("lets trusted official plugin runtime request admin scope for browser proxy", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "google-meet" }));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("nodes-invoke-browser-proxy"));

    const runtime = createRuntimeFromLastGatewayLoad();
    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "google-meet", pluginOrigin: "bundled" },
      () =>
        runtime.nodes.invoke({
          nodeId: "node-1",
          command: "browser.proxy",
          params: { method: "GET", path: "/profiles" },
          sessionKey: "agent:main:trusted",
          scopes: ["operator.admin"],
        }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      nodeId: "node-1",
      command: "browser.proxy",
      params: { method: "GET", path: "/profiles" },
    });
    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("google-meet");
    expect(getLastDispatchedClientInternal().nodeInvokeApprovalSessionKey).toBe(
      "agent:main:trusted",
    );
  });

  test("honors trusted plugin node scopes inside a narrower Gateway request", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "opencode" }));
    loadGatewayStartupPluginsForTest({ resolveGatewayContext: undefined });
    const scope = {
      context: createTestContext("nodes-invoke-read-caller"),
      client: {
        connect: { scopes: ["operator.read"] },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;
    const runtime = createRuntimeFromLastGatewayLoad();

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "opencode", pluginOrigin: "bundled" },
        () =>
          runtime.nodes.invoke({
            nodeId: "node-1",
            command: "opencode.sessions.list.v1",
            scopes: ["operator.write"],
          }),
      ),
    );

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("opencode");
  });

  test("dispatches gateway methods with the trusted plugin identity", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "google-meet" }));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("plugin-gateway-request"));
    const runtime = createRuntimeFromLastGatewayLoad();

    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "google-meet", pluginOrigin: "bundled" },
      () => runtime.gateway.request("voicecall.start", { to: "+15550001234" }),
    );

    expect(getLastDispatchedParams()).toEqual({ to: "+15550001234" });
    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("google-meet");
  });

  test("lets trusted official plugins request explicit Gateway scopes", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "google-meet" }));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("plugin-gateway-admin"));
    const runtime = createRuntimeFromLastGatewayLoad();

    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "google-meet", pluginOrigin: "bundled" },
      () =>
        runtime.gateway.request(
          "browser.request",
          { method: "GET", path: "/tabs" },
          { scopes: ["operator.admin"] },
        ),
    );

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("google-meet");
  });

  test("reports whether trusted in-process Gateway dispatch is available", async () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayStartupPluginsForTest();
    const runtime = createRuntimeFromLastGatewayLoad();

    expect(await runtime.gateway.isAvailable()).toBe(false);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("plugin-gateway-available"));
    expect(await runtime.gateway.isAvailable()).toBe(true);
  });

  test("does not inherit admin scope for trusted plugin gateway requests", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "google-meet" }));
    loadGatewayStartupPluginsForTest({ resolveGatewayContext: undefined });
    const scope = {
      context: createTestContext("plugin-gateway-request-admin-caller"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;
    const runtime = createRuntimeFromLastGatewayLoad();

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "google-meet", pluginOrigin: "bundled" },
        () => runtime.gateway.request("voicecall.start", { to: "+15550001234" }),
      ),
    );

    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("google-meet");
  });

  test("preserves structured errors from trusted plugin gateway requests", async () => {
    loadOpenClawPlugins.mockReturnValue(addLoadedPlugin(createRegistry([]), { id: "google-meet" }));
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("plugin-gateway-error"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      opts.respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "browser login required",
        details: { manualActionRequired: true, reason: "not-authenticated" },
      });
    });
    const runtime = createRuntimeFromLastGatewayLoad();

    const request = gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "google-meet", pluginOrigin: "bundled" },
      () => runtime.gateway.request("googlemeet.join", { url: "https://meet.google.com/abc" }),
    );

    await expect(request).rejects.toMatchObject({
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      details: { manualActionRequired: true, reason: "not-authenticated" },
    });
  });

  test("rejects gateway dispatch from arbitrary plugins", async () => {
    loadOpenClawPlugins.mockReturnValue(
      addLoadedPlugin(createRegistry([]), { id: "third-party", origin: "global" }),
    );
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(createTestContext("plugin-gateway-rejected"));
    const runtime = createRuntimeFromLastGatewayLoad();

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "third-party", pluginOrigin: "global" },
        () =>
          runtime.gateway.request(
            "voicecall.start",
            { to: "+15550001234" },
            { scopes: ["operator.admin"] },
          ),
      ),
    ).rejects.toThrow("bundled or trusted official plugins");
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  test("does not let arbitrary plugin nodes runtime mint admin scope for browser proxy", async () => {
    loadOpenClawPlugins.mockReturnValue(
      addLoadedPlugin(createRegistry([]), { id: "third-party", origin: "global" }),
    );
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext(
      createTestContext("nodes-invoke-browser-proxy-no-elevate"),
    );

    const runtime = createRuntimeFromLastGatewayLoad();
    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "third-party", pluginOrigin: "global" },
      () =>
        runtime.nodes.invoke({
          nodeId: "node-1",
          command: "browser.proxy",
          params: { method: "GET", path: "/profiles" },
          sessionKey: "agent:main:untrusted",
          scopes: ["operator.admin"],
        }),
    );

    expect(getLastDispatchedParams()).toMatchObject({
      nodeId: "node-1",
      command: "browser.proxy",
      params: { method: "GET", path: "/profiles" },
    });
    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);
    expect(getLastDispatchedClientScopes()).not.toContain("operator.admin");
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("third-party");
    expect(getLastDispatchedClientInternal()).not.toHaveProperty("nodeInvokeApprovalSessionKey");
  });

  test("rejects an owned non-duplex node command before invoking its handler", async () => {
    const handle = vi.fn(async () => '{"ok":true}');
    const registry = addLoadedPlugin(createRegistry([]), { id: "duplex-plugin" });
    registry.nodeHostCommands.push({
      pluginId: "duplex-plugin",
      pluginName: "Duplex plugin",
      command: { command: "image.bridge", handle },
      source: "test",
    });
    loadOpenClawPlugins.mockReturnValue(registry);
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext({
      nodeRegistry: { sendInvokeInput: vi.fn() },
    } as unknown as GatewayRequestContext);
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      await handle();
      opts.respond(true, { ok: true });
    });
    const runtime = createRuntimeFromLastGatewayLoad();

    const error = await gatewayRequestScopeModule.withPluginRuntimeRegistryScope(registry, () =>
      gatewayRequestScopeModule
        .withPluginRuntimePluginScope({ pluginId: "duplex-plugin", pluginOrigin: "bundled" }, () =>
          runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
        )
        .catch((reason: unknown) => reason),
    );

    expect(handle).not.toHaveBeenCalled();
    expect(handleGatewayRequest).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/declare.*duplex: true/i);
  });

  test.each([
    { label: "unknown command", owners: [] },
    { label: "another plugin's duplex command", owners: ["another-plugin"] },
    { label: "ambiguous plugin ownership", owners: ["duplex-plugin", "another-plugin"] },
    { label: "duplicate caller-owned declarations", owners: ["duplex-plugin", "duplex-plugin"] },
    { label: "missing scoped registry", owners: ["duplex-plugin"], scopedRegistry: false },
  ])("rejects a $label before node dispatch", async ({ owners, scopedRegistry }) => {
    const registry = addLoadedPlugin(createRegistry([]), { id: "duplex-plugin" });
    registry.nodeHostCommands.push(
      ...owners.map((pluginId) => ({
        pluginId,
        pluginName: pluginId,
        command: { command: "image.bridge", duplex: true, handle: vi.fn(async () => "{}") },
        source: "test",
      })),
    );
    loadOpenClawPlugins.mockReturnValue(registry);
    loadGatewayStartupPluginsForTest();
    serverPluginsModule.setFallbackGatewayContext({
      nodeRegistry: { sendInvokeInput: vi.fn() },
    } as unknown as GatewayRequestContext);
    const runtime = createRuntimeFromLastGatewayLoad();
    const openDuplex = () =>
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
        () => runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
      );

    await expect(
      scopedRegistry === false
        ? openDuplex()
        : gatewayRequestScopeModule.withPluginRuntimeRegistryScope(registry, openDuplex),
    ).rejects.toThrow(/registered exactly once.*duplex: true/i);
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  test.each(["operator.read", "no scopes"])(
    "does not elevate a scoped %s caller when forcing a synthetic duplex client",
    async (scopeLabel) => {
      const scopes = scopeLabel === "no scopes" ? [] : ["operator.read"];
      const registry = createDuplexPluginRegistry();
      loadOpenClawPlugins.mockReturnValue(registry);
      loadGatewayStartupPluginsForTest();
      const context = {
        nodeRegistry: { sendInvokeInput: vi.fn() },
      } as unknown as GatewayRequestContext;
      serverPluginsModule.setFallbackGatewayContext(context);
      handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        opts.respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "missing operator.write scope",
        });
      });
      const requestScope = {
        context,
        client: { connect: { scopes } } as GatewayRequestOptions["client"],
        isWebchatConnect: () => false,
        pluginRegistry: registry,
      } satisfies PluginRuntimeGatewayRequestScope;
      const runtime = createRuntimeFromLastGatewayLoad();

      await expect(
        gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(requestScope, () =>
          gatewayRequestScopeModule.withPluginRuntimePluginScope(
            { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
            () => runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
          ),
        ),
      ).rejects.toThrow("missing operator.write scope");
      expect(getLastDispatchedClientScopes()).toEqual(scopes);
      expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("duplex-plugin");
      expect(getLastDispatchedParams()).not.toHaveProperty("nodeInvokeStream");
    },
  );

  test.each([
    { callerScope: "operator.read", requestedScope: "operator.write" },
    { callerScope: "no scopes", requestedScope: "operator.write" },
    { callerScope: "operator.write", requestedScope: "operator.admin" },
    { callerScope: "operator.write", requestedScope: "operator.approvals" },
  ] as const)(
    "rejects explicit $requestedScope duplex escalation from an authenticated $callerScope caller",
    async ({ callerScope, requestedScope }) => {
      const scopes = callerScope === "no scopes" ? [] : [callerScope];
      const callerAbort = new AbortController();
      const registry = createDuplexPluginRegistry();
      loadOpenClawPlugins.mockReturnValue(registry);
      loadGatewayStartupPluginsForTest();
      const context = {
        nodeRegistry: { sendInvokeInput: vi.fn() },
      } as unknown as GatewayRequestContext;
      serverPluginsModule.setFallbackGatewayContext(context);
      const requestScope = {
        context,
        client: { connect: { scopes } } as GatewayRequestOptions["client"],
        isWebchatConnect: () => false,
        pluginRegistry: registry,
      } satisfies PluginRuntimeGatewayRequestScope;
      const runtime = createRuntimeFromLastGatewayLoad();

      await expect(
        gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(requestScope, () =>
          gatewayRequestScopeModule.withPluginRuntimePluginScope(
            { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
            () =>
              runtime.nodes.openDuplex({
                nodeId: "node-1",
                command: "image.bridge",
                scopes: [requestedScope],
                signal: callerAbort.signal,
              }),
          ),
        ),
      ).rejects.toThrow("exceed the authenticated Gateway caller's authority");
      expect(handleGatewayRequest).not.toHaveBeenCalled();
      callerAbort.abort(new Error("denied invocation caller retired"));
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
  );

  test("waits for framed readiness and carries binary messages through canonical invoke transport", async () => {
    const registry = createDuplexPluginRegistry();
    loadOpenClawPlugins.mockReturnValue(registry);
    loadGatewayStartupPluginsForTest();
    const sendInvokeInput = vi.fn();
    const context = {
      nodeRegistry: { sendInvokeInput },
    } as unknown as GatewayRequestContext;
    serverPluginsModule.setFallbackGatewayContext(context);
    let invokeOptions: HandleGatewayRequestOptions | undefined;
    let finishInvoke: (() => void) | undefined;
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      invokeOptions = opts;
      opts.client?.internal?.nodeInvokeStream?.onDispatchReady("duplex-ready-invoke");
      await new Promise<void>((resolve) => {
        finishInvoke = () => {
          opts.respond(true, { ok: true, payload: { complete: true } });
          resolve();
        };
      });
    });
    const runtime = createRuntimeFromLastGatewayLoad();
    const requestScope = {
      context,
      client: {
        connect: { scopes: ["operator.read", "operator.write"] },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
      pluginRegistry: registry,
    } satisfies PluginRuntimeGatewayRequestScope;
    let settled = false;
    const opening = gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(
      requestScope,
      () =>
        gatewayRequestScopeModule.withPluginRuntimePluginScope(
          { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
          () =>
            runtime.nodes.openDuplex({
              nodeId: "node-1",
              command: "image.bridge",
              scopes: ["operator.write"],
            }),
        ),
    );
    void opening.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(invokeOptions).toBeDefined());
    expect(settled).toBe(false);
    expect(getLastDispatchedClientScopes()).toEqual(["operator.write"]);

    const stream = invokeOptions?.client?.internal?.nodeInvokeStream;
    stream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
    const channel = await opening;
    const onMessage = vi.fn();
    channel.onMessage(onMessage);
    stream?.onProgress(
      JSON.stringify({ v: 1, kind: "data", message: 0, index: 0, last: true, data: "BAU=" }),
    );
    await channel.send(Uint8Array.of(1, 2, 3));

    expect(onMessage).toHaveBeenCalledWith(Uint8Array.of(4, 5));
    expect(sendInvokeInput).toHaveBeenCalledWith(
      "duplex-ready-invoke",
      expect.objectContaining({ kind: "data", message: 0, index: 0, data: "AQID" }),
    );
    expect(stream?.idleTimeoutMs).toBe(30_000);
    finishInvoke?.();
    await expect(channel.closed).resolves.toEqual({ ok: true, payload: { complete: true } });
    await expect(channel.send(Uint8Array.of(1))).rejects.toThrow(/closed/i);
  });

  test.each(["listener rejection", "caller cancellation"])(
    "waits for terminal asynchronous message delivery and handles %s",
    async (terminalAction) => {
      const registry = createDuplexPluginRegistry();
      loadOpenClawPlugins.mockReturnValue(registry);
      loadGatewayStartupPluginsForTest();
      serverPluginsModule.setFallbackGatewayContext({
        nodeRegistry: { sendInvokeInput: vi.fn() },
      } as unknown as GatewayRequestContext);
      let invokeOptions: HandleGatewayRequestOptions | undefined;
      let finishInvoke: (() => void) | undefined;
      handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        invokeOptions = opts;
        opts.client?.internal?.nodeInvokeStream?.onDispatchReady("duplex-terminal-delivery");
        await new Promise<void>((resolve) => {
          finishInvoke = () => {
            opts.respond(true, { ok: true });
            resolve();
          };
        });
      });
      const runtime = createRuntimeFromLastGatewayLoad();
      const opening = gatewayRequestScopeModule.withPluginRuntimeRegistryScope(registry, () =>
        gatewayRequestScopeModule.withPluginRuntimePluginScope(
          { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
          () => runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
        ),
      );
      await vi.waitFor(() => expect(invokeOptions).toBeDefined());
      const stream = invokeOptions?.client?.internal?.nodeInvokeStream;
      stream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
      const channel = await opening;
      let rejectDelivery: ((error: Error) => void) | undefined;
      channel.onMessage(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectDelivery = reject;
          }),
      );

      stream?.onProgress(
        JSON.stringify({ v: 1, kind: "data", message: 0, index: 0, last: true, data: "AQ==" }),
      );
      finishInvoke?.();
      let closedSettled = false;
      void channel.closed.then(
        () => {
          closedSettled = true;
        },
        () => {
          closedSettled = true;
        },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(closedSettled).toBe(false);

      if (terminalAction === "listener rejection") {
        rejectDelivery?.(new Error("terminal message listener rejected"));
        await expect(channel.closed).rejects.toThrow("terminal message listener rejected");
      } else {
        channel.close();
        await expect(channel.closed).rejects.toThrow(/closed|cancel/i);
      }
    },
  );

  test("cancels a retained duplex invocation when its delegated caller authority closes", async () => {
    const registry = createDuplexPluginRegistry();
    loadOpenClawPlugins.mockReturnValue(registry);
    loadGatewayStartupPluginsForTest();
    const sendInvokeInput = vi.fn();
    const validateAgentRuntimeApprovalAuthority = vi.fn(() => true);
    const context = {
      nodeRegistry: { sendInvokeInput },
      validateAgentRuntimeApprovalAuthority,
    } as unknown as GatewayRequestContext;
    serverPluginsModule.setFallbackGatewayContext(context);
    let invokeSignal: AbortSignal | undefined;
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      invokeSignal = opts.signal;
      opts.client?.internal?.nodeInvokeStream?.onDispatchReady("delegated-duplex");
      opts.client?.internal?.nodeInvokeStream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const operationalRunInstance = {
      instanceId: "delegated-instance",
      runId: "delegated-run",
    };
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal = {
      ...client.internal,
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:delegated",
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          lifecycleGeneration: "delegated-generation",
          claimId: "delegated-claim",
          operationalRunInstance,
        },
      },
    };
    const requestScope = {
      context,
      client,
      isWebchatConnect: () => false,
      pluginRegistry: registry,
    } satisfies PluginRuntimeGatewayRequestScope;
    const runtime = createRuntimeFromLastGatewayLoad();
    const channel = await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(
      requestScope,
      () =>
        gatewayRequestScopeModule.withPluginRuntimePluginScope(
          { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
          () => runtime.nodes.openDuplex({ nodeId: "node-1", command: "image.bridge" }),
        ),
    );

    validateAgentRuntimeApprovalAuthority.mockReturnValue(false);

    await expect(channel.send(Uint8Array.of(1))).rejects.toThrow(/authority.*no longer current/i);
    expect(invokeSignal?.aborted).toBe(true);
    expect(sendInvokeInput).not.toHaveBeenCalled();
    await expect(channel.closed).rejects.toThrow(/authority.*no longer current/i);
    expect(() => channel.onMessage(vi.fn())).toThrow(/authority.*no longer current/i);
  });

  test("cancels an open node duplex invocation before retiring its plugin runtime", async () => {
    const registry = createDuplexPluginRegistry("plugin.duplex.v1");
    loadOpenClawPlugins.mockReturnValue(registry);
    const context = {
      nodeRegistry: { sendInvokeInput: vi.fn() },
    } as unknown as GatewayRequestContext;
    serverPluginsModule.setFallbackGatewayContext(context);
    const loaded = serverPluginsModule.loadGatewayPlugins({
      cfg: {},
      workspaceDir: "/tmp",
      log: createTestLog(),
      coreGatewayHandlers: {},
      baseMethods: [],
      pluginIds: ["duplex-plugin"],
      resolveGatewayContext: () => resolveTestGatewayContext(),
    });
    runtimeRegistryModule.setActivePluginRegistry(loaded.pluginRegistry);

    let invokeSignal: AbortSignal | undefined;
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      invokeSignal = opts.signal;
      const stream = opts.client?.internal as
        | {
            nodeInvokeStream?: {
              onDispatchReady: (invokeId: string) => void;
              onProgress: (chunk: string) => void;
            };
          }
        | undefined;
      stream?.nodeInvokeStream?.onDispatchReady("duplex-retire-invoke");
      stream?.nodeInvokeStream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener(
          "abort",
          () => {
            opts.respond(false, undefined, { code: "ABORTED", message: "node invoke cancelled" });
            resolve();
          },
          { once: true },
        );
      });
    });

    const runtime = createRuntimeFromLastGatewayLoad();
    const nodes = runtime.nodes as PluginRuntime["nodes"] & {
      openDuplex: (params: { nodeId: string; command: string }) => Promise<{
        closed: Promise<unknown>;
        send: (message: Uint8Array) => Promise<void>;
      }>;
    };
    const channel = await gatewayRequestScopeModule.withPluginRuntimeRegistryScope(registry, () =>
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "duplex-plugin", pluginOrigin: "bundled" },
        () => nodes.openDuplex({ nodeId: "node-1", command: "plugin.duplex.v1" }),
      ),
    );

    loaded.retireGatewayRuntimeBindings();

    expect(invokeSignal?.aborted).toBe(true);
    await expect(channel.closed).rejects.toThrow(/retired|cancel/i);
    await expect(channel.send(Uint8Array.of(1))).rejects.toThrow(/retired|closed/i);
  });

  test("forwards provider and model overrides when the request scope is authorized", async () => {
    const runtime = await createRequestScopedSubagentRuntime();
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

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-override");
    expect(params.message).toBe("use the override");
    expect(params.provider).toBe("anthropic");
    expect(params.model).toBe("claude-haiku-4-5");
    expect(params.deliver).toBe(false);
  });

  test("returns resolved runtime metadata from plugin-owned subagent starts", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("resolved-subagent-runtime"));
    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
      expect(opts.req.method).toBe("agent");
      opts.respond(true, {
        runId: "run-claude",
        sessionKey: "agent:worker:s-runtime",
        runtime: {
          harness: "claude-cli",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      });
    });

    await expect(
      runtime.run({
        sessionKey: "s-runtime",
        message: "use configured runtime",
      }),
    ).resolves.toEqual({
      runId: "run-claude",
      sessionKey: "agent:worker:s-runtime",
      runtime: {
        harness: "claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
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

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-idem-forward");
    expect(params.message).toBe("hello");
    expect(params.idempotencyKey).toBe("caller-provided-key");
  });

  test("forwards cwd on plugin-owned subagent runs", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("cwd-forward"));

    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "workboard", pluginOrigin: "bundled" },
      () =>
        runtime.run({
          sessionKey: "s-cwd-forward",
          message: "hello",
          cwd: "/tmp/managed-worktree",
        }),
    );

    expect(getRequiredLastDispatchedParams().cwd).toBe("/tmp/managed-worktree");
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("workboard");
  });

  test("forwards exact plugin-owned additive tools through internal run metadata", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("tools-also-allow"));
    registerActivePluginToolOwnership("workboard", [
      "workboard_heartbeat",
      "workboard_complete",
      "workboard_block",
    ]);

    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "workboard", pluginOrigin: "bundled" },
      () =>
        runtime.run({
          sessionKey: "s-tools-also-allow",
          message: "finish the card",
          toolsAlsoAllow: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
        }),
    );

    expect(getLastDispatchedClientInternal().runtimePluginToolGrant).toEqual({
      pluginId: "workboard",
      toolNames: ["workboard_heartbeat", "workboard_complete"],
    });
    expect(getRequiredLastDispatchedParams()).not.toHaveProperty("toolsAlsoAllow");
  });

  test("rejects additive subagent tools not registered by the calling plugin", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("foreign-tools-also-allow"));
    registerActivePluginToolOwnership("workboard", ["workboard_complete"]);
    registerActivePluginToolOwnership("other-plugin", ["other_plugin_tool"]);

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: "workboard", pluginOrigin: "bundled" },
        () =>
          runtime.run({
            sessionKey: "s-foreign-tools-also-allow",
            message: "finish the card",
            toolsAlsoAllow: ["other_plugin_tool"],
          }),
      ),
    ).rejects.toThrow('plugin "workboard" does not uniquely own subagent tool "other_plugin_tool"');
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  test("accepts additive tools declared by an unnamed plugin factory", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("declared-tools-also-allow"));
    registerActivePluginToolOwnership("workboard", [], ["workboard_complete"]);

    await gatewayRequestScopeModule.withPluginRuntimePluginScope(
      { pluginId: "workboard", pluginOrigin: "bundled" },
      () =>
        runtime.run({
          sessionKey: "s-declared-tools-also-allow",
          message: "finish the card",
          toolsAlsoAllow: ["workboard_complete"],
        }),
    );

    expect(getLastDispatchedClientInternal().runtimePluginToolGrant).toEqual({
      pluginId: "workboard",
      toolNames: ["workboard_complete"],
    });
  });

  test("rejects core and ambiguously-owned additive tool names", async () => {
    const runtime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("colliding-tools-also-allow"));
    registerActivePluginToolOwnership("workboard", ["exec", "workboard_complete"]);
    registerActivePluginToolOwnership("other-plugin", ["workboard_complete"]);

    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("workboard", () =>
        runtime.run({
          sessionKey: "s-core-tools-also-allow",
          message: "run a command",
          toolsAlsoAllow: ["exec"],
        }),
      ),
    ).rejects.toThrow('plugin "workboard" may not add core tool "exec" to subagent runs');
    await expect(
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("workboard", () =>
        runtime.run({
          sessionKey: "s-ambiguous-tools-also-allow",
          message: "finish the card",
          toolsAlsoAllow: ["workboard_complete"],
        }),
      ),
    ).rejects.toThrow(
      'plugin "workboard" does not uniquely own subagent tool "workboard_complete"',
    );
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  test("clears inherited additive grants when a scoped plugin run requests none", async () => {
    const runtime = await createRequestScopedSubagentRuntime();
    const scope = {
      context: createTestContext("clear-tools-also-allow"),
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRunTracking: "plugin_subagent",
          pluginRuntimeOwnerId: "other-plugin",
          runtimePluginToolGrant: {
            pluginId: "other-plugin",
            toolNames: ["other_plugin_tool"],
          },
          delegatedToolPolicyHandoffId: "handoff-old",
        },
      } as unknown as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
      pluginId: "workboard",
      pluginOrigin: "bundled" as const,
    } satisfies PluginRuntimeGatewayRequestScope;

    await gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        sessionKey: "s-clear-tools-also-allow",
        message: "do normal work",
      }),
    );

    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("workboard");
    expect(getLastDispatchedClientInternal().runtimePluginToolGrant).toBeUndefined();
    expect(getLastDispatchedClientInternal().delegatedToolPolicyHandoffId).toBeUndefined();
  });

  test("forwards bounded context options on subagent run", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("light-context-forward"));

    await runtime.run({
      sessionKey: "s-light-context",
      message: "hello",
      lightContext: true,
      promptMode: "minimal",
      lane: "dreaming-narrative:s-light-context",
      deliver: false,
    });

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-light-context");
    expect(params.message).toBe("hello");
    expect(params.lane).toBe("dreaming-narrative:s-light-context");
    expect(params.bootstrapContextMode).toBe("lightweight");
    expect(params.promptMode).toBe("minimal");
    expect(params.deliver).toBe(false);
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
    if (params === undefined) {
      throw new Error("expected dispatched agent params");
    }
    // The gateway `agent` schema requires `idempotencyKey: NonEmptyString`, so
    // the runtime must always send a populated value. A missing field here
    // would reproduce the memory-core dreaming-narrative regression.
    const generated = params.idempotencyKey;
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
    expect(normalizeProviderModelIdWithRuntime).not.toHaveBeenCalled();
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

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-trusted-override");
    expect(params.provider).toBe("anthropic");
    expect(params.model).toBe("claude-haiku-4-5");
    expect(normalizeProviderModelIdWithRuntime).toHaveBeenCalledOnce();
  });

  test("keeps fallback model policy bound to the runtime that loaded it", async () => {
    const allowedRuntime = await createSubagentRuntime(serverPluginsModule, {
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
    const deniedRuntime = await createSubagentRuntime(serverPluginsModule);
    serverPluginsModule.setFallbackGatewayContext(createTestContext("fallback-policy-binding"));
    const run = (runtime: PluginRuntime["subagent"]) =>
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("voice-call", () =>
        runtime.run({
          sessionKey: "s-policy-binding",
          message: "use trusted override",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          deliver: false,
        }),
      );

    await expect(run(allowedRuntime)).resolves.toMatchObject({ runId: expect.any(String) });
    await expect(run(deniedRuntime)).rejects.toThrow(
      'plugin "voice-call" is not trusted for fallback provider/model override requests.',
    );
  });

  test("tags plugin fallback subagent runs with the creating plugin id", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-plugin-owner"));

    await gatewayRequestScopeModule.withPluginRuntimePluginIdScope("memory-core", () =>
      runtime.run({
        sessionKey: "dreaming-narrative-light-workspace-1",
        message: "write a narrative",
        deliver: false,
      }),
    );

    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("memory-core");
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
      'plugin "voice-call" is not trusted for fallback provider/model override requests. See https://docs.openclaw.ai/plugins/sdk-runtime#api-runtime-subagent and search for: plugins.entries.<id>.subagent.allowModelOverride',
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

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-model-only-override");
    expect(params.model).toBe("anthropic/claude-haiku-4-5");
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

  test.each([
    { origin: "bundled" as const, expectedActor: { kind: "system" } },
    { origin: "global" as const, expectedActor: undefined },
  ])(
    "limits background system session reads to trusted $origin plugins",
    async ({ origin, expectedActor }) => {
      const runtime = await createSubagentRuntime(serverPluginsModule);
      serverPluginsModule.setFallbackGatewayContext(createTestContext(`background-read-${origin}`));
      handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
        expect(opts.client?.internal?.operatorRoleActor).toEqual(expectedActor);
        opts.respond(true, { messages: [] });
      });

      await gatewayRequestScopeModule.withPluginRuntimePluginScope(
        { pluginId: `background-${origin}`, pluginOrigin: origin },
        () => runtime.getSessionMessages({ sessionKey: "agent:main:background" }),
      );
    },
  );

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

  test("uses owner-scoped synthetic admin for plugin-created session cleanup", async () => {
    const serverPlugins = serverPluginsModule;
    const runtime = await createSubagentRuntime(serverPlugins);
    serverPlugins.setFallbackGatewayContext(createTestContext("fallback-plugin-delete-session"));

    handleGatewayRequest.mockImplementationOnce(async (opts: HandleGatewayRequestOptions) => {
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
      gatewayRequestScopeModule.withPluginRuntimePluginIdScope("memory-core", () =>
        runtime.deleteSession({
          sessionKey: "dreaming-narrative-light-workspace-1",
          deleteTranscript: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("memory-core");
  });

  test("allows session deletion when the request scope already has admin", async () => {
    const runtime = await createRequestScopedSubagentRuntime();
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

  test("keeps plugin owner metadata on admin-scoped plugin session cleanup", async () => {
    const runtime = await createRequestScopedSubagentRuntime();
    const scope = {
      context: createTestContext("request-scope-plugin-delete-session"),
      client: {
        connect: {
          scopes: ["operator.admin"],
        },
      } as GatewayRequestOptions["client"],
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await expect(
      gatewayRequestScopeModule.withPluginRuntimeGatewayRequestScope(scope, () =>
        gatewayRequestScopeModule.withPluginRuntimePluginIdScope("memory-core", () =>
          runtime.deleteSession({
            sessionKey: "dreaming-narrative-light-workspace-1",
            deleteTranscript: true,
          }),
        ),
      ),
    ).resolves.toBeUndefined();

    expect(getLastDispatchedClientScopes()).toEqual(["operator.admin"]);
    expect(getLastDispatchedClientInternal().pluginRuntimeOwnerId).toBe("memory-core");
  });

  test("can select setup-runtime channel plugins for setup flows", () => {
    loadOpenClawPlugins.mockReturnValue(createRegistry([]));
    loadGatewayPluginsForTest({
      channelPluginLoadIntent: "setup",
    });

    expect(getLastPluginLoadOption("channelPluginLoadIntent")).toBe("setup");
  });

  test("primes configured bindings during gateway startup", () => {
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

    const params = getRequiredLastDispatchedParams();
    expect(params.sessionKey).toBe("s-auto-enabled-bootstrap-policy");
    expect(params.model).toBe("openai/gpt-5.4");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
