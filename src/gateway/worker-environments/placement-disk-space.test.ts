import { describe, expect, it, vi } from "vitest";
import type { SpawnResult } from "../../process/exec.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { StaleWorkerBuildError } from "./admission.js";
import { createWorkerPlacementDiskSpaceMonitor } from "./placement-disk-space.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function activePlacement(
  overrides: Partial<Extract<WorkerSessionPlacementRecord, { state: "active" }>> = {},
): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    sessionId: "session-disk",
    sessionKey: "agent:main:session-disk",
    agentId: "main",
    state: "active",
    executionMode: "worker-turn",
    environmentId: "environment-disk",
    generation: 3,
    activeOwnerEpoch: 7,
    workspaceBaseManifestRef: "manifest-disk",
    remoteWorkspaceDir: "/workspace/session-disk",
    workerBundleHash: "a".repeat(64),
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    turnClaim: null,
    createdAtMs: 10,
    updatedAtMs: 20,
    stateChangedAtMs: 15,
    ...overrides,
  };
}

function result(availableBytes: number, totalBytes: number): SpawnResult {
  return {
    stdout: JSON.stringify({
      availableBytes: String(availableBytes),
      totalBytes: String(totalBytes),
    }),
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function createHarness(
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>,
) {
  let placement: WorkerSessionPlacementRecord = activePlacement();
  const startTunnel = vi.fn(async () => ({ runWorkspaceCommand }));
  const warn = vi.fn();
  const monitor = createWorkerPlacementDiskSpaceMonitor({
    placements: {
      get: () => placement,
      list: () => [placement],
    },
    environments: { startTunnel: startTunnel as never },
    warn,
    now: () => 1_000,
  });
  return {
    monitor,
    startTunnel,
    warn,
    get placement() {
      return placement;
    },
    setPlacement(next: WorkerSessionPlacementRecord) {
      placement = next;
    },
  };
}

describe("active worker placement disk-space monitoring", () => {
  it("samples an idle active placement and emits only projected status transitions", async () => {
    let availableBytes = 6 * GIB;
    const commands: WorkerWorkspaceCommand[] = [];
    const harness = createHarness(async (command) => {
      commands.push(command);
      return result(availableBytes, 10 * GIB);
    });
    const events: Array<{ reason: string; sessionKey: string }> = [];
    const unsubscribe = onSessionLifecycleEvent((event) => events.push(event));
    try {
      await harness.monitor.sweep();
      expect(harness.monitor.read(harness.placement)).toEqual({
        status: "ok",
        availableBytes,
        totalBytes: 10 * GIB,
        observedAtMs: 1_000,
      });
      expect(commands[0]).toMatchObject({
        transportRetry: "idempotent",
        timeoutMs: 30_000,
      });
      expect(commands[0]?.argv.at(-1)).toBe("/workspace/session-disk");
      expect(commands[0]?.argv[2]).toContain("statfs");
      expect(commands[0]?.argv[2]).toContain("bavail");
      expect(harness.startTunnel).toHaveBeenCalledWith({
        environmentId: "environment-disk",
        ownerEpoch: 7,
      });
      expect(harness.monitor.version()).toBe(1);
      expect(events).toEqual([]);

      availableBytes = 400 * MIB;
      await harness.monitor.sweep();
      expect(harness.monitor.read(harness.placement)?.status).toBe("warning");
      expect(events).toEqual([
        { reason: "worker-disk-space", sessionKey: "agent:main:session-disk", agentId: "main" },
      ]);
      expect(harness.monitor.version()).toBe(2);

      availableBytes = 300 * MIB;
      await harness.monitor.sweep();
      expect(harness.monitor.read(harness.placement)?.availableBytes).toBe(300 * MIB);
      expect(events).toHaveLength(1);
      expect(harness.monitor.version()).toBe(3);

      await harness.monitor.sweep();
      expect(harness.monitor.version()).toBe(3);

      availableBytes = 6 * GIB;
      await harness.monitor.sweep();
      expect(harness.monitor.read(harness.placement)?.status).toBe("ok");
      expect(events).toHaveLength(2);
      expect(harness.monitor.version()).toBe(4);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    { availableBytes: 99 * MIB, totalBytes: 10 * GIB, status: "critical" },
    { availableBytes: 512 * MIB, totalBytes: 25 * GIB, status: "critical" },
    { availableBytes: 499 * MIB, totalBytes: 10 * GIB, status: "warning" },
    { availableBytes: 100 * MIB, totalBytes: GIB, status: "warning" },
    { availableBytes: 4 * GIB, totalBytes: 80 * GIB, status: "warning" },
    { availableBytes: 500 * MIB, totalBytes: GIB, status: "ok" },
    { availableBytes: 6 * GIB, totalBytes: 100 * GIB, status: "ok" },
  ] as const)("classifies $status pressure at $availableBytes available", async (sample) => {
    const harness = createHarness(async () => result(sample.availableBytes, sample.totalBytes));

    await harness.monitor.sweep();

    expect(harness.monitor.read(harness.placement)?.status).toBe(sample.status);
  });

  it("rejects a sample when the placement owner changes while the probe is awaited", async () => {
    const commandStarted = createDeferredCore();
    const releaseCommand = createDeferredCore<SpawnResult>();
    const harness = createHarness(async () => {
      commandStarted.resolve();
      return await releaseCommand.promise;
    });

    const sweep = harness.monitor.sweep();
    await commandStarted.promise;
    harness.setPlacement(activePlacement({ generation: 4, activeOwnerEpoch: 8 }));
    releaseCommand.resolve(result(50 * MIB, 10 * GIB));
    await sweep;

    expect(harness.monitor.read(harness.placement)).toBeUndefined();
    expect(harness.monitor.version()).toBe(0);
  });

  it("advances the projection fence when an observation loses its active placement", async () => {
    const harness = createHarness(async () => result(6 * GIB, 10 * GIB));

    await harness.monitor.sweep();
    expect(harness.monitor.version()).toBe(1);

    harness.setPlacement({ ...activePlacement(), state: "draining" });
    await harness.monitor.sweep();

    expect(harness.monitor.read(harness.placement)).toBeUndefined();
    expect(harness.monitor.version()).toBe(2);

    await harness.monitor.sweep();
    expect(harness.monitor.version()).toBe(2);
  });

  it("probes and warns once per stale worker build binding", async () => {
    const harness = createHarness(async () => result(6 * GIB, 10 * GIB));
    harness.startTunnel.mockRejectedValue(new StaleWorkerBuildError());

    await harness.monitor.sweep();
    await harness.monitor.sweep();
    await harness.monitor.sweep();

    expect(harness.warn).toHaveBeenCalledTimes(1);
    expect(harness.startTunnel).toHaveBeenCalledTimes(1);

    harness.setPlacement(activePlacement({ generation: 4, activeOwnerEpoch: 8 }));
    await harness.monitor.sweep();
    await harness.monitor.sweep();

    expect(harness.warn).toHaveBeenCalledTimes(2);
    expect(harness.startTunnel).toHaveBeenCalledTimes(2);
  });

  it("keeps the last exact-binding sample and warns on every failed advisory probe", async () => {
    let fail = false;
    const harness = createHarness(async () =>
      fail
        ? {
            ...result(0, 0),
            code: 1,
          }
        : result(400 * MIB, 10 * GIB),
    );
    await harness.monitor.sweep();
    fail = true;

    await harness.monitor.sweep();
    await harness.monitor.sweep();

    expect(harness.monitor.read(harness.placement)?.status).toBe("warning");
    expect(harness.monitor.version()).toBe(1);
    expect(harness.warn).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("Worker disk-space probe command failed"),
    );
  });
});
