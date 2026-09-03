import { type Mock, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import type { configureNodeHost } from "./config.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedConfiguredGatewayConfigs: [] as Array<{ contextPath?: string }>,
  capturedGatewayClients: [] as Array<{
    request: Mock<(method: string, params?: unknown) => Promise<unknown>>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    updateNodeManifest: ReturnType<typeof vi.fn>;
  }>,
  mcpDescriptors: [] as Array<Record<string, unknown>>,
  mcpDescriptorsChanged: undefined as (() => void) | undefined,
  nodePluginTools: [] as Array<Record<string, unknown>>,
  nodeSkillDescriptors: [] as Array<Record<string, unknown>>,
  runtimeSteps: [] as string[],
  useFakeRuntime: false,
  fakeRuntimeWorkerHosting: false,
  fakeRuntimeWorkerHostingDisabledReason: undefined as string | undefined,
  runnerCapacityChanged: undefined as
    | ((capacity: { total: number; available: number }) => void)
    | undefined,
  nodeHostCommands: [] as string[],
  nodeHostCaps: [] as string[],
  availabilityOnWatch: undefined as { caps: string[]; commands: string[] } | undefined,
  availabilityChanged: undefined as (() => void) | undefined,
  normalizedPath: null as string | null,
  resolvedExecutables: new Map<string, string>(),
  runtimeClient: undefined as
    | { request: (method: string, params?: unknown) => Promise<unknown> }
    | undefined,
  closeMcpManager: vi.fn(async () => undefined),
  runStartupMigrations: vi.fn(async () => undefined),
  configureNodeHost: vi.fn(async (params: Parameters<typeof configureNodeHost>[0]) => {
    mocks.capturedConfiguredGatewayConfigs.push(params.gateway);
    return {
      version: 1 as const,
      nodeId: params.nodeId?.trim() || "node-test",
      displayName: params.displayName?.trim() || params.fallbackDisplayName,
      gateway: params.gateway,
    };
  }),
  getRuntimeConfig: vi.fn<() => unknown>(() => ({ gateway: { handshakeTimeoutMs: 1_000 } })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
  resolveGatewayCredentialsWithSecretInputs: vi.fn(async (_params: { config: unknown }) => ({})),
  activeRuntime: {
    invoke: vi.fn(async () => {}),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    updateGatewayConnection: vi.fn(),
    close: vi.fn(async () => {}),
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/client.js")>();
  return {
    ...actual,
    GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
      const client = {
        request: vi.fn(async () => ({})),
        start: vi.fn(),
        stop: vi.fn(),
        updateNodeManifest: vi.fn(),
      };
      mocks.capturedGatewayClientOptions.push(opts);
      mocks.capturedGatewayClients.push(client);
      return client;
    },
  };
});

vi.mock("../gateway/credentials-secret-inputs.js", () => ({
  resolveGatewayCredentialsWithSecretInputs: mocks.resolveGatewayCredentialsWithSecretInputs,
}));

vi.mock("../infra/device-identity.js", () => ({
  loadOrCreateDeviceIdentity: vi.fn(() => ({
    id: "device-test",
    publicKey: "public-key-test",
    privateKey: "private-key-test",
  })),
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: vi.fn(async () => "test-node"),
}));

vi.mock("../infra/machine-model.js", () => ({
  resolveMachineModelIdentifier: vi.fn(() => "TestMachine1,1"),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutableFromPathEnv: vi.fn((bin: string) => mocks.resolvedExecutables.get(bin) ?? null),
}));

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(() => {
    mocks.runtimeSteps.push("path");
    if (mocks.normalizedPath) {
      process.env.PATH = mocks.normalizedPath;
    }
  }),
}));

