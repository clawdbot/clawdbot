import { describe, expect, it, vi } from "vitest";

const listNodePairing = vi.hoisted(() => vi.fn());

vi.mock("../infra/node-pairing.js", () => ({ listNodePairing }));

const { createNodeModeReadinessEvidenceResolver, resolveNodeModeReadinessEvidence } =
  await import("./node-mode.js");

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

  it("does not treat denyCommands as command approval posture", async () => {
    listNodePairing.mockResolvedValue({
      paired: [{ nodeId: "node-1", commands: ["system.run"] }],
      pending: [],
    });

    const evidence = await resolveNodeModeReadinessEvidence({
      config: { gateway: { nodes: { denyCommands: ["system.run"] } } },
      connectedNodes: [{ nodeId: "node-1", commands: ["system.run"] } as never],
    });

    expect(evidence.commandApproval).toEqual({
      configured: false,
      approvedCommandCount: 0,
    });
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
      config: { gateway: { nodes: { denyCommands: ["system.run"] } } },
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
    const resolveEvidence = createNodeModeReadinessEvidenceResolver({
      listPairing: () => new Promise(() => {}),
      timeoutMs: 5,
      cacheTtlMs: 0,
    });

    await expect(resolveEvidence({ config: {}, connectedNodes: [] })).resolves.toMatchObject({
      pairing: {
        timedOut: true,
        error: "Node pairing readiness exceeded 5ms.",
      },
    });
  });
});
