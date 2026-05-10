import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
}));
vi.mock("./gateway.js", () => ({
  callGatewayTool: (...args: unknown[]) => gatewayMocks.callGatewayTool(...args),
}));

import type { NodeListNode } from "./nodes-utils.js";
import { listNodes, resolveNodeIdFromList } from "./nodes-utils.js";

function node({ nodeId, ...overrides }: Partial<NodeListNode> & { nodeId: string }): NodeListNode {
  return {
    nodeId,
    caps: ["canvas"],
    connected: true,
    ...overrides,
  };
}

beforeEach(() => {
  gatewayMocks.callGatewayTool.mockReset();
});

describe("resolveNodeIdFromList defaults", () => {
  it("falls back to most recently connected node when multiple non-Mac candidates exist", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios", connectedAtMs: 1 }),
      node({ nodeId: "android-1", platform: "android", connectedAtMs: 2 }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("android-1");
  });

  it("preserves local Mac preference when exactly one local Mac candidate exists", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios" }),
      node({ nodeId: "mac-1", platform: "macos" }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("mac-1");
  });

  it("uses stable nodeId ordering when connectedAtMs is unavailable", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "z-node", platform: "ios", connectedAtMs: undefined }),
      node({ nodeId: "a-node", platform: "android", connectedAtMs: undefined }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("a-node");
  });
});

describe("listNodes", () => {
  it("falls back to node.pair.list only when node.list is unavailable", async () => {
    gatewayMocks.callGatewayTool
      .mockRejectedValueOnce(new Error("unknown method: node.list"))
      .mockResolvedValueOnce({
        pending: [],
        paired: [{ nodeId: "pair-1", displayName: "Pair 1", platform: "ios", remoteIp: "1.2.3.4" }],
      });

    await expect(listNodes({})).resolves.toEqual([
      {
        nodeId: "pair-1",
        displayName: "Pair 1",
        platform: "ios",
        remoteIp: "1.2.3.4",
      },
    ]);
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(1, "node.list", {}, {});
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(2, "node.pair.list", {}, {});
  });

  it("rethrows unexpected node.list failures without fallback", async () => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(
      new Error("gateway closed (1008): unauthorized"),
    );

    await expect(listNodes({})).rejects.toThrow("gateway closed (1008): unauthorized");
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith("node.list", {}, {});
  });
});
