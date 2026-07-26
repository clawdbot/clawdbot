/** Tests node-host runner command parsing, timeout, and plugin dispatch behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import type { configureNodeHost } from "./config.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import { runNodeHost } from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedConfiguredGatewayConfigs: [] as Array<{ contextPath?: string }>,
  capturedGatewayClients: [] as Array<{
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    updateNodeManifest: ReturnType<typeof vi.fn>;
  }>,
  mcpConfiguredServerCount: 0,
  mcpDescriptors: [] as Array<Record<string, unknown>>,
  nodeSkillDescriptors: [] as Array<Record<string, unknown>>,
  runtimeSteps: [] as string[],
  useFakeRuntime: false,
  nodeHostCommands: [] as string[],
  nodeHostCaps: [] as string[],
  availabilityOnWatch: undefined as { caps: string[]; commands: string[] } | undefined,
  availabilityChanged: undefined as (() => void) | undefined,
  normalizedPath: null as string | null,
  resolvedExecutables: new Map<string, string>(),
  closeMcpManager: vi.fn(async () => undefined),
  configureNodeHost: vi.fn(async (params: Parameters<typeof configureNodeHost>[0]) => {
    mocks.capturedConfiguredGatewayConfigs.push(params.gateway);
    return {
      version: 1 as const,
      nodeId: params.nodeId?.trim() || "node-test",
      displayName: params.displayName?.trim() || params.fallbackDisplayName,
      gateway: params.gateway,
    };
  }),
  getRuntimeConfig: vi.fn(() => ({
    gateway: {
      handshakeTimeoutMs: 1_000,
    },
  })),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: false,
    aborted: false,
    elapsedMs: 0,
  })),
  resolveGatewayConnectionAuth: vi.fn(async () => ({})),
  activeRuntime: {
    invoke: vi.fn(async () => {}),
    handleInput: vi.fn(),
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    close: vi.fn(async () => {}),
  },
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../gateway/client-start-readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mocks.startGatewayClientWhenEventLoopReady,
}));

vi.mock("../gateway/client.js", () => ({
  GatewayClient: function GatewayClient(opts: GatewayClientOptions) {
    const client = {
      request: vi.fn(async () => ({})),
      stop: vi.fn(),
      updateNodeManifest: vi.fn(),
    };
    mocks.capturedGatewayClientOptions.push(opts);
    mocks.capturedGatewayClients.push(client);
    return client;
  },
}));

vi.mock("../gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: mocks.resolveGatewayConnectionAuth,
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
      nodePluginTools: [
        {
          pluginId: "test-plugin",
          name: "remote_echo",
          description: "Echo from node host",
          command: "test.echo",
          parameters: { type: "object", properties: {} },
        },
      ],
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
  startNodeHostMcpManager: vi.fn(async () => ({
    configuredServerCount: mocks.mcpConfiguredServerCount,
    descriptors: mocks.mcpDescriptors,
    callMcpTool: vi.fn(),
    close: mocks.closeMcpManager,
  })),
}));

vi.mock("./skills.js", () => ({
  scanNodeHostedSkills: vi.fn(() => mocks.nodeSkillDescriptors),
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
        manifest: { caps: [], commands: [], pathEnv: process.env.PATH ?? "" },
        initialInventory: { skills: [], pluginTools: [] },
        start: () => mocks.activeRuntime,
      };
    },
  };
});

function lastCapturedOptions(): GatewayClientOptions | undefined {
  const list = mocks.capturedGatewayClientOptions;
  return list[list.length - 1];
}

describe("runNodeHost", () => {
  beforeEach(() => {
    mocks.capturedGatewayClientOptions.length = 0;
    mocks.capturedConfiguredGatewayConfigs.length = 0;
    mocks.capturedGatewayClients.length = 0;
    mocks.mcpConfiguredServerCount = 0;
    mocks.mcpDescriptors = [];
    mocks.nodeSkillDescriptors = [];
    mocks.runtimeSteps = [];
    mocks.useFakeRuntime = false;
    mocks.nodeHostCommands = [];
    mocks.nodeHostCaps = [];
    mocks.availabilityOnWatch = undefined;
    mocks.availabilityChanged = undefined;
    mocks.normalizedPath = null;
    mocks.resolvedExecutables.clear();
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
    });
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
        handshakeTimeoutMs: 1_000,
        remote: { token: "remote-token", password: "remote-password" },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    expect(mocks.resolveGatewayConnectionAuth).toHaveBeenCalledWith({
      config: {
        gateway: {
          mode: "local",
          handshakeTimeoutMs: 1_000,
          remote: { token: undefined, password: undefined },
        },
      },
      env: process.env,
      localTokenPrecedence: "env-first",
      localPasswordPrecedence: "env-first",
      remoteTokenPrecedence: "env-first",
      remotePasswordPrecedence: "env-first",
    });
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
      features: { methods: [], events: [] },
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
      features: { methods: [], events: [] },
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
      features: { methods: [], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);

    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalledWith(
      "node.skills.update",
      expect.anything(),
    );
  });

  it("declares and publishes configured node-host MCP tools", async () => {
    mocks.mcpConfiguredServerCount = 1;
    mocks.mcpDescriptors = [
      {
        pluginId: "node-mcp",
        name: "docs_search",
        description: "Search docs",
        command: "mcp.tools.call.v1",
        mcp: { server: "docs", tool: "search" },
      },
    ];

    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );

    const options = lastCapturedOptions();
    expect(options?.caps).toContain("mcp");
    expect(options?.commands).toContain("mcp.tools.call.v1");
    options?.onHelloOk?.({
      protocol: 1,
      features: { methods: [], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenCalledWith(
      "node.pluginTools.update",
      {
        tools: expect.arrayContaining([
          expect.objectContaining({ pluginId: "node-mcp", name: "docs_search" }),
        ]),
      },
    );
    expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
  });

  it("publishes plugin tools while MCP discovery is still pending", async () => {
    mocks.mcpConfiguredServerCount = 1;
    let resolveManager: ((manager: NodeHostMcpManager) => void) | undefined;
    vi.mocked(startNodeHostMcpManager).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveManager = resolve;
      }),
    );
    const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
    await vi.waitFor(() => expect(lastCapturedOptions()).toBeDefined());
    lastCapturedOptions()?.onHelloOk?.({
      protocol: 1,
      features: { methods: [], events: [] },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenCalledWith(
      "node.pluginTools.update",
      { tools: [expect.objectContaining({ pluginId: "test-plugin" })] },
    );

    resolveManager?.({
      configuredServerCount: 1,
      descriptors: [
        {
          pluginId: "node-mcp",
          name: "docs_search",
          description: "Search docs",
          command: "mcp.tools.call.v1",
          mcp: { server: "docs", tool: "search" },
        },
      ],
      callMcpTool: vi.fn(),
      close: mocks.closeMcpManager,
    });
    await expect(running).rejects.toThrow("event loop readiness timeout");
    expect(mocks.capturedGatewayClients[0]?.request).toHaveBeenLastCalledWith(
      "node.pluginTools.update",
      { tools: expect.arrayContaining([expect.objectContaining({ pluginId: "node-mcp" })]) },
    );
  });

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
  ])("closes MCP clients before exiting on terminal reconnect pause %s", async (detailCode) => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    mocks.closeMcpManager.mockClear();
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
