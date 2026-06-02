import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { NodePairingPairedNode, NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";

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

function makePendingPairingRequest(requestId: string) {
  return vi.fn(async (input: NodePairingRequestInput) => ({
    status: "pending" as const,
    request: { ...input, requestId, ts: 1 },
    created: true,
  }));
}

function expectNodePairingRequest(
  requestPairing: ReturnType<typeof makePendingPairingRequest>,
  expected: Partial<NodePairingRequestInput>,
) {
  expect(requestPairing).toHaveBeenCalledWith({
    nodeId: "openclaw-ios",
    clientId: undefined,
    clientMode: undefined,
    displayName: undefined,
    platform: "ios",
    version: "test",
    deviceFamily: undefined,
    modelIdentifier: undefined,
    caps: [],
    commands: [],
    permissions: undefined,
    remoteIp: undefined,
    ...expected,
  });
}

describe("reconcileNodePairingOnConnect", () => {
  it("includes declared permissions in pending node pairing requests", async () => {
    const requestPairing = makePendingPairingRequest("req-1");

    await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: null,
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      permissions: { camera: true, notifications: false },
    });
  });

  it("keeps first-time pending node surfaces declared but not effective", async () => {
    const requestPairing = makePendingPairingRequest("req-pending");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "test",
          platform: "macos",
          deviceFamily: "Mac",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        caps: ["talk"],
        commands: ["system.run"],
        permissions: { camera: true },
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(result.declaredCaps).toEqual(["talk"]);
    expect(result.effectiveCaps).toEqual([]);
    expect(result.declaredCommands).toEqual(["system.run"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredPermissions).toEqual({ camera: true });
    expect(result.effectivePermissions).toBeUndefined();
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        caps: ["talk"],
        commands: ["system.run"],
        permissions: { camera: true },
      }),
    );
  });

  it.each([
    ["conflicts with device family", { deviceFamily: "iPhone" }],
    ["omits device family", {}],
  ])("filters host commands when canonical platform %s", async (_label, clientExtra) => {
    const requestPairing = makePendingPairingRequest("req-mismatch");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        client: {
          id: "openclaw-ios",
          version: "test",
          platform: "macos",
          mode: "node",
          ...clientExtra,
        },
        commands: ["system.run", "system.which"],
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(result.declaredCommands).toEqual([]);
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: [],
      }),
    );
  });

  it("requires a fresh pairing request when paired node capabilities change", async () => {
    const requestPairing = makePendingPairingRequest("req-caps");

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

    expectNodePairingRequest(requestPairing, {
      caps: ["camera", "screen"],
      commands: [],
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredCaps).toEqual(["camera", "screen"]);
    expect(result.pendingPairing?.request.requestId).toBe("req-caps");
  });

  it("requires a fresh pairing request when paired node permissions change", async () => {
    const requestPairing = makePendingPairingRequest("req-permissions");

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

    expectNodePairingRequest(requestPairing, {
      commands: [],
      permissions: { camera: true, notifications: false },
    });
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-permissions");
  });

  it("applies declared capability and permission downgrades to the live surface", async () => {
    const requestPairing = makePendingPairingRequest("req-downgrade");

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

    expectNodePairingRequest(requestPairing, {
      caps: ["camera"],
      commands: [],
      permissions: { camera: false },
    });
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-downgrade");
  });
});
