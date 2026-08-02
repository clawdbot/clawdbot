// Memory Core tests cover durable dreaming-cycle lifecycle ownership.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDreamingCycleController } from "./dreaming-cycle-controller.js";
import {
  listDreamingCyclePhaseStates,
  readDreamingCyclePhaseState,
  writeDreamingCyclePhaseState,
} from "./dreaming-cycle-state.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "./test-helpers.js";

const tempDirs: string[] = [];

beforeAll(async () => {
  await configureMemoryCoreDreamingStateForTests();
});

afterAll(() => {
  resetMemoryCoreDreamingStateForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-cycle-test-"));
  tempDirs.push(workspace);
  return workspace;
}

const withLease: PluginStateLeaseRunner = async (_options, run) => {
  const controller = new AbortController();
  return await run({ signal: controller.signal, assertOwned: () => undefined });
};

describe("dreaming cycle controller", () => {
  it("uses stable cycle and phase ids and persists planned phases", async () => {
    const workspaceDir = await createWorkspace();
    const controller = createDreamingCycleController({ withLease, ownerId: "gateway-a" });
    const input = { workspaceDir, cycleKey: "2026-08-02", phase: "rem-1", notBefore: 100 };

    const first = await controller.planPhase({ ...input, nowMs: 10 });
    const second = await controller.planPhase({ ...input, nowMs: 20 });

    expect(second).toStrictEqual(first);
    expect(first.status).toBe("planned");
    expect(first.cycleId).toHaveLength(64);
    expect(first.phaseId).toHaveLength(64);
    await expect(listDreamingCyclePhaseStates(workspaceDir)).resolves.toStrictEqual([first]);
  });

  it("checkpoints model wait and resumes the same phase after restart", async () => {
    const workspaceDir = await createWorkspace();
    let nowMs = 1_000;
    const firstController = createDreamingCycleController({
      withLease,
      ownerId: "gateway-a",
      now: () => nowMs,
    });
    const planned = await firstController.planPhase({
      workspaceDir,
      cycleKey: "night-1",
      phase: "light",
      notBefore: nowMs,
    });

    const waiting = await firstController.runPhase({
      workspaceDir,
      cycleId: planned.cycleId,
      phaseId: planned.phaseId,
      execute: async () => ({ status: "model_wait", notBefore: 2_000, error: "loading" }),
    });
    expect(waiting).toMatchObject({ status: "model_wait", attempts: 1, notBefore: 2_000 });

    nowMs = 2_000;
    const restartedController = createDreamingCycleController({
      withLease,
      ownerId: "gateway-b",
      now: () => nowMs,
    });
    const execute = vi.fn(async () => ({ status: "completed" as const }));
    const completed = await restartedController.runPhase({
      workspaceDir,
      cycleId: planned.cycleId,
      phaseId: planned.phaseId,
      execute,
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ status: "completed", attempts: 2 });
    expect(completed).not.toHaveProperty("leaseOwner");
  });

  it("reclaims stale prepared and model-wait phases after a restart", async () => {
    const workspaceDir = await createWorkspace();
    const controller = createDreamingCycleController({
      withLease,
      ownerId: "gateway-b",
      now: () => 5_000,
    });
    const prepared = await controller.planPhase({
      workspaceDir,
      cycleKey: "night-2",
      phase: "deep",
      notBefore: 1_000,
      nowMs: 1_000,
    });
    await writeDreamingCyclePhaseState({
      ...prepared,
      status: "prepared",
      attempts: 1,
      leaseOwner: "dead-gateway",
      leaseExpiresAt: 4_000,
    });

    const recovered = await controller.recoverWorkspace(workspaceDir);

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ status: "retry_wait", notBefore: 5_000 });
    expect(recovered[0]).not.toHaveProperty("leaseOwner");
  });

  it("does not execute before notBefore or rerun terminal phases", async () => {
    const workspaceDir = await createWorkspace();
    const controller = createDreamingCycleController({
      withLease,
      ownerId: "gateway-a",
      now: () => 100,
    });
    const planned = await controller.planPhase({
      workspaceDir,
      cycleKey: "night-3",
      phase: "rem",
      notBefore: 200,
    });
    const execute = vi.fn(async () => ({ status: "completed" as const }));

    await controller.runPhase({ ...planned, execute });
    expect(execute).not.toHaveBeenCalled();

    await writeDreamingCyclePhaseState({ ...planned, status: "terminal_failed" });
    await controller.runPhase({ ...planned, execute });
    expect(execute).not.toHaveBeenCalled();
    await expect(
      readDreamingCyclePhaseState({
        workspaceDir,
        cycleId: planned.cycleId,
        phaseId: planned.phaseId,
      }),
    ).resolves.toMatchObject({ status: "terminal_failed" });
  });
});
