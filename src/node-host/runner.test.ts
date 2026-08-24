/** Tests node-host runner command parsing, timeout, and plugin dispatch behavior. */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import type { configureNodeHost } from "./config.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import { runNodeHost } from "./runner.js";

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";

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

function lastCapturedOptions(): GatewayClientOptions | undefined {
  return mocks.capturedGatewayClientOptions.at(-1);
}

describe("runNodeHost", () => {
  beforeEach(() => {
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
  });

  it("runs startup state migrations before constructing node-host state", async () => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(mocks.runStartupMigrations).toHaveBeenCalledTimes(1);
    expect(mocks.runStartupMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.configureNodeHost.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    { runtime: "darwin", platform: "macos", deviceFamily: "Mac" },
    { runtime: "win32", platform: "windows", deviceFamily: "Windows" },
    { runtime: "linux", platform: "linux", deviceFamily: "Linux" },
    { runtime: "freebsd", platform: "unknown", deviceFamily: undefined },
  ] as const)(
    "maps $runtime to gateway platform $platform",
    async ({ runtime, platform, deviceFamily }) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(runtime);
      try {
        await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
          "event loop readiness timeout",
        );
      } finally {
        platformSpy.mockRestore();
      }

      expect(lastCapturedOptions()?.platform).toBe(platform);
      expect(lastCapturedOptions()?.deviceFamily).toBe(deviceFamily);
    },
  );

  it("passes a paired bootstrap credential with first-connect preference", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "gateway.example",
        gatewayPort: 443,
        gatewayTls: true,
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()).toMatchObject({
      bootstrapToken: "bootstrap-123",
      preferBootstrapToken: true,
    });
    expect(lastCapturedOptions()?.token).toBeUndefined();
    expect(mocks.resolveGatewayCredentialsWithSecretInputs).not.toHaveBeenCalled();
  });

  it("persists the pairing candidate that completes the handshake", async () => {
    mocks.useFakeRuntime = true;
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({
        gatewayHost: "192.168.1.20",
        gatewayPort: 18789,
        gatewayBootstrapToken: "bootstrap-123",
        preferGatewayBootstrapToken: true,
        gatewayCandidates: [
          { host: "192.168.1.20", port: 18789, tls: false },
          { host: "gateway.tailnet.example", port: 443, tls: true },
        ],
      });
      await vi.waitFor(() => expect(mocks.capturedGatewayClients).toHaveLength(1));

      const firstOptions = mocks.capturedGatewayClientOptions[0];
      firstOptions?.onClose?.(1006, "transport unavailable", {
        phase: "pre-hello",
        socketOpened: false,
        transportValidated: false,
        connectRequestSent: false,
        transientPreHelloCleanClose: false,
      });
      await vi.waitFor(() => expect(mocks.capturedGatewayClients).toHaveLength(2));

      expect(mocks.capturedGatewayClientOptions[1]?.url).toBe("wss://gateway.tailnet.example:443");

      mocks.capturedGatewayClientOptions[1]?.onHelloOk?.({} as never);
      await vi.waitFor(() => expect(mocks.configureNodeHost).toHaveBeenCalledTimes(2));
      expect(mocks.capturedConfiguredGatewayConfigs[1]).toEqual({
        host: "gateway.tailnet.example",
        port: 443,
        tls: true,
      });

      await vi.waitFor(() =>
        expect(processOnceSpy.mock.calls.some(([event]) => event === "SIGTERM")).toBe(true),
      );
      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      onSigterm?.("SIGTERM");
      await running;
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
    }
  });

  it("stops the canonical runtime after a service enrollment hello", async () => {
    mocks.useFakeRuntime = true;
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({
        gatewayHost: "gateway.example",
        gatewayPort: 443,
        gatewayTls: true,
        gatewayBootstrapToken: "bootstrap-token",
        preferGatewayBootstrapToken: true,
        stopAfterFirstConnect: true,
      });
      await vi.waitFor(() => expect(lastCapturedOptions()?.onHelloOk).toBeTypeOf("function"));
      lastCapturedOptions()?.onHelloOk?.({
        protocol: 1,
        features: { methods: [], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      await running;

      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("routes invoke input, cancellation, and connection close to the runtime", async () => {
    mocks.useFakeRuntime = true;
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    const options = lastCapturedOptions();

    options?.onEvent?.({
      type: "event",
      event: "node.invoke.input",
      payload: { id: "invoke-1", nodeId: "node-1", seq: 3, payloadJSON: '{"kind":"data"}' },
    });
    options?.onEvent?.({
      type: "event",
      event: "node.invoke.cancel",
      payload: { invokeId: "invoke-1", nodeId: "node-1" },
    });
    options?.onClose?.(1000, "connection closed");

    expect(mocks.activeRuntime.handleInput).toHaveBeenCalledWith("invoke-1", 3, '{"kind":"data"}');
    expect(mocks.activeRuntime.cancel).toHaveBeenCalledWith("invoke-1");
    expect(mocks.activeRuntime.cancelAll).toHaveBeenCalledOnce();
  });

  it.each([
    ["127.0.0.1", "ws://127.0.0.1:18789"],
    ["gateway.local", "ws://gateway.local:18789"],
    ["::1", "ws://[::1]:18789"],
    ["[::1]", "ws://[::1]:18789"],
  ])("passes Gateway host %s as URL %s", async (gatewayHost, expectedUrl) => {
    await expect(
      runNodeHost({
        gatewayHost,
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(mocks.capturedGatewayClientOptions).toHaveLength(1);
    expect(mocks.capturedGatewayClientOptions[0]?.url).toBe(expectedUrl);
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
  });

  it("strips remote credentials before resolving local node-host auth", async () => {
    const config = {
      gateway: {
        mode: "local",
        remote: { token: "remote-token", password: "remote-password" },
      },
    };
    setConfigResolutionFacts(
      config,
      new Set(["gateway.auth.token", "gateway.remote.token", "gateway.remote.password"]),
    );
    mocks.getRuntimeConfig.mockReturnValue(config);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(mocks.resolveGatewayCredentialsWithSecretInputs).toHaveBeenCalledWith({
      config: {
        gateway: {
          mode: "local",
          remote: { token: undefined, password: undefined },
        },
      },
      env: process.env,
      localPrecedence: "env-first",
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "env-first",
    });
    const resolvedConfig =
      mocks.resolveGatewayCredentialsWithSecretInputs.mock.calls[0]?.[0].config;
    expect(getConfigResolutionFacts(resolvedConfig)).toEqual(new Set(["gateway.auth.token"]));
    expect(config.gateway.remote).toEqual({
      token: "remote-token",
      password: "remote-password",
    });
  });

  it("bootstraps PATH before probing plugin command availability", async () => {
    const originalPath = process.env.PATH;
    mocks.normalizedPath = "/normalized/node/path";
    try {
      await expect(
        runNodeHost({
          gatewayHost: "127.0.0.1",
          gatewayPort: 18789,
        }),
      ).rejects.toThrow("event loop readiness timeout");
    } finally {
      process.env.PATH = originalPath;
    }

    expect(mocks.runtimeSteps).toEqual([
      "path",
      "commands:/normalized/node/path",
      "commands:/normalized/node/path",
    ]);
  });

  it("reconciles the manifest after watch attachment and on later changes", async () => {
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    mocks.availabilityOnWatch = {
      caps: ["canvas"],
      commands: ["canvas.present"],
    };
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      await vi.waitFor(() =>
        expect(mocks.capturedGatewayClients[0]?.updateNodeManifest).toHaveBeenCalledWith(
          expect.objectContaining({
            caps: expect.arrayContaining(["canvas"]),
            commands: expect.arrayContaining(["canvas.present"]),
          }),
        ),
      );

      mocks.nodeHostCaps = [];
      mocks.nodeHostCommands = [];
      mocks.availabilityChanged?.();
      expect(mocks.capturedGatewayClients[0]?.updateNodeManifest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          caps: expect.not.arrayContaining(["canvas"]),
          commands: expect.not.arrayContaining(["canvas.present"]),
        }),
      );

      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      onSigterm?.("SIGTERM");
      await running;
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
    }
  });

  it("keeps a ref'd lifetime handle until a ready foreground host stops", async () => {
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const unref = vi.fn();
    const interval = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    let resolveCloseMcp: (() => void) | undefined;
    mocks.closeMcpManager.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveCloseMcp = () => resolve(undefined);
        }),
    );
    try {
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      await vi.waitFor(() =>
        expect(processOnceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function)),
      );
      await vi.waitFor(() => expect(startNodeHostMcpManager).toHaveBeenCalled());

      expect(setIntervalSpy).toHaveBeenCalledOnce();
      expect(unref).not.toHaveBeenCalled();
      expect(clearIntervalSpy).not.toHaveBeenCalled();

      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      expect(onSigterm).toBeTypeOf("function");
      onSigterm?.("SIGTERM");
      await vi.waitFor(() => expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce());

      expect(clearIntervalSpy).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.closeMcpManager).toHaveBeenCalledOnce());
      expect(resolveCloseMcp).toBeTypeOf("function");
      resolveCloseMcp?.();
      await running;

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("clears the lifetime handle when gateway startup rejects", async () => {
    const startupError = new Error("gateway startup failed");
    mocks.startGatewayClientWhenEventLoopReady.mockRejectedValueOnce(startupError);
    const interval = {} as ReturnType<typeof setInterval>;
    const setIntervalSpy = vi.spyOn(global, "setInterval").mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(global, "clearInterval").mockImplementation(() => {});
    try {
      await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toBe(
        startupError,
      );

      expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalledOnce();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("declares the built-in MCP command family before any server is configured", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.caps).toContain("mcp");
    expect(lastCapturedOptions()?.commands).toContain("mcp.tools.call.v1");
    expect(lastCapturedOptions()?.commands).not.toContain("agent.cli.claude.run.v1");
    expect(lastCapturedOptions()?.workerRuns).toBeUndefined();
  });

  it("keeps unavailable worker hosting out of the handshake and reports the reason", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { workerRuns: { enabled: true } },
    } as never);
    mocks.useFakeRuntime = true;
    mocks.fakeRuntimeWorkerHostingDisabledReason = "Docker or Podman is unavailable";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(lastCapturedOptions()?.workerRuns).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(
      "node host worker hosting disabled: Docker or Podman is unavailable\n",
    );
    stderr.mockRestore();
  });

  it("advertises Claude agent runs only after node-local opt-in and binary resolution", async () => {
    mocks.resolvedExecutables.set("claude", "/usr/bin/claude");
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { agentRuns: { claude: { enabled: true } } },
    } as never);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(lastCapturedOptions()?.commands).toContain("agent.cli.claude.run.v1");
  });

  it("publishes node plugin tools only after gateway hello succeeds", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const options = mocks.capturedGatewayClientOptions[0];
    const client = mocks.capturedGatewayClients[0];
    expect(client?.request).not.toHaveBeenCalled();

    options?.onHelloOk?.({
      protocol: 1,
      features: {
        methods: [NODE_PLUGIN_TOOLS_UPDATE_METHOD],
        events: [],
      },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

    expect(client?.request).toHaveBeenCalledWith("node.pluginTools.update", {
      tools: [
        {
          pluginId: "test-plugin",
          name: "remote_echo",
          description: "Echo from node host",
          command: "test.echo",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(client?.request).toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: false },
    });
  });

  it("publishes opt-in consent and capacity in the atomic runner inventory", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { workerRuns: { enabled: true, capacity: 5 } },
    } as never);
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    const options = mocks.capturedGatewayClientOptions[0];
    const client = mocks.capturedGatewayClients[0];

    options?.onHelloOk?.({
      protocol: 4,
      features: { methods: [], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

    expect(client?.request).toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: {
        enabled: true,
        capacity: { total: 5, available: 5 },
        bundlePrewarm: 1,
      },
    });
  });

  it("publishes each exact worker slot transition without reconnecting", async () => {
    mocks.useFakeRuntime = true;
    mocks.fakeRuntimeWorkerHosting = true;
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    const options = mocks.capturedGatewayClientOptions[0];
    const client = mocks.capturedGatewayClients[0];
    expect(options?.workerRuns).toBeUndefined();

    mocks.runnerCapacityChanged?.({ total: 2, available: 2 });
    options?.onHelloOk?.({
      protocol: 4,
      features: {
        methods: [],
        events: [],
        capabilities: [GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION],
      },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    await vi.waitFor(() => {
      expect(client?.request).toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 2, available: 2 },
          bundlePrewarm: 1,
          bundleRetention: 1,
        },
      });
    });

    options?.onHelloOk?.({
      protocol: 4,
      features: {
        methods: [],
        events: [],
        capabilities: [
          GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION,
          GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS,
        ],
      },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    await vi.waitFor(() => {
      expect(client?.request).toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: {
          enabled: true,
          capacity: { total: 2, available: 2 },
          bundlePrewarm: 1,
          bundleRetention: 1,
          bundleStatus: 1,
        },
      });
    });

    const expectPublishedSlots = async (available: number) => {
      mocks.runnerCapacityChanged?.({ total: 2, available });
      await vi.waitFor(() => {
        expect(client?.request).toHaveBeenLastCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: {
            enabled: true,
            capacity: { total: 2, available },
            bundlePrewarm: 1,
            bundleRetention: 1,
            bundleStatus: 1,
          },
        });
      });
    };
    for (const available of [1, 0, 2]) {
      await expectPublishedSlots(available);
    }
    expect(client?.updateNodeManifest).not.toHaveBeenCalled();
  });

  it("clears gateway plugin tools when the final node-hosted tool disappears", async () => {
    mocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: true,
      aborted: false,
      elapsedMs: 0,
    });
    const processOnceSpy = vi.spyOn(process, "once");
    const previousExitCode = process.exitCode;
    try {
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      await vi.waitFor(() => expect(mocks.availabilityChanged).toBeDefined());
      const client = mocks.capturedGatewayClients[0];
      lastCapturedOptions()?.onHelloOk?.({
        protocol: 1,
        features: { methods: [NODE_PLUGIN_TOOLS_UPDATE_METHOD], events: [] },
      } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
      expect(client?.request).toHaveBeenCalledWith("node.pluginTools.update", {
        tools: [expect.objectContaining({ name: "remote_echo" })],
      });

      mocks.nodePluginTools = [];
      mocks.availabilityChanged?.();

      await vi.waitFor(() => {
        expect(client?.request).toHaveBeenLastCalledWith("node.pluginTools.update", { tools: [] });
      });
      const onSigterm = processOnceSpy.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      onSigterm?.("SIGTERM");
      await running;
    } finally {
      for (const [event, listener] of processOnceSpy.mock.calls) {
        if ((event === "SIGINT" || event === "SIGTERM") && typeof listener === "function") {
          process.off(event, listener);
        }
      }
      process.exitCode = previousExitCode;
      processOnceSpy.mockRestore();
    }
  });

  it("publishes node-hosted skills after gateway hello succeeds", async () => {
    mocks.nodeSkillDescriptors = [
      {
        name: "release-helper",
        description: "Prepare a release",
        content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
      },
    ];

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    const options = lastCapturedOptions();
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalledWith(
      "node.skills.update",
      expect.anything(),
    );
    options?.onHelloOk?.({
      protocol: 1,
      features: { methods: [NODE_SKILLS_UPDATE_METHOD], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenCalledWith("node.skills.update", {
      skills: mocks.nodeSkillDescriptors,
    });
  });

  it("does not publish node-hosted skills when disabled", async () => {
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
      nodeHost: { skills: { enabled: false } },
    } as never);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    lastCapturedOptions()?.onHelloOk?.({
      protocol: 1,
      features: { methods: [NODE_SKILLS_UPDATE_METHOD], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalledWith(
      "node.skills.update",
      expect.anything(),
    );
  });

  it("publishes plugin tools during MCP discovery and republishes catalog changes", async () => {
    let resolveReadiness:
      | ((value: { ready: false; aborted: false; elapsedMs: number }) => void)
      | undefined;
    mocks.startGatewayClientWhenEventLoopReady.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReadiness = resolve;
      }),
    );
    let resolveManager: ((manager: NodeHostMcpManager) => void) | undefined;
    vi.mocked(startNodeHostMcpManager).mockImplementationOnce(async (_servers, deps) => {
      mocks.mcpDescriptorsChanged = deps?.onDescriptorsChanged;
      return await new Promise((resolve) => {
        resolveManager = resolve;
      });
    });
    const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
    await vi.waitFor(() => expect(lastCapturedOptions()).toBeDefined());
    lastCapturedOptions()?.onHelloOk?.({
      protocol: 1,
      features: { methods: [NODE_PLUGIN_TOOLS_UPDATE_METHOD], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenCalledWith(
      "node.pluginTools.update",
      { tools: [expect.objectContaining({ pluginId: "test-plugin" })] },
    );

    const descriptors: NodeHostMcpManager["descriptors"] = [
      {
        pluginId: "node-mcp",
        name: "closed_search",
        description: "Search closed server",
        command: "mcp.tools.call.v1",
        mcp: { server: "closed", tool: "search" },
      },
      {
        pluginId: "node-mcp",
        name: "healthy_search",
        description: "Search healthy server",
        command: "mcp.tools.call.v1",
        mcp: { server: "healthy", tool: "search" },
      },
    ];
    resolveManager?.({
      descriptors,
      callMcpTool: vi.fn(),
      close: mocks.closeMcpManager,
    });
    const client = mocks.capturedGatewayClients[0];
    const publishedToolNames = () => {
      const params = client?.request.mock.calls.findLast(
        ([method]) => method === NODE_PLUGIN_TOOLS_UPDATE_METHOD,
      )?.[1] as { tools: Array<{ name?: string }> } | undefined;
      return params?.tools.map((descriptor) => descriptor.name);
    };
    await vi.waitFor(() => {
      expect(publishedToolNames()).toEqual(["closed_search", "healthy_search", "remote_echo"]);
    });

    descriptors.splice(0, 1);
    expect(mocks.mcpDescriptorsChanged).toBeDefined();
    mocks.mcpDescriptorsChanged?.();
    await vi.waitFor(() => {
      expect(publishedToolNames()).toEqual(["healthy_search", "remote_echo"]);
    });
    resolveReadiness?.({ ready: false, aborted: false, elapsedMs: 0 });
    await expect(running).rejects.toThrow("event loop readiness timeout");
  });

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
    ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
  ])("closes MCP clients before exiting on terminal reconnect pause %s", async (detailCode) => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode,
      });
      await vi.waitFor(() => {
        expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledWith(1);
      });
      expect(mocks.capturedGatewayClients[0]?.stop).toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  it("keeps pairing reconnect pauses visible without stopping the foreground host", async () => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    mocks.closeMcpManager.mockClear();
    mocks.capturedGatewayClients[0]?.stop.mockClear();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      });

      expect(stderr).toHaveBeenCalledWith(
        "node host gateway reconnect paused after close (1008): connect failed detail=PAIRING_REQUIRED; waiting for operator action\n",
      );
      expect(mocks.closeMcpManager).not.toHaveBeenCalled();
      expect(mocks.capturedGatewayClients[0]?.stop).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });

  it("appends context path to the Gateway WebSocket URL", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws");
  });

  it("preserves trailing slash in context path as-is", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws/",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws/");
  });

  it("prepends leading slash when context path is missing one", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789/gws");
  });

  it("omits context path when empty or undefined", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789");
  });

  it("configures the SQLite gateway snapshot with contextPath", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastConfigured =
      mocks.capturedConfiguredGatewayConfigs[mocks.capturedConfiguredGatewayConfigs.length - 1];
    expect(lastConfigured?.contextPath).toBe("/gws");
  });

  it("clears configured contextPath when opts do not pass one (retarget scenario)", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "192.168.1.1",
        gatewayPort: 9999,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastConfigured =
      mocks.capturedConfiguredGatewayConfigs[mocks.capturedConfiguredGatewayConfigs.length - 1];
    expect(lastConfigured?.contextPath).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://192.168.1.1:9999");
  });

  it("clears configured contextPath when explicitly passed as empty string", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastConfigured =
      mocks.capturedConfiguredGatewayConfigs[mocks.capturedConfiguredGatewayConfigs.length - 1];
    expect(lastConfigured?.contextPath || undefined).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789");
  });
});
