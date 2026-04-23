import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronJobCreate, CronStoreFile } from "../types.js";
import * as ops from "./ops.js";
import { createCronServiceState, type CronServiceState } from "./state.js";

function createTestState(storePath: string): CronServiceState {
  return createCronServiceState({
    cronEnabled: true,
    storePath,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function makeJob(overrides: Partial<CronJobCreate> & { missionId?: string }): CronJobCreate {
  return {
    name: overrides.name ?? "test-job",
    missionId: overrides.missionId,
    schedule: overrides.schedule ?? { kind: "every", everyMs: 60_000 },
    sessionTarget: overrides.sessionTarget ?? "isolated",
    wakeMode: overrides.wakeMode ?? "now",
    payload: overrides.payload ?? { kind: "agentTurn", message: "test" },
    enabled: overrides.enabled ?? true,
  };
}

describe("cron-to-mission ops", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cron-mission-ops-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStorePath() {
    return path.join(fixtureRoot, `case-${caseId++}`, "cron", "jobs.json");
  }

  it("persists missionId when adding a cron job", async () => {
    const state = createTestState(makeStorePath());
    await ops.start(state);

    const job = await ops.add(state, makeJob({ missionId: "mission-abc-123" }));
    expect(job.missionId).toBe("mission-abc-123");

    const all = await ops.list(state, { includeDisabled: true });
    const found = all.find((j) => j.id === job.id);
    expect(found?.missionId).toBe("mission-abc-123");

    ops.stop(state);
  });

  it("ad-hoc cron jobs have no missionId", async () => {
    const state = createTestState(makeStorePath());
    await ops.start(state);

    const job = await ops.add(
      state,
      makeJob({
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      }),
    );
    expect(job.missionId).toBeUndefined();

    ops.stop(state);
  });

  it("filters cron.listPage by missionId", async () => {
    const state = createTestState(makeStorePath());
    await ops.start(state);

    await ops.add(state, makeJob({ name: "A-1", missionId: "mission-A" }));
    await ops.add(state, makeJob({ name: "A-2", missionId: "mission-A" }));
    await ops.add(state, makeJob({ name: "B-1", missionId: "mission-B" }));
    await ops.add(
      state,
      makeJob({
        name: "adhoc",
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
      }),
    );

    const pageA = await ops.listPage(state, { missionId: "mission-A" });
    expect(pageA.total).toBe(2);
    expect(pageA.jobs.every((j) => j.missionId === "mission-A")).toBe(true);

    const pageB = await ops.listPage(state, { missionId: "mission-B" });
    expect(pageB.total).toBe(1);

    const pageAll = await ops.listPage(state);
    expect(pageAll.total).toBe(4);

    ops.stop(state);
  });

  it("removeByMission cancels all jobs for a mission", async () => {
    const state = createTestState(makeStorePath());
    await ops.start(state);

    await ops.add(state, makeJob({ name: "C-1", missionId: "mission-C" }));
    await ops.add(state, makeJob({ name: "C-2", missionId: "mission-C" }));
    await ops.add(state, makeJob({ name: "D-1", missionId: "mission-D" }));

    const result = await ops.removeByMission(state, "mission-C");
    expect(result).toEqual({ ok: true, removed: 2 });

    const remaining = await ops.list(state, { includeDisabled: true });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.missionId).toBe("mission-D");

    ops.stop(state);
  });

  it("removeByMission is idempotent — returns 0 when no matching jobs", async () => {
    const state = createTestState(makeStorePath());
    await ops.start(state);

    await ops.add(state, makeJob({ name: "E-1", missionId: "mission-E" }));

    const result = await ops.removeByMission(state, "mission-nonexistent");
    expect(result).toEqual({ ok: true, removed: 0 });

    const remaining = await ops.list(state, { includeDisabled: true });
    expect(remaining).toHaveLength(1);

    ops.stop(state);
  });

  it("missionId survives service restart (persistence)", async () => {
    const storePath = makeStorePath();

    // Session 1: add job with missionId
    const state1 = createTestState(storePath);
    await ops.start(state1);
    const job = await ops.add(
      state1,
      makeJob({ name: "persist-test", missionId: "mission-persist" }),
    );
    ops.stop(state1);

    // Session 2: read from same store
    const state2 = createTestState(storePath);
    await ops.start(state2);
    const reloadedJobs = await ops.list(state2, { includeDisabled: true });
    const found = reloadedJobs.find((j) => j.id === job.id);
    expect(found?.missionId).toBe("mission-persist");
    ops.stop(state2);
  });
});
