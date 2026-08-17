import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  listConnectedNodePluginTools: vi.fn<
    () => Array<{ nodeId: string; descriptor: { name: string; command?: string } }>
  >(() => []),
  resolveAgentNodeId: vi.fn(async () => "node-1"),
}));

vi.mock("./gateway.js", () => ({ callGatewayTool: mocks.callGatewayTool }));
vi.mock("./nodes-utils.js", () => ({ resolveAgentNodeId: mocks.resolveAgentNodeId }));
vi.mock("../../gateway/node-plugin-tool-snapshot.js", () => ({
  listConnectedNodePluginTools: mocks.listConnectedNodePluginTools,
}));

const { executeNodeCommandAction } = await import("./nodes-tool-commands.js");

async function execute(action: "device_status" | "invoke", input: Record<string, unknown>) {
  return executeNodeCommandAction({
    action,
    input: { node: "macbook", ...input },
    gatewayOpts: {},
    mediaInvokeActions: {},
  });
}

async function invoke(command: string) {
  return execute("invoke", { invokeCommand: command, invokeParamsJson: "{}" });
}

describe("generic node invoke policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listConnectedNodePluginTools.mockReturnValue([]);
  });

  it.each([
    {
      name: "node-hosted MCP",
      command: "mcp.tools.call.v1",
      descriptors: [],
      expectedTool: "node-hosted MCP",
    },
    {
      name: "node-published plugin tool",
      command: "remote.secret",
      descriptors: [
        { nodeId: "node-1", descriptor: { name: "remote_secret", command: "remote.secret" } },
      ],
      expectedTool: "remote_secret",
    },
  ])("blocks raw $name commands in favor of policy-filtered tools", async (testCase) => {
    mocks.listConnectedNodePluginTools.mockReturnValue(testCase.descriptors);

    await expect(invoke(testCase.command)).rejects.toThrow(
      `use the dedicated ${testCase.expectedTool} tool`,
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("allows ordinary generic commands when another node publishes the same command", async () => {
    mocks.listConnectedNodePluginTools.mockReturnValue([
      { nodeId: "node-2", descriptor: { name: "remote_status", command: "device.status" } },
    ]);
    mocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });

    await invoke("device.status");

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({ nodeId: "node-1", command: "device.status" }),
    );
  });

  it("blocks a typed action when the selected node publishes its command as an agent tool", async () => {
    mocks.listConnectedNodePluginTools.mockReturnValue([
      { nodeId: "node-1", descriptor: { name: "remote_status", command: "device.status" } },
    ]);

    await expect(execute("device_status", {})).rejects.toThrow(
      "use the dedicated remote_status tool",
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("allows a typed action when only another node publishes its command", async () => {
    mocks.listConnectedNodePluginTools.mockReturnValue([
      { nodeId: "node-2", descriptor: { name: "remote_status", command: "device.status" } },
    ]);
    mocks.callGatewayTool.mockResolvedValue({ payload: { ok: true } });

    await execute("device_status", {});

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      {},
      expect.objectContaining({ nodeId: "node-1", command: "device.status" }),
    );
  });
});
