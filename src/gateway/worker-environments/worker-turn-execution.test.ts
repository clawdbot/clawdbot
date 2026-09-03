import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_LAUNCH_V2_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

describe("worker turn execution", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it("fences a stale worker receipt while a current receipt proceeds to execution", async () => {
    seedActivePlacement();
    const oldEnvironment = attachedEnvironment();
    const currentReceipt = oldEnvironment.bootstrapReceipt;
    oldEnvironment.bootstrapReceipt = {
      ...currentReceipt!,
      protocolFeatures: [WORKER_LAUNCH_V2_PROTOCOL_FEATURE],
    };
    const passedFence = new Error("current worker receipt passed the turn-execution fence");
    const environments: WorkerTurnEnvironmentService = {
      ...unusedEnvironments(),
      get: vi.fn(() => oldEnvironment),
      acquireTurnCredential: vi.fn(async () => {
        throw passedFence;
      }),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));

    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-old-worker",
        },
        turn("run-old-worker"),
        runLocal,
      ),
    ).rejects.toThrow(
      "Active worker bundle lacks the current launch capability; reprovision the worker before launch",
    );

    expect(runLocal).not.toHaveBeenCalled();
    expect(environments.acquireTurnCredential).not.toHaveBeenCalled();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });

    oldEnvironment.bootstrapReceipt = currentReceipt;
    await expect(
      provider.executeTurn(
        {
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          agentId: "main",
          runId: "run-current-worker",
        },
        turn("run-current-worker"),
        runLocal,
      ),
    ).rejects.toBe(passedFence);

    expect(environments.acquireTurnCredential).toHaveBeenCalledOnce();
    expect(environments.startTunnel).not.toHaveBeenCalled();
    expect(placements.get(SESSION_ID)).toMatchObject({ state: "active", turnClaim: null });
  });
});
