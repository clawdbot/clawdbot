/**
 * Node connect reconciliation tests.
 */
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

  it("reapproves and then preserves Windows exec approval commands", async () => {
    const commands = [
      "system.run.prepare",
      "system.run",
      "system.which",
      "system.execApprovals.get",
      "system.execApprovals.set",
    ];
    const previouslyApprovedCommands = ["system.run.prepare", "system.run", "system.which"];
    const connectParams = makeNodeConnectParams({
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "windows",
        deviceFamily: "Windows",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
      caps: ["system"],
      commands,
    });
    const requestPairing = makePendingPairingRequest("req-windows");

    const upgrade = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams,
      pairedNode: makePairedNode({ caps: ["system"], commands: previouslyApprovedCommands }),
      requestPairing,
    });

    expect(upgrade.declaredCommands).toEqual(commands);
    expect(upgrade.effectiveCommands).toEqual(previouslyApprovedCommands);
    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        commands,
      }),
    );

    const approvedPairingRequest = vi.fn();
    const approvedReconnect = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams,
      pairedNode: makePairedNode({ caps: ["system"], commands }),
      requestPairing: approvedPairingRequest,
    });

    expect(approvedReconnect.effectiveCommands).toEqual(commands);
    expect(approvedPairingRequest).not.toHaveBeenCalled();
  });

  it("keeps an approved computer.act surface effective without re-pairing while unarmed", async () => {
    const connectParams = makeNodeConnectParams({
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "macos",
        deviceFamily: "Mac",
        mode: GATEWAY_CLIENT_MODES.NODE,
      },
      caps: ["screen", "computer"],
      commands: ["screen.snapshot", "computer.act"],
    });
    const requestPairing = vi.fn();

    // No allowCommands entry (unarmed): the previously approved dangerous
    // surface must reconcile cleanly instead of demanding a pairing upgrade
    // on every reconnect.
    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams,
      pairedNode: makePairedNode({
        caps: ["screen", "computer"],
        commands: ["screen.snapshot", "computer.act"],
      }),
      requestPairing,
    });

    expect(requestPairing).not.toHaveBeenCalled();
    expect(result.declaredCommands).toEqual(["screen.snapshot", "computer.act"]);
    expect(result.effectiveCommands).toEqual(["screen.snapshot", "computer.act"]);
    expect(result.shouldClearPendingPairings).toBe(true);
  });

  it("requests pairing when a macOS node first declares computer.act", async () => {
    const requestPairing = makePendingPairingRequest("req-computer");

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
        caps: ["screen", "computer"],
        commands: ["screen.snapshot", "computer.act"],
      }),
      pairedNode: makePairedNode({
        caps: ["screen"],
        commands: ["screen.snapshot"],
      }),
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        caps: ["screen", "computer"],
        commands: ["screen.snapshot", "computer.act"],
      }),
    );
    expect(result.effectiveCommands).toEqual(["screen.snapshot"]);
    expect(result.pendingPairing?.request.requestId).toBe("req-computer");
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

  it("keeps the approved surface when paired-node reapproval is throttled", async () => {
    const requestPairing = vi.fn(async () => null);

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

    expect(requestPairing).toHaveBeenCalledOnce();
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.declaredCaps).toEqual(["camera", "screen"]);
    expect(result.pendingPairing).toBeUndefined();
    expect(result.shouldClearPendingPairings).toBeUndefined();
  });

  it("defers stale pending reapproval cleanup when the node returns to its approved surface", async () => {
    const requestPairing = makePendingPairingRequest("req-unused");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        caps: ["camera"],
        commands: ["canvas.snapshot"],
      }),
      pairedNode: makePairedNode({
        caps: ["camera"],
        commands: ["canvas.snapshot"],
      }),
      requestPairing,
    });

    expect(requestPairing).not.toHaveBeenCalled();
    expect(result.shouldClearPendingPairings).toBe(true);
  });

  it("requires a fresh pairing request when paired node permissions widen", async () => {
    const requestPairing = makePendingPairingRequest("req-permissions");

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        commands: [],
        permissions: { camera: true, notifications: true },
      }),
      pairedNode: makePairedNode({
        commands: [],
        permissions: { camera: true, notifications: false },
      }),
      requestPairing,
    });

    expectNodePairingRequest(requestPairing, {
      commands: [],
      permissions: { camera: true, notifications: true },
    });
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: true, notifications: false });
    expect(result.pendingPairing?.request.requestId).toBe("req-permissions");
  });

  it("accepts false-only permission metadata without reapproval", async () => {
    const requestPairing = vi.fn();

    const result = await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        commands: [],
        permissions: { camera: true, notifications: false, watchReachable: false },
      }),
      pairedNode: makePairedNode({
        commands: [],
        permissions: { camera: true },
      }),
      requestPairing,
    });

    expect(requestPairing).not.toHaveBeenCalled();
    expect(result.effectivePermissions).toEqual({
      camera: true,
      notifications: false,
      watchReachable: false,
    });
    expect(result.shouldClearPendingPairings).toBe(true);
  });

  it("applies declared capability and permission downgrades without reapproval", async () => {
    const requestPairing = vi.fn();

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

    expect(requestPairing).not.toHaveBeenCalled();
    expect(result.effectiveCaps).toEqual(["camera"]);
    expect(result.effectiveCommands).toEqual([]);
    expect(result.effectivePermissions).toEqual({ camera: false });
    expect(result.pendingPairing).toBeUndefined();
    expect(result.shouldClearPendingPairings).toBe(true);
  });
});
