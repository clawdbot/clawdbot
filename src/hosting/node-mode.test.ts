import { describe, expect, it, vi } from "vitest";

const listNodePairing = vi.hoisted(() => vi.fn());

vi.mock("../infra/node-pairing.js", () => ({ listNodePairing }));

const { createNodeModeReadinessEvidenceResolver } = await import("./node-mode.js");
const resolveNodeModeReadinessEvidence = createNodeModeReadinessEvidenceResolver({
  listPairing: listNodePairing,
  cacheTtlMs: 0,
});

describe("resolveNodeModeReadinessEvidence", () => {
  it("keeps paired but disconnected nodes out of connected target evidence", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [],
    });

    expect(evidence).toMatchObject({
      pairing: { pairedCount: 1 },
      targets: { knownCount: 1, connectedCount: 0 },
      controlChannel: { connectedCount: 0 },
    });
  });

  it("uses live node sessions for target and control-channel evidence", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence).toMatchObject({
      targets: { knownCount: 1, connectedCount: 1 },
      controlChannel: { connectedCount: 1 },
    });
  });

  it("ignores a connected session from a retired pairing generation", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"], pairingGeneration: "generation-2" }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [
        {
          nodeId: "node-1",
          pairingGeneration: "generation-1",
          commands: ["system.run"],
        } as never,
      ],
    });

    expect(evidence.targets?.connectedCount).toBe(0);
    expect(evidence.controlChannel?.connectedCount).toBe(0);
    expect(evidence.commandApproval?.configured).toBe(false);
  });

  it("applies the canonical command deny policy to paired commands", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { commands: { deny: ["system.run"] } } } },
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence.commandApproval).toEqual({
      configured: false,
      approvedCommandCount: 0,
    });
  });

  it("applies the canonical command allow policy to live commands", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: [] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { commands: { allow: ["system.run"] } } } },
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence.commandApproval).toEqual({
      configured: true,
      approvedCommandCount: 1,
    });
  });

  it("does not treat a dangerous advertised command as approved by pairing alone", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["computer.act"] }],
      pending: [],
    });
    const connectedNode = {
      nodeId: "node-1",
      connId: "connection-1",
      platform: "macos",
      commands: ["computer.act"],
    } as never;

    const unarmed = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [connectedNode],
    });
    const armed = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { commands: { allow: ["computer.act"] } } } },
      connectedNodes: [connectedNode],
    });

    expect(unarmed.commandApproval).toEqual({ configured: false, approvedCommandCount: 0 });
    expect(armed.commandApproval).toEqual({ configured: true, approvedCommandCount: 1 });
  });

  it("correlates approved commands with the connected paired node", async () => {
    listNodePairing.mockResolvedValue({
      paired: [
        { nodeId: "node-1", commands: ["system.run"] },
        { nodeId: "node-2", commands: [] },
      ],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: {},
      connectedNodes: [{ nodeId: "node-2", commands: [] } as never],
    });

    expect(evidence.targets?.connectedCount).toBe(1);
    expect(evidence.commandApproval).toEqual({
      configured: false,
      approvedCommandCount: 0,
    });
  });

  it("coalesces pairing reads while reevaluating live sessions and config", async () => {
    let now = 1_000;
    const loadPairing = vi.fn().mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });
    const resolveEvidence = createNodeModeReadinessEvidenceResolver({
      listPairing: loadPairing,
      now: () => now,
      cacheTtlMs: 1_000,
    });

    const disconnected = await resolveEvidence({ config: {}, connectedNodes: [] });
    const connected = await resolveEvidence({
      config: { gateway: { nodes: { commands: { deny: ["system.run"] } } } },
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(loadPairing).toHaveBeenCalledTimes(1);
    expect(disconnected.targets?.connectedCount).toBe(0);
    expect(connected.targets?.connectedCount).toBe(1);
    expect(connected.commandApproval?.configured).toBe(false);

    now += 1_000;
    await resolveEvidence({ config: {}, connectedNodes: [] });
    expect(loadPairing).toHaveBeenCalledTimes(2);
  });

  it("returns timed-out pairing evidence when the pairing read never settles", async () => {
    let now = 0;
    const loadPairing = vi.fn(() => new Promise<never>(() => {}));
    const resolveEvidence = createNodeModeReadinessEvidenceResolver({
      listPairing: loadPairing,
      now: () => now,
      timeoutMs: 5,
      cacheTtlMs: 0,
    });

    await expect(resolveEvidence({ config: {}, connectedNodes: [] })).resolves.toMatchObject({
      pairing: {
        timedOut: true,
        error: "Node pairing readiness exceeded 5ms.",
      },
    });
    now = 10;
    await resolveEvidence({ config: {}, connectedNodes: [] });
    expect(loadPairing).toHaveBeenCalledTimes(1);
  });

  it("does not expose pairing store exception messages", async () => {
    const resolveEvidence = createNodeModeReadinessEvidenceResolver({
      listPairing: () => Promise.reject(new Error("failed with token=secret")),
    });

    await expect(resolveEvidence({ config: {}, connectedNodes: [] })).resolves.toMatchObject({
      pairing: {
        error: "Node pairing state is unavailable.",
      },
    });
  });
});
