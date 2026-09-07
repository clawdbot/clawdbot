/** Tests node-host capability discovery and inventory publication. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../infra/node-runner-inventory.js";
import type { NodeHostMcpManager } from "./mcp.js";
import {
  lastCapturedOptions,
  mocks,
  resetRunnerTestState,
  runNodeHost,
  startNodeHostMcpManager,
} from "./runner.test-support.js";

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";

describe("runNodeHost", () => {
  beforeEach(resetRunnerTestState);

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
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
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

    const negotiatedWorkerHost = {
      enabled: true,
      capacity: { total: 2, available: 2 },
      bundlePrewarm: 1,
      bundleRetention: 1,
      bundleStatus: 1,
      portalStream: 1,
      environmentSession: 1,
    };
    options?.onHelloOk?.({
      protocol: 4,
      features: {
        methods: [],
        events: [],
        capabilities: [
          GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_RETENTION,
          GATEWAY_SERVER_CAPS.NODE_WORKER_BUNDLE_STATUS,
          GATEWAY_SERVER_CAPS.NODE_WORKER_PORTAL_STREAM,
          GATEWAY_SERVER_CAPS.NODE_WORKER_ENVIRONMENT_SESSION,
        ],
      },
    } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
    await vi.waitFor(() => {
      expect(client?.request).toHaveBeenCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: negotiatedWorkerHost,
      });
    });

    const expectPublishedSlots = async (available: number) => {
      mocks.runnerCapacityChanged?.({ total: 2, available });
      await vi.waitFor(() => {
        expect(client?.request).toHaveBeenLastCalledWith(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: {
            ...negotiatedWorkerHost,
            capacity: { total: 2, available },
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
});
