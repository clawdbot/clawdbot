import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

const callGatewayTool = vi.hoisted(() => vi.fn());
let nodes: Array<Record<string, unknown>>;

vi.mock("../agents/tools/gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/tools/gateway.js")>();
  return { ...actual, callGatewayTool };
});

beforeEach(() => {
  callGatewayTool.mockReset();
  callGatewayTool.mockImplementation(async (method: string) => {
    if (method !== "node.list") {
      throw new Error(`unexpected Gateway method: ${method}`);
    }
    return { nodes };
  });
  nodes = [computerNode("headless-windows-node", ["screenshot", "list_windows"])];
});

function computerNode(nodeId: string, actions: string[]) {
  return {
    nodeId,
    displayName: nodeId === "headless-windows-node" ? "E6540" : "Windows Companion",
    platform: "win32",
    connected: true,
    commands: ["screen.snapshot", "computer.act"],
    computerUse: {
      contractVersion: 2,
      provider: {
        id: "cua-driver",
        label: "CUA Driver",
        generation: `${nodeId}-generation`,
      },
      actions,
      targets: ["screen", "window"],
      deliveryModes: ["foreground"],
      observations: ["image", "accessibility"],
      features: { recording: false, agentCursor: false, multiDisplay: false },
    },
  };
}

function readComputerActions(
  resolved: Awaited<ReturnType<McpLoopbackToolCache["resolve"]>>,
): string[] | undefined {
  const computer = resolved.toolSchema.find((tool) => tool.name === "computer");
  expect(computer).toBeDefined();
  return (computer?.inputSchema.properties as { action?: { enum?: string[] } } | undefined)?.action
    ?.enum;
}

describe("MCP loopback Computer Use schema", () => {
  it("does not query node inventory when the grant excludes computer", async () => {
    const resolved = await new McpLoopbackToolCache().resolve({
      cfg: {} as OpenClawConfig,
      context: {
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
        toolsAllow: ["memory_search"],
      },
    });

    expect(resolved.toolSchema.some((tool) => tool.name === "computer")).toBe(false);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("serializes paired-node v2 actions before the first tool execution", async () => {
    const cache = new McpLoopbackToolCache();
    const resolved = await cache.resolve({
      cfg: { tools: { allow: ["computer"] } } as OpenClawConfig,
      context: {
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
      },
    });

    const actions = readComputerActions(resolved);
    expect(actions).toContain("list_windows");
    expect(actions).not.toContain("launch_app");
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.list",
      {},
      {},
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("unions approved actions across distinct paired node identities", async () => {
    const cache = new McpLoopbackToolCache();
    const scope = {
      cfg: { tools: { allow: ["computer"] } } as OpenClawConfig,
      context: {
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        modelHasVision: true,
      },
    };
    expect(readComputerActions(await cache.resolve(scope))).not.toContain("launch_app");

    nodes = [
      computerNode("headless-windows-node", ["screenshot", "list_windows"]),
      computerNode("windows-companion-node", ["screenshot", "launch_app"]),
    ];
    const resolved = await cache.resolve(scope);

    expect(readComputerActions(resolved)).toEqual(
      expect.arrayContaining(["screenshot", "list_windows", "launch_app", "wait"]),
    );
    expect(callGatewayTool).toHaveBeenCalledTimes(2);
  });
});
