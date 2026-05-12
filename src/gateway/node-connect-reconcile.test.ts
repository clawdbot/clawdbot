import { describe, expect, it, vi } from "vitest";
import type { NodePairingPairedNode, NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";
import type { ConnectParams } from "./protocol/index.js";

function makeNodeConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "openclaw-ios",
      version: "test",
      platform: "ios",
      mode: "node",
    },
    commands: ["canvas.snapshot"],
    ...overrides,
  };
}

function makePairedNode(overrides?: Partial<NodePairingPairedNode>): NodePairingPairedNode {
  return {
    nodeId: "openclaw-ios",
    token: "token-1",
    createdAtMs: 1,
    approvedAtMs: 1,
    ...overrides,
  };
}

describe("reconcileNodePairingOnConnect", () => {
  it("includes declared permissions in pending node pairing requests", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: { ...input, requestId: "req-1", ts: 1 },
      created: true,
    }));

    await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith({
      nodeId: "openclaw-ios",
      displayName: undefined,
      platform: "ios",
      version: "test",
      deviceFamily: undefined,
      modelIdentifier: undefined,
      caps: [],
      commands: [],
      permissions: { camera: true, notifications: false },
      remoteIp: undefined,
    });
  });

  it("requires a fresh pairing request when paired node capabilities change", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: { ...input, requestId: "req-caps", ts: 1 },
      created: true,
    }));

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera", "screen"],
        commands: [],
      }),
      pairedNode: makePairedNode({
        caps: ["camera"],
        commands: [],
      }),
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith({
      nodeId: "openclaw-ios",
      displayName: undefined,
      platform: "ios",
      version: "test",
      deviceFamily: undefined,
      modelIdentifier: undefined,
      caps: ["camera", "screen"],
      commands: [],
      permissions: undefined,
      remoteIp: undefined,
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.pendingPairing?.request.requestId).toBe("req-caps");
  });

  it("requires a fresh pairing request when paired node permissions change", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: { ...input, requestId: "req-permissions", ts: 1 },
      created: true,
    }));

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        commands: [],
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: makePairedNode({
        commands: [],
        permissions: { camera: true },
      }),
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith({
      nodeId: "openclaw-ios",
      displayName: undefined,
      platform: "ios",
      version: "test",
      deviceFamily: undefined,
      modelIdentifier: undefined,
      caps: [],
      commands: [],
      permissions: { camera: true, notifications: false },
      remoteIp: undefined,
    });
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-permissions");
  });

  it("applies declared capability and permission downgrades to the live surface", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: { ...input, requestId: "req-downgrade", ts: 1 },
      created: true,
    }));

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera"],
        commands: [],
        permissions: { camera: false },
      }),
      pairedNode: makePairedNode({
        caps: ["camera", "screen"],
        commands: [],
        permissions: { camera: true, notifications: true },
      }),
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith({
      nodeId: "openclaw-ios",
      displayName: undefined,
      platform: "ios",
      version: "test",
      deviceFamily: undefined,
      modelIdentifier: undefined,
      caps: ["camera"],
      commands: [],
      permissions: { camera: false },
      remoteIp: undefined,
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-downgrade");
  });
});
