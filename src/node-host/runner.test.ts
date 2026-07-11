/** Tests node-host runner command parsing, timeout, and plugin dispatch behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import {
  resolveNodeHostGatewayDeviceFamily,
  resolveNodeHostGatewayPlatform,
  runNodeHost,
} from "./runner.js";

const mocks = vi.hoisted(() => ({
  capturedGatewayClientOptions: [] as GatewayClientOptions[],
  capturedSavedGatewayConfigs: [] as Array<{ contextPath?: string }>,
  capturedGatewayClients: [] as Array<{
    request: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  mcpConfiguredServerCount: 0,
  mcpDescriptors: [] as Array<Record<string, unknown>>,
  nodeSkillDescriptors: [] as Array<Record<string, unknown>>,
  closeMcpManager: vi.fn(async () => undefined),
  ensureNodeHostConfig: vi.fn(async () => ({
    version: 1,
    nodeId: "node-test",
  })),
  saveNodeHostConfig: vi.fn(async (cfg: { gateway?: { contextPath?: string } }) => {
    if (cfg?.gateway) {
      mocks.capturedSavedGatewayConfigs.push(cfg.gateway);
    }
    return undefined;
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
    };
    mocks.capturedGatewayClientOptions.push(opts);
    mocks.capturedGatewayClients.push(client);
    return client;
  },
}));

vi.mock("../gateway/connection-auth.js", () => ({
  resolveGatewayConnectionAuth: vi.fn(async () => ({})),
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

vi.mock("../infra/path-env.js", () => ({
  ensureOpenClawCliOnPath: vi.fn(),
}));

vi.mock("./config.js", () => ({
  ensureNodeHostConfig: mocks.ensureNodeHostConfig,
  saveNodeHostConfig: mocks.saveNodeHostConfig,
}));

vi.mock("./plugin-node-host.js", () => ({
  ensureNodeHostPluginRegistry: vi.fn(async () => undefined),
  listRegisteredNodeHostCapsAndCommands: vi.fn(() => ({
    caps: [],
    commands: [],
    nodePluginTools: [
      {
        pluginId: "test-plugin",
        name: "remote_echo",
        description: "Echo from node host",
        command: "test.echo",
        parameters: { type: "object", properties: {} },
      },
    ],
  })),
}));

vi.mock("./mcp.js", () => ({
  countConfiguredNodeHostMcpServers: vi.fn(() => mocks.mcpConfiguredServerCount),
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

function lastCapturedOptions(): GatewayClientOptions | undefined {
  const list = mocks.capturedGatewayClientOptions;
  return list[list.length - 1];
}

describe("runNodeHost", () => {
  beforeEach(() => {
    mocks.capturedGatewayClientOptions.length = 0;
    mocks.capturedGatewayClients.length = 0;
    mocks.mcpConfiguredServerCount = 0;
    mocks.mcpDescriptors = [];
    mocks.nodeSkillDescriptors = [];
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({
      gateway: { handshakeTimeoutMs: 1_000 },
    });
  });

  it("maps runtime platforms to gateway platform ids", () => {
    expect(resolveNodeHostGatewayPlatform("darwin")).toBe("macos");
    expect(resolveNodeHostGatewayPlatform("win32")).toBe("windows");
    expect(resolveNodeHostGatewayPlatform("linux")).toBe("linux");
    expect(resolveNodeHostGatewayPlatform("freebsd")).toBe("unknown");
    expect(resolveNodeHostGatewayDeviceFamily("darwin")).toBe("Mac");
    expect(resolveNodeHostGatewayDeviceFamily("win32")).toBe("Windows");
    expect(resolveNodeHostGatewayDeviceFamily("linux")).toBe("Linux");
    expect(resolveNodeHostGatewayDeviceFamily("freebsd")).toBeUndefined();
  });

  it("passes the resolved Gateway URL to the Gateway client", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    expect(mocks.capturedGatewayClientOptions).toHaveLength(1);
    expect(mocks.capturedGatewayClientOptions[0]?.url).toBe("ws://127.0.0.1:18789");
    expect(mocks.capturedGatewayClientOptions[0]?.platform).toBe(
      resolveNodeHostGatewayPlatform(process.platform),
    );
    expect(mocks.capturedGatewayClientOptions[0]?.deviceFamily).toBe(
      resolveNodeHostGatewayDeviceFamily(process.platform),
    );
    expect(mocks.capturedGatewayClients[0]?.request).not.toHaveBeenCalled();
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

  it("closes MCP clients before exiting on a terminal reconnect pause", async () => {
    await expect(runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 })).rejects.toThrow(
      "event loop readiness timeout",
    );
    mocks.closeMcpManager.mockClear();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      lastCapturedOptions()?.onReconnectPaused?.({
        code: 1008,
        reason: "connect failed",
        detailCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
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

  it("saves the gateway config with contextPath to node.json", async () => {
    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "/gws",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath).toBe("/gws");
  });

  it("clears saved contextPath when opts do not pass one (retarget scenario)", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: { contextPath: "/old-path" },
    } as any);

    await expect(
      runNodeHost({
        gatewayHost: "192.168.1.1",
        gatewayPort: 9999,
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://192.168.1.1:9999");
  });

  it("clears saved contextPath when explicitly passed as empty string", async () => {
    mocks.ensureNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-test",
      gateway: { contextPath: "/old-path" },
    } as any);

    await expect(
      runNodeHost({
        gatewayHost: "127.0.0.1",
        gatewayPort: 18789,
        gatewayContextPath: "",
      }),
    ).rejects.toThrow("event loop readiness timeout");

    const lastSaved =
      mocks.capturedSavedGatewayConfigs[mocks.capturedSavedGatewayConfigs.length - 1];
    expect(lastSaved?.contextPath || undefined).toBeUndefined();
    expect(lastCapturedOptions()?.url).toBe("ws://127.0.0.1:18789");
  });
});
