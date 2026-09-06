import { describe, expect, it, vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createReclaimedPlacementRedispatch } from "./reclaimed-placement-redispatch.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

const placement = {
  state: "reclaimed",
  sessionId: "session-1",
  sessionKey: "agent:main:cloud-session",
  agentId: "main",
  environmentId: "worker:previous",
  executionMode: "worker-turn",
} as ReclaimedWorkerPlacement;

describe("createReclaimedPlacementRedispatch", () => {
  it("reuses the previous environment's exact profile snapshot for a fresh dispatch", async () => {
    const active = { state: "active" } as Extract<
      WorkerSessionPlacementRecord,
      { state: "active" }
    >;
    const dispatch = vi.fn(async () => active);
    const redispatch = createReclaimedPlacementRedispatch({
      environments: {
        get: () =>
          ({
            profileId: "development",
            providerId: "fake",
            profileSnapshot: { machineClass: "large", settings: { region: "parent" } },
          }) as never,
      },
      dispatch,
    });

    await expect(redispatch(placement)).resolves.toBe(active);
    expect(dispatch).toHaveBeenCalledWith({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      profileId: "development",
      executionMode: "worker-turn",
      inheritedProfile: {
        providerId: "fake",
        profileSnapshot: { machineClass: "large", settings: { region: "parent" } },
      },
    });
  });

  it("carries the exact paired node and owner-resolved requirement through redispatch", async () => {
    const requirement = { requiredNodeCommands: [], consumesWorkerSlot: true };
    const dispatch = vi.fn(async () => ({ state: "active" }) as never);
    const resolveDevicePlacementRequirement = vi.fn(async () => requirement);
    const redispatch = createReclaimedPlacementRedispatch({
      environments: {
        get: () =>
          ({
            profileId: "device:paired-node",
            providerId: "device",
            nodeDeviceId: "paired-node",
            profileSnapshot: { install: "bundle", settings: { device: "paired-node" } },
          }) as never,
      },
      dispatch,
      resolveDevicePlacementRequirement,
    });

    await redispatch(placement);

    expect(resolveDevicePlacementRequirement).toHaveBeenCalledWith({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      executionMode: "worker-turn",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "paired-node", devicePlacement: requirement }),
    );
  });

  it("revalidates a reclaimed cloud node without targeting its retired device", async () => {
    const remotePlacement = {
      ...placement,
      executionMode: "remote-exec" as const,
    } as ReclaimedWorkerPlacement;
    const requirement = {
      requiredNodeCommands: ["codex.exec-server.stdio.v1"],
      consumesWorkerSlot: false,
    };
    const dispatch = vi.fn(async () => ({ state: "active" }) as never);
    const resolveDevicePlacementRequirement = vi.fn(async () => requirement);
    const redispatch = createReclaimedPlacementRedispatch({
      environments: {
        get: () =>
          ({
            profileId: "cloud:development",
            providerId: "crabbox",
            nodeDeviceId: "retired-cloud-node",
            profileSnapshot: { machineClass: "large", settings: { region: "parent" } },
          }) as never,
      },
      dispatch,
      resolveDevicePlacementRequirement,
    });

    await redispatch(remotePlacement);

    expect(resolveDevicePlacementRequirement).toHaveBeenCalledWith({
      sessionId: remotePlacement.sessionId,
      sessionKey: remotePlacement.sessionKey,
      agentId: remotePlacement.agentId,
      executionMode: "remote-exec",
    });
    expect(dispatch).toHaveBeenCalledWith({
      sessionId: remotePlacement.sessionId,
      sessionKey: remotePlacement.sessionKey,
      agentId: remotePlacement.agentId,
      profileId: "cloud:development",
      executionMode: "remote-exec",
      devicePlacement: requirement,
      inheritedProfile: {
        providerId: "crabbox",
        profileSnapshot: { machineClass: "large", settings: { region: "parent" } },
      },
    });
  });

  it.each([
    { providerId: "device", executionMode: "worker-turn" },
    { providerId: "crabbox", executionMode: "remote-exec" },
  ] as const)(
    "rejects $providerId node redispatch without its runtime requirement owner",
    async ({ providerId, executionMode }) => {
      const dispatch = vi.fn();
      const redispatch = createReclaimedPlacementRedispatch({
        environments: {
          get: () =>
            ({
              profileId: "device:paired-node",
              providerId,
              nodeDeviceId: "paired-node",
              profileSnapshot: { install: "bundle", settings: { device: "paired-node" } },
            }) as never,
        },
        dispatch,
      });

      await expect(
        redispatch({ ...placement, executionMode } as ReclaimedWorkerPlacement),
      ).rejects.toThrow("authoritative runtime requirement");
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the prior environment record is unavailable", async () => {
    const redispatch = createReclaimedPlacementRedispatch({
      environments: { get: () => undefined },
      dispatch: vi.fn(),
    });

    await expect(redispatch(placement)).rejects.toThrow(
      "Reclaimed worker placement has no environment record: worker:previous",
    );
  });
});
