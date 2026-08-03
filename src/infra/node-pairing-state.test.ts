import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "./device-pairing.js";
import {
  captureAuthenticatedNodePairingState,
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "./node-pairing-state.js";

const mocks = vi.hoisted(() => ({
  getPairedDevice: vi.fn(),
}));

vi.mock("./device-pairing.js", async () => {
  const actual = await vi.importActual<typeof import("./device-pairing.js")>("./device-pairing.js");
  return { ...actual, getPairedDevice: mocks.getPairedDevice };
});

function pairedNode(overrides: Partial<PairedDevice> = {}): PairedDevice {
  return {
    deviceId: "node-1",
    publicKey: "public-key-1",
    role: "node",
    roles: ["node", "operator"],
    tokens: {
      node: {
        token: "node-token-1",
        role: "node",
        scopes: [],
        createdAtMs: 150,
      },
      operator: {
        token: "operator-token-1",
        role: "operator",
        scopes: ["operator.pairing"],
        createdAtMs: 151,
      },
    },
    createdAtMs: 100,
    approvedAtMs: 200,
    nodeSurface: {
      createdAtMs: 300,
      approvedAtMs: 400,
    },
    ...overrides,
  };
}

describe("node pairing generation", () => {
  beforeEach(() => {
    mocks.getPairedDevice.mockReset();
  });

  it("binds work to node-role token and node-surface approval identity", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    const generation = await captureNodePairingGeneration(original.deviceId);

    expect(generation).toEqual({
      nodeId: "node-1",
      key: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({
        tokens: {
          ...original.tokens,
          node: { ...original.tokens!.node!, token: "node-token-2", rotatedAtMs: 500 },
        },
      }),
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(false);
  });

  it("binds connected sessions to the public key and node token used at authentication", async () => {
    const original = pairedNode();
    mocks.getPairedDevice
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce({ ...original, publicKey: "replacement-public-key" })
      .mockResolvedValueOnce(
        pairedNode({
          tokens: {
            ...original.tokens,
            node: { ...original.tokens!.node!, token: "replacement-node-token" },
          },
        }),
      );

    await expect(
      captureAuthenticatedNodePairingState({
        nodeId: original.deviceId,
        publicKey: original.publicKey,
        token: original.tokens!.node!.token,
      }),
    ).resolves.toMatchObject({ generation: { nodeId: original.deviceId } });
    await expect(
      captureAuthenticatedNodePairingState({
        nodeId: original.deviceId,
        publicKey: original.publicKey,
        token: original.tokens!.node!.token,
      }),
    ).resolves.toBeNull();
    await expect(
      captureAuthenticatedNodePairingState({
        nodeId: original.deviceId,
        publicKey: original.publicKey,
        token: original.tokens!.node!.token,
      }),
    ).resolves.toBeNull();
  });

  it("keeps authenticated pairing identity while first surface approval is pending", async () => {
    const original = pairedNode({ nodeSurface: undefined });
    mocks.getPairedDevice.mockResolvedValueOnce(original);

    await expect(
      captureAuthenticatedNodePairingState({
        nodeId: original.deviceId,
        publicKey: original.publicKey,
        token: original.tokens!.node!.token,
      }),
    ).resolves.toEqual({
      identity: {
        nodeId: original.deviceId,
        key: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
      generation: null,
    });
  });

  it("keeps pairing identity stable when the pending surface is approved", async () => {
    const pending = pairedNode({ nodeSurface: undefined });
    const approved = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(pending).mockResolvedValueOnce(approved);

    const params = {
      nodeId: pending.deviceId,
      publicKey: pending.publicKey,
      token: pending.tokens!.node!.token,
    };
    const pendingState = await captureAuthenticatedNodePairingState(params);
    const approvedState = await captureAuthenticatedNodePairingState(params);

    expect(pendingState?.generation).toBeNull();
    expect(approvedState?.generation).not.toBeNull();
    expect(approvedState?.identity.key).toBe(pendingState?.identity.key);
  });

  it("keeps node work current across unrelated operator approval", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);
    const generation = await captureNodePairingGeneration(original.deviceId);

    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({
        approvedAtMs: 201,
        tokens: {
          ...original.tokens,
          operator: {
            ...original.tokens!.operator!,
            token: "operator-token-2",
            rotatedAtMs: 501,
          },
        },
      }),
    );

    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(true);
  });

  it("invalidates node work when the node surface is reapproved", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);
    const generation = await captureNodePairingGeneration(original.deviceId);

    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({ nodeSurface: { createdAtMs: 300, approvedAtMs: 401 } }),
    );
    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(false);
  });

  it("invalidates node work when its effective node token is revoked", async () => {
    const original = pairedNode();
    mocks.getPairedDevice.mockResolvedValueOnce(original);
    const generation = await captureNodePairingGeneration(original.deviceId);

    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({
        tokens: {
          ...original.tokens,
          node: { ...original.tokens!.node!, revokedAtMs: 501 },
        },
      }),
    );

    await expect(isNodePairingGenerationCurrent(generation!)).resolves.toBe(false);
  });

  it("rejects admission without an active node token or approved node surface", async () => {
    const original = pairedNode();
    mocks.getPairedDevice
      .mockResolvedValueOnce(pairedNode({ tokens: undefined }))
      .mockResolvedValueOnce(
        pairedNode({
          tokens: {
            ...original.tokens,
            node: { ...original.tokens!.node!, revokedAtMs: 501 },
          },
        }),
      )
      .mockResolvedValueOnce(pairedNode({ nodeSurface: undefined }));

    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  });

  it("rejects admission without a durable approved node role", async () => {
    mocks.getPairedDevice.mockResolvedValueOnce(
      pairedNode({ role: "operator", roles: ["operator"] }),
    );

    await expect(captureNodePairingGeneration("node-1")).resolves.toBeNull();
  });
});
