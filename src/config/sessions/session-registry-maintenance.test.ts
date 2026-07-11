// Session registry maintenance tests cover the task-owned cron-run pruning seam.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { runSessionRegistryMaintenanceForStore } from "./session-registry-maintenance.js";
import { loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureSuite = createFixtureSuite("openclaw-session-registry-maintenance-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function sessionEntry(sessionId: string, updatedAt: number): SessionEntry {
  return { sessionId, updatedAt };
}

async function createStore(entries: Record<string, SessionEntry>): Promise<string> {
  const dir = await fixtureSuite.createCaseDir("store");
  const storePath = path.join(dir, "sessions.json");
  await fs.mkdir(dir, { recursive: true });
  await saveSessionStore(storePath, entries, { skipMaintenance: true });
  return storePath;
}

describe("runSessionRegistryMaintenanceForStore", () => {
  it("summarizes a missing store without creating it", async () => {
    const dir = await fixtureSuite.createCaseDir("missing-store");
    const storePath = path.join(dir, "sessions.json");

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 0,
      afterCount: 0,
      preservedRunning: 0,
      pruned: 0,
    });
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews stale cron-run pruning without mutating the store", async () => {
    const now = Date.now();
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("old-run", now - 8 * DAY_MS),
      "agent:main:cron:done-job:run:recent-run": sessionEntry("recent-run", now),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: false,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 2,
      afterCount: 1,
      preservedRunning: 0,
      pruned: 1,
    });
    expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(
      "agent:main:cron:done-job:run:old-run",
    );
  });

  it("applies one store-sized pruning transaction and preserves running cron rows", async () => {
    const now = Date.now();
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("done-run", now - 8 * DAY_MS),
      "agent:main:cron:running-job:run:old-run": sessionEntry("running-run", now - 8 * DAY_MS),
      "agent:main:cron:done-job:run:recent-run": sessionEntry("recent-run", now),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(["running-job"]),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 3,
      afterCount: 2,
      preservedRunning: 1,
      pruned: 1,
    });
    const updated = loadSessionStore(storePath, { skipCache: true });
    expect(updated["agent:main:cron:done-job:run:old-run"]).toBeUndefined();
    expect(updated).toHaveProperty("agent:main:cron:running-job:run:old-run");
    expect(updated).toHaveProperty("agent:main:cron:done-job:run:recent-run");
  });

  it("skips generic session maintenance while applying task registry pruning", async () => {
    const now = Date.now();
    const oldOrdinaryKey = "agent:main:subagent:old-worker";
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("done-run", now - 8 * DAY_MS),
      [oldOrdinaryKey]: sessionEntry("old-worker", now - 40 * DAY_MS),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result.pruned).toBe(1);
    const updated = loadSessionStore(storePath, { skipCache: true });
    expect(updated["agent:main:cron:done-job:run:old-run"]).toBeUndefined();
    expect(updated).toHaveProperty(oldOrdinaryKey);
  });

  it("preserves active cron rows until their admission releases", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:active-run";
    const sessionId = "active-run";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });

    try {
      const activeResult = await runSessionRegistryMaintenanceForStore({
        apply: true,
        retentionMs: 7 * DAY_MS,
        runningCronJobIds: new Set(),
        storePath,
      });
      expect(activeResult.pruned).toBe(0);
      expect(loadSessionStore(storePath, { skipCache: true })).toHaveProperty(sessionKey);
    } finally {
      admission.release();
    }

    const releasedResult = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });
    expect(releasedResult.pruned).toBe(1);
    expect(loadSessionStore(storePath, { skipCache: true })[sessionKey]).toBeUndefined();
  });
});
