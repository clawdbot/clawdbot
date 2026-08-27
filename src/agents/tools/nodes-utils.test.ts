// Node utility tests cover node selection defaults and gateway fallback between
// current and legacy node list methods.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";

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
  it("keeps compact display-name matching opt-in", () => {
    const nodes = [node({ nodeId: "mac-1", displayName: "Mac Studio" })];

    expect(() => resolveNodeIdFromList(nodes, "MacStudio")).toThrow(/unknown node: MacStudio/);
    expect(
      resolveNodeIdFromList(nodes, "MacStudio", false, { allowCompactDisplayName: true }),
    ).toBe("mac-1");
  });

  it("falls back to most recently connected node when multiple non-Mac candidates exist", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios", connectedAtMs: 1, lastSeenAtMs: 5000 }),
      node({ nodeId: "android-1", platform: "android", connectedAtMs: 2, lastSeenAtMs: 1000 }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("android-1");
  });

  it("ignores offline recency when any eligible node is connected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "offline-phone",
        platform: "ios",
        connected: false,
        lastSeenAtMs: 5000,
      }),
      node({
        nodeId: "connected-desktop",
        platform: "android",
        connected: true,
        connectedAtMs: 1000,
        lastSeenAtMs: 1000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("connected-desktop");
  });

  it("preserves local Mac preference when exactly one local Mac candidate exists", () => {
    const nodes: NodeListNode[] = [
      node({ nodeId: "ios-1", platform: "ios", lastSeenAtMs: 5000 }),
      node({ nodeId: "mac-1", platform: "macos", lastSeenAtMs: 1000 }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("mac-1");
  });

  it("prefers most recently seen node when all candidates are disconnected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "abc123-desktop",
        platform: "macos",
        connected: false,
        connectedAtMs: 9000,
        lastSeenAtMs: 1000,
      }),
      node({
        nodeId: "def456-phone",
        platform: "ios",
        connected: false,
        connectedAtMs: 1000,
        lastSeenAtMs: 5000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("def456-phone");
  });

  it("prefers node with lastSeenAtMs over node without when all disconnected", () => {
    const nodes: NodeListNode[] = [
      node({
        nodeId: "abc-no-seen",
        platform: "ios",
        connected: false,
        connectedAtMs: 9000,
      }),
      node({
        nodeId: "def-has-seen",
        platform: "android",
        connected: false,
        connectedAtMs: 1000,
        lastSeenAtMs: 3000,
      }),
    ];

    expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("def-has-seen");
  });

  it.each([undefined, 3000])(
    "uses stable nodeId ordering when disconnected-node lastSeenAtMs ties at %s",
    (lastSeenAtMs) => {
      // Deterministic tie-breaking keeps repeated wake attempts on one target.
      const nodes: NodeListNode[] = [
        node({
          nodeId: "z-node",
          platform: "ios",
          connected: false,
          connectedAtMs: 9000,
          lastSeenAtMs,
        }),
        node({
          nodeId: "a-node",
          platform: "android",
          connected: false,
          connectedAtMs: 1000,
          lastSeenAtMs,
        }),
      ];

      expect(resolveNodeIdFromList(nodes, undefined, true)).toBe("a-node");
    },
  );
});

describe("listNodes", () => {
  it("falls back to node.pair.list only when node.list is unavailable", async () => {
    // Old gateways only expose node.pair.list; newer authorization failures
    // must still surface instead of being hidden by fallback.
    gatewayMocks.callGatewayTool
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: node.list",
        }),
      )
      .mockResolvedValueOnce({
        pending: [],
        paired: [{ nodeId: "pair-1", displayName: "Pair 1", platform: "ios", remoteIp: "1.2.3.4" }],
      });

    const signal = new AbortController().signal;
    await expect(listNodes({}, signal)).resolves.toEqual([
      {
        nodeId: "pair-1",
        displayName: "Pair 1",
        platform: "ios",
        remoteIp: "1.2.3.4",
      },
    ]);
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      1,
      "node.list",
      {},
      {},
      { signal },
    );
    expect(gatewayMocks.callGatewayTool).toHaveBeenNthCalledWith(
      2,
      "node.pair.list",
      {},
      {},
      {
        signal,
      },
    );
  });

  it.each([
    {
      label: "a local request timeout",
      error: new GatewayProtocolRequestTimeoutError({
        method: "node.list",
        timeoutMs: 80,
        requestSent: true,
      }),
    },
    {
      label: "an authorization rejection",
      error: new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "unknown method: node.list",
      }),
    },
    {
      label: "an INVALID_REQUEST authentication failure",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unauthorized",
      }),
    },
    {
      label: "a retryable unknown-method rejection",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list",
        retryable: true,
      }),
    },
    {
      label: "an unknown-method rejection for another method",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list.extra",
      }),
    },
    {
      label: "malformed request retry metadata",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list",
        retryAfterMs: -1,
      }),
    },
    {
      label: "an unsupported-method prose error",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "node.list is not implemented",
      }),
    },
    {
      label: "a network connection error",
      error: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), {
        code: "ECONNREFUSED",
      }),
    },
    {
      label: "a closed Gateway transport",
      error: new Error("gateway closed (1008): unauthorized"),
    },
    {
      label: "a malformed request-error lookalike",
      error: Object.assign(new Error("unknown method: node.list"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    },
    {
      label: "a plain unknown-method error",
      error: new Error("unknown method: node.list"),
    },
  ])("rethrows $label without consulting paired nodes", async ({ error }) => {
    gatewayMocks.callGatewayTool.mockRejectedValueOnce(error).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
    });

    const signal = new AbortController().signal;
    await expect(listNodes({}, signal)).rejects.toBe(error);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledTimes(1);
    expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith("node.list", {}, {}, { signal });
  });
});
