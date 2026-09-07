import { afterEach, describe, expect, it, vi } from "vitest";
import { FLEET_ATTEMPT_LABEL } from "./cell-profile.js";
import type { FleetContainerRuntime } from "./containers.runtime.js";
import type { FleetCellRecord } from "./registry.js";
import { verifyReplacementHealthy } from "./service-support.runtime.js";

const attemptId = "11111111111111111111111111111111";
const record: FleetCellRecord = {
  tenantId: "acme",
  createdAtMs: 0,
  image: "openclaw:test",
  runtime: "docker",
  hostPort: 19100,
  containerName: "openclaw-acme",
  dataDir: "/tmp/openclaw-acme",
};

function runningContainers(onInspect?: () => void): FleetContainerRuntime {
  return {
    inspect: vi.fn(async () => {
      onInspect?.();
      return {
        kind: "ok" as const,
        containerId: "container-id",
        state: "running",
        running: true,
        labels: { [FLEET_ATTEMPT_LABEL]: attemptId },
        environment: {},
        imageId: "sha256:test",
        memory: "1073741824",
        cpus: "1",
        pidsLimit: 128,
        storageOpt: {},
        capDrop: ["ALL"],
        effectiveCaps: undefined,
        securityOpt: ["no-new-privileges"],
        init: true,
        restartPolicy: "unless-stopped",
        portBindings: [],
      };
    }),
  } as unknown as FleetContainerRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("verifyReplacementHealthy", () => {
  it("clamps polling to the remaining verification timeout", async () => {
    const sleeps: number[] = [];
    let now = 0;
    let inspections = 0;
    const containers = runningContainers(() => {
      inspections += 1;
      now = 500;
    });

    await expect(
      verifyReplacementHealthy({
        containers,
        record,
        attemptId,
        fetchImpl: vi.fn(async () => new Response(null, { status: 503 })),
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
        checkpoint: vi.fn(),
        timeoutMs: 1_000,
        pollMs: 2_000,
        context: "upgrade",
      }),
    ).rejects.toThrow("Replacement cell container did not become healthy after upgrade.");

    expect(sleeps).toEqual([500]);
    expect(inspections).toBe(1);
  });

  it("clamps a stalled health probe to the remaining verification timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("probe aborted")), {
          once: true,
        });
      });
    });
    const verification = verifyReplacementHealthy({
      containers: runningContainers(() => vi.setSystemTime(500)),
      record,
      attemptId,
      fetchImpl,
      now: () => Date.now(),
      sleep: async () => {},
      checkpoint: vi.fn(),
      timeoutMs: 1_000,
      pollMs: 2_000,
      context: "restore",
    });
    const rejection = expect(verification).rejects.toThrow(
      "Replacement cell container did not become healthy after restore.",
    );

    for (let attempt = 0; attempt < 20 && setTimeoutSpy.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });
});