vi.mock("./config.js", () => ({
  configureNodeHost: mocks.configureNodeHost,
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn((context: { env: NodeJS.ProcessEnv }) => {
    mocks.runtimeSteps.push(`commands:${context.env.PATH ?? ""}`);
    return {
      commands: [...mocks.nodeHostCommands],
      caps: [...mocks.nodeHostCaps],
      nodePluginTools: [...mocks.nodePluginTools],
    };
  }),
  watchRegisteredNodeHostCommandAvailability: vi.fn((_context: unknown, onChange: () => void) => {
    mocks.availabilityChanged = onChange;
    if (mocks.availabilityOnWatch) {
      mocks.nodeHostCaps = [...mocks.availabilityOnWatch.caps];
      mocks.nodeHostCommands = [...mocks.availabilityOnWatch.commands];
    }
    return () => {
      mocks.availabilityChanged = undefined;
    };
  }),
}));

vi.mock("./mcp.js", () => ({
  startNodeHostMcpManager: vi.fn(
    async (
      _servers: unknown,
      deps?: {
        onDescriptorsChanged?: () => void;
      },
    ) => {
      mocks.mcpDescriptorsChanged = deps?.onDescriptorsChanged;
      return {
        descriptors: mocks.mcpDescriptors,
        callMcpTool: vi.fn(),
        close: mocks.closeMcpManager,
      };
    },
  ),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => mocks.nodeSkillDescriptors),
}));

vi.mock("./startup-state-migrations.js", () => ({
  runStartupMigrations: mocks.runStartupMigrations,
}));

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    prepareNodeHostRuntime: async (
      ...args: Parameters<typeof actual.prepareNodeHostRuntime>
    ): ReturnType<typeof actual.prepareNodeHostRuntime> => {
      if (!mocks.useFakeRuntime) {
        return await actual.prepareNodeHostRuntime(...args);
      }
      return {
        manifest: {
          caps: [],
          commands: [],
          pathEnv: process.env.PATH ?? "",
        },
        workerHostingEnabled: mocks.fakeRuntimeWorkerHosting,
        workerHostingDisabledReason: mocks.fakeRuntimeWorkerHostingDisabledReason,
        initialInventory: { skills: [], pluginTools: [] },
        start: (params) => {
          mocks.runtimeClient = params.client;
          mocks.runnerCapacityChanged = params.onRunnerCapacityChanged;
          return mocks.activeRuntime;
        },
      };
    },
  };
});

// Load after mock registration and retain local bindings for Vitest's export transform.
const { runNodeHost } = await import("./runner.js");
const { startNodeHostMcpManager } = await import("./mcp.js");

export function lastCapturedOptions(): GatewayClientOptions | undefined {
  return mocks.capturedGatewayClientOptions.at(-1);
}

export function resetRunnerTestState() {
  mocks.capturedGatewayClientOptions.length = 0;
  mocks.capturedConfiguredGatewayConfigs.length = 0;
  mocks.capturedGatewayClients.length = 0;
  mocks.mcpDescriptors = [];
  mocks.mcpDescriptorsChanged = undefined;
  mocks.nodePluginTools = [
    {
      pluginId: "test-plugin",
      name: "remote_echo",
      description: "Echo from node host",
      command: "test.echo",
      parameters: { type: "object", properties: {} },
    },
  ];
  mocks.nodeSkillDescriptors = [];
  mocks.runtimeSteps = [];
  mocks.useFakeRuntime = false;
  mocks.fakeRuntimeWorkerHosting = false;
  mocks.fakeRuntimeWorkerHostingDisabledReason = undefined;
  mocks.runnerCapacityChanged = undefined;
  mocks.nodeHostCommands = [];
  mocks.nodeHostCaps = [];
  mocks.availabilityOnWatch = undefined;
  mocks.availabilityChanged = undefined;
  mocks.normalizedPath = null;
  mocks.resolvedExecutables.clear();
  mocks.runtimeClient = undefined;
  vi.clearAllMocks();
  mocks.getRuntimeConfig.mockReturnValue({
    gateway: { handshakeTimeoutMs: 1_000 },
  });
}

export { mocks, runNodeHost, startNodeHostMcpManager };
